#!/usr/bin/env node
/**
 * Maintenance command for the smart-search audit log.
 *
 *   npm run purge-agent-log -- --list                 show every conversation
 *   npm run purge-agent-log -- --e2e                  preview removal of e2e test turns
 *   npm run purge-agent-log -- --e2e --yes            actually remove them
 *   npm run purge-agent-log -- <conversation-id> --yes  remove one conversation
 *
 * Deliberately a LOCAL command and not a socket event: the audit log is
 * append-only over the wire, so neither a user nor an admin can erase their
 * own history remotely. Nothing is deleted without --yes.
 *
 * --e2e deletes the fake turns written by scripts/admin_e2e.mjs at message
 * level, then drops conversations left with no messages. A conversation that
 * also holds real turns therefore keeps them.
 *
 * SQL lives here rather than in StorageDatabase.js so the running server never
 * gains a delete path into the audit tables.
 */
import { pool } from '../src/StorageDatabase.js'

const E2E_PREFIX = 'e2e 測試'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const USAGE = `用法：
  npm run purge-agent-log -- --list                       列出所有對話
  npm run purge-agent-log -- --e2e [--yes]                清除 e2e 測試訊息
  npm run purge-agent-log -- <conversation-id> [--yes]    刪除指定對話
不加 --yes 時只會預覽，不會真的刪除。`

async function listConversations() {
  const { rows } = await pool.query(
    `SELECT c.id, c.userid, c.provider,
            COUNT(m.*)::int AS msgs,
            COUNT(*) FILTER (WHERE m.content LIKE $1)::int AS e2e_msgs,
            MIN(m.timestamp) AS first_at,
            MAX(m.timestamp) AS last_at
     FROM agent_conversations c
     LEFT JOIN agent_messages m ON m.conversationid = c.id
     GROUP BY c.id, c.userid, c.provider
     ORDER BY MIN(m.timestamp) NULLS FIRST`,
    [`${E2E_PREFIX}%`]
  )
  return rows
}

function printConversations(rows) {
  if (rows.length === 0) {
    console.log('沒有任何對話紀錄。')
    return
  }
  console.log('\n對話ID                                訊息  e2e  起訖')
  console.log('-'.repeat(78))
  for (const r of rows) {
    // 'sv-SE' renders YYYY-MM-DD in the machine's local timezone, matching
    // the timestamps an admin sees in the exported JSON.
    const day = (d) => d.toLocaleDateString('sv-SE')
    const span = r.first_at ? `${day(r.first_at)} ~ ${day(r.last_at)}` : '(無訊息)'
    console.log(
      `${r.id}  ${String(r.msgs).padStart(4)}  ${String(r.e2e_msgs).padStart(3)}  ${span}`
    )
  }
  console.log('')
}

async function purgeE2e(commit) {
  const { rows: victims } = await pool.query(
    `SELECT conversationid, COUNT(*)::int AS n
     FROM agent_messages WHERE content LIKE $1
     GROUP BY conversationid`,
    [`${E2E_PREFIX}%`]
  )
  const total = victims.reduce((sum, v) => sum + v.n, 0)

  if (total === 0) {
    console.log('沒有找到 e2e 測試訊息。')
    return 0
  }
  console.log(`找到 ${total} 則 e2e 測試訊息，分布於 ${victims.length} 段對話：`)
  for (const v of victims) console.log(`  ${v.conversationid}  ${v.n} 則`)

  if (!commit) {
    console.log('\n這是預覽。加上 --yes 才會真的刪除。')
    return 0
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const del = await client.query('DELETE FROM agent_messages WHERE content LIKE $1', [
      `${E2E_PREFIX}%`
    ])
    // Conversations that held nothing but test turns are now empty shells.
    const empty = await client.query(
      `DELETE FROM agent_conversations c
       WHERE NOT EXISTS (SELECT 1 FROM agent_messages m WHERE m.conversationid = c.id)`
    )
    // started_at lives on the conversation row and does not move when its
    // first message is deleted, so realign it with the earliest turn that
    // actually survives. Same for last_at.
    const fixed = await client.query(
      `UPDATE agent_conversations c
       SET started_at = b.first_at, last_at = b.last_at
       FROM (SELECT conversationid, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at
             FROM agent_messages GROUP BY conversationid) b
       WHERE b.conversationid = c.id
         AND (c.started_at <> b.first_at OR c.last_at <> b.last_at)`
    )
    await client.query('COMMIT')
    console.log(
      `\n已刪除 ${del.rowCount} 則訊息，移除 ${empty.rowCount} 段已無內容的對話，` +
        `校正 ${fixed.rowCount} 段對話的起訖時間。`
    )
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  return 0
}

async function purgeOne(id, commit) {
  const { rows } = await pool.query(
    `SELECT c.id, COUNT(m.*)::int AS msgs
     FROM agent_conversations c LEFT JOIN agent_messages m ON m.conversationid = c.id
     WHERE c.id = $1 GROUP BY c.id`,
    [id]
  )
  if (rows.length === 0) {
    console.error(`找不到對話：${id}`)
    return 1
  }
  console.log(`對話 ${id}（${rows[0].msgs} 則訊息）`)
  if (!commit) {
    console.log('這是預覽。加上 --yes 才會真的刪除。')
    return 0
  }
  // agent_messages has ON DELETE CASCADE, so the messages go with it.
  await pool.query('DELETE FROM agent_conversations WHERE id = $1', [id])
  console.log('已刪除。')
  return 0
}

async function main(argv) {
  const commit = argv.includes('--yes') || argv.includes('-y')
  const ids = argv.filter((a) => !a.startsWith('-'))

  if (argv.includes('--list') || argv.includes('-l')) {
    printConversations(await listConversations())
    return 0
  }
  if (argv.includes('--e2e')) return await purgeE2e(commit)
  if (ids.length === 1 && UUID_RE.test(ids[0])) return await purgeOne(ids[0], commit)

  console.error(USAGE)
  return 1
}

let code = 1
try {
  code = await main(process.argv.slice(2))
} catch (e) {
  console.error(`執行失敗：${e.message}`)
} finally {
  await pool.end().catch(() => {})
}
process.exit(code)
