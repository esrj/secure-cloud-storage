/**
 * Where the smart-classify model is looked up. Pure functions: platform,
 * environment, paths and file checks are all passed in, so both search orders
 * can be tested on any OS.
 *
 * Unmanaged — macOS, Linux, Windows dev mode, and Windows with the model
 * manager switched off. This order is unchanged since 2026-10:
 *   1. LLAMA_MODEL_PATH
 *   2. <appPath>/resources/models/<file>        (dev)
 *   3. <resourcesPath>/models/<file>            (installed)
 *
 * Managed — the Windows installer, which ships without the model:
 *   1. LLAMA_MODEL_PATH (an invalid path is reported, never skipped)
 *   2. the verified model the user downloaded or imported (managed dir)
 *   3. <resourcesPath>/models/<file>            (older manual deployments)
 */
import nodePath from 'node:path'

/**
 * The Windows model manager runs only in the Windows installer.
 * SCS_MODEL_MANAGER=0 switches it off (falls back to the unmanaged order);
 * SCS_MODEL_MANAGER=1 switches it on in Windows dev mode for testing.
 * @param {{ platform: string, isPackaged: boolean, env: Record<string, string | undefined> }} ctx
 */
export function isModelManagerEnabled({ platform, isPackaged, env }) {
  if (platform !== 'win32') return false
  const flag = String(env.SCS_MODEL_MANAGER ?? '').trim()
  if (flag === '0') return false
  return isPackaged || flag === '1'
}

/**
 * Shared by every CLIENT_PROFILE (profile.js only moves userData, sessions and
 * logs): the model is public, ~5 GB, and must not be downloaded once per profile.
 * Local (not Roaming) AppData, so roaming profiles never sync it.
 * @param {{ env: Record<string, string | undefined>, homedir: string, appName: string, path?: typeof nodePath }} ctx
 */
export function getManagedModelDir({ env, homedir, appName, path = nodePath }) {
  const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local')
  return path.join(localAppData, appName, 'models')
}

/**
 * @param {{
 *   filename: string,
 *   env: Record<string, string | undefined>,
 *   isDev: boolean,
 *   appPath: string,
 *   resourcesPath: string,
 *   managed?: null | { dir: string, isReady: (p: string) => boolean, exists: (p: string) => boolean },
 *   path?: typeof nodePath
 * }} ctx
 * @returns {{ path: string, source: 'env' | 'dev' | 'managed' | 'bundled' }}
 */
export function resolveModelPath({
  filename,
  env,
  isDev,
  appPath,
  resourcesPath,
  managed = null,
  path = nodePath
}) {
  if (env.LLAMA_MODEL_PATH) return { path: env.LLAMA_MODEL_PATH, source: 'env' }

  if (!managed) {
    if (isDev) return { path: path.join(appPath, 'resources', 'models', filename), source: 'dev' }
    return { path: path.join(resourcesPath, 'models', filename), source: 'bundled' }
  }

  const managedPath = path.join(managed.dir, filename)
  if (managed.isReady(managedPath)) return { path: managedPath, source: 'managed' }
  const bundledPath = path.join(resourcesPath, 'models', filename)
  if (managed.exists(bundledPath)) return { path: bundledPath, source: 'bundled' }
  // Nothing usable: point at the managed location; the manager reports why.
  return { path: managedPath, source: 'managed' }
}
