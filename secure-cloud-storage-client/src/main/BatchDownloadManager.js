/**
 * BatchDownloadManager
 * ─────────────────────────────────────────────────────────────────────────
 * Drives sequential batch downloads in the main process.
 *
 * - One IPC entry point (`download-batch-with-options` in main/index.js) calls
 *   `start(opts)` which returns a `batchId` synchronously and kicks off the
 *   work via `setImmediate`. The renderer subscribes to `batch-download-progress`
 *   events for live updates.
 * - For each file we ask FileManager for the verification meta (server +
 *   blockchain), then pick the appropriate write helper (original vs watermark).
 * - Filename collisions in the destination directory are resolved by appending
 *   `(2)`, `(3)`, … before the extension.
 * - The cancel flag is checked between files; the currently running file is
 *   allowed to finish (interrupting the stream half-way would leave a partial
 *   file on disk, and v1 prefers correctness over speed of cancellation).
 *
 * Concurrency is fixed at 1 by design — both blockchain verification and PDF
 * watermark application are CPU-bound enough that running them in parallel
 * has no real benefit and amplifies user-visible jank.
 */
import { extname, basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { logger } from './Logger'
import GlobalValueManager from './GlobalValueManager'
import { isWatermarkSupported } from './WatermarkProcessor'

// Concurrency note: the inner `_run` loop is intentionally sequential. Both
// blockchain verification and PDF watermark application are CPU-bound enough
// that running multiple files in parallel offers no real benefit and worsens
// UI jank. Bumping this would also require a concurrency pool here.

class BatchDownloadManager {
  /** @param {import('./FileManager').default} fileManager */
  constructor(fileManager) {
    this.fileManager = fileManager
    /** @type {Map<string, BatchState>} */
    this._batches = new Map()
  }

  /**
   * Start a new batch. Returns the batch id immediately; work runs async and
   * progress is reported through `batch-download-progress` IPC events.
   *
   * @param {{
   *   files: Array<{ fileId: string, name: string, mime?: string, watermarkSupported?: boolean }>,
   *   destDir: string,
   *   mode: 'original'|'watermark',
   *   watermarkOptions: object|null
   * }} opts
   * @returns {string} batchId
   */
  start(opts) {
    const batchId = randomUUID()
    const files = Array.isArray(opts?.files) ? opts.files : []
    const state = {
      batchId,
      files,
      destDir: opts.destDir,
      mode: opts.mode === 'watermark' ? 'watermark' : 'original',
      watermarkOptions: opts.watermarkOptions || null,
      cancelled: false,
      startedAt: Date.now(),
      results: []
    }
    this._batches.set(batchId, state)
    logger.info(
      `[BatchDownload] start id=${batchId} count=${files.length} mode=${state.mode} dest=${state.destDir}`
    )
    setImmediate(() => this._run(state))
    return batchId
  }

  cancel(batchId) {
    const state = this._batches.get(batchId)
    if (!state) return
    state.cancelled = true
    logger.info(`[BatchDownload] cancel requested id=${batchId}`)
    this._emit({
      type: 'batch-cancelled',
      batchId
    })
  }

  // ─────────────────────────────────────────────────────────────
  // Internal
  // ─────────────────────────────────────────────────────────────

  async _run(state) {
    // Tell the renderer the full file list up-front so the progress card can
    // pre-render rows in pending state without waiting for each item-started.
    this._emit({
      type: 'batch-started',
      batchId: state.batchId,
      total: state.files.length,
      destDir: state.destDir,
      files: state.files.map((f) => ({ fileId: f.fileId, name: f.name }))
    })

    let ok = 0
    let fail = 0
    let skipped = 0

    for (let i = 0; i < state.files.length; i++) {
      if (state.cancelled) {
        // Mark all remaining files as skipped so the UI doesn't sit on
        // "pending" forever.
        for (let j = i; j < state.files.length; j++) {
          this._emit({
            type: 'item-done',
            batchId: state.batchId,
            index: j,
            status: 'skipped'
          })
          skipped++
        }
        break
      }

      const file = state.files[i]
      // Honour caller's hint, fall back to local check.
      const formatSupportsWatermark =
        file.watermarkSupported ?? isWatermarkSupported(file.name)

      this._emit({
        type: 'item-started',
        batchId: state.batchId,
        index: i,
        fileId: file.fileId,
        name: file.name,
        phase: 'running'
      })

      try {
        const meta = await this.fileManager.getDownloadMeta(file.fileId)

        // The server-side filename is authoritative (the renderer might be
        // showing a stale name), so use `meta.name` as the basis for output.
        const outputPath = this._resolveUniquePath(state.destDir, meta.name)

        if (formatSupportsWatermark) {
          // Always silently embed invisible watermark when the format supports it.
          // Visible watermark only when the user explicitly chose 'watermark' mode.
          const effective = {
            ...(state.watermarkOptions || {}),
            visible: state.mode === 'watermark',
            invisible: true
          }

          // Switch the UI label so the user knows we're past download phase.
          // Watermark step happens after the temp file is decrypted; emit a
          // soft progress hint so it's visible even when item-progress is
          // not used for byte counts in v1.
          this._emit({
            type: 'item-progress',
            batchId: state.batchId,
            index: i,
            phase: 'watermarking'
          })
          await this.fileManager.downloadWatermarkedToPath(
            file.fileId,
            meta,
            outputPath,
            effective
          )
        } else {
          // No watermark possible for this format — plain download.
          await this.fileManager.downloadOriginalToPath(meta, outputPath)
        }

        ok++
        this._emit({
          type: 'item-done',
          batchId: state.batchId,
          index: i,
          status: 'success',
          outPath: outputPath
        })
      } catch (err) {
        fail++
        const message = err?.message || String(err)
        logger.error(
          `[BatchDownload] item failed id=${state.batchId} idx=${i} fileId=${file.fileId}: ${message}`
        )
        this._emit({
          type: 'item-done',
          batchId: state.batchId,
          index: i,
          status: 'error',
          error: message
        })
      }
    }

    this._emit({
      type: 'batch-done',
      batchId: state.batchId,
      summary: { ok, fail, skipped, destDir: state.destDir }
    })

    // Keep finished states around briefly in case the renderer wants to
    // re-query them (e.g. after a window reload), then drop.
    setTimeout(() => this._batches.delete(state.batchId), 5 * 60 * 1000)
  }

  /**
   * Walk `destDir/name`, `destDir/name (2)`, `destDir/name (3)`, … until we
   * find a non-existent path. existsSync is best-effort against parallel
   * batches but is fine for v1's single-window assumption.
   */
  _resolveUniquePath(destDir, name) {
    const candidate = join(destDir, name)
    if (!existsSync(candidate)) return candidate

    const ext = extname(name)
    const stem = basename(name, ext)
    for (let n = 2; n < 10_000; n++) {
      const p = join(destDir, `${stem} (${n})${ext}`)
      if (!existsSync(p)) return p
    }
    // Astronomically unlikely fallback — append timestamp
    return join(destDir, `${stem}-${Date.now()}${ext}`)
  }

  _emit(payload) {
    try {
      GlobalValueManager.mainWindow?.webContents.send('batch-download-progress', payload)
    } catch (e) {
      logger.error(`[BatchDownload] emit failed: ${e?.message || e}`)
    }
  }
}

export default BatchDownloadManager
