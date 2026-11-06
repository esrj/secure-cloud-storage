#!/usr/bin/env node
/**
 * Grant or revoke the admin role from the terminal.
 *
 *   npm run set-admin -- <email | user-id | name>
 *   npm run set-admin -- --remove <email | user-id | name>
 *   npm run set-admin -- --list
 *
 * The target is matched exactly (never by prefix) against the user id, then
 * the email, then the display name — granting privileges on a fuzzy match
 * would be a footgun. Name and email are stored AES-encrypted, so matching is
 * done on the decrypted rows rather than in SQL.
 *
 * Writing the role straight to the database takes effect for the next login
 * and survives restarts: the startup sweep driven by `admin.emails` only ever
 * promotes, it never demotes.
 */
import ConfigManager from '../src/ConfigManager.js'
import {
  getAllUsers,
  pool,
  updateUserRoleById,
  userRoleType,
  userStatusType
} from '../src/StorageDatabase.js'

const USAGE = `用法：
  npm run set-admin -- <email | 使用者ID | 名稱>            設為管理員
  npm run set-admin -- --remove <email | 使用者ID | 名稱>   取消管理員
  npm run set-admin -- --list                              列出所有使用者與角色`

/** Exact match on id, then email, then name (all case-insensitive). */
function findMatches(users, needle) {
  const n = needle.trim().toLowerCase()
  const byId = users.filter((u) => u.id.toLowerCase() === n)
  if (byId.length > 0) return byId
  const byEmail = users.filter((u) => (u.email ?? '').toLowerCase() === n)
  if (byEmail.length > 0) return byEmail
  return users.filter((u) => (u.name ?? '').toLowerCase() === n)
}

/** Display width: CJK/full-width characters occupy two terminal columns. */
function width(str) {
  let n = 0
  for (const ch of str) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}

function printUsers(users) {
  const pad = (s, n) => {
    const text = String(s ?? '')
    return text + ' '.repeat(Math.max(1, n - width(text)))
  }
  console.log(`\n${pad('角色', 7)}${pad('狀態', 10)}${pad('使用者ID', 38)}${pad('名稱', 14)}Email`)
  console.log('-'.repeat(100))
  for (const u of users) {
    console.log(
      `${pad(u.role, 7)}${pad(u.status, 10)}${pad(u.id, 38)}${pad(u.name, 14)}${u.email ?? ''}`
    )
  }
  console.log('')
}

async function main(argv) {
  const args = argv.filter((a) => a !== '')
  const wantsList = args.includes('--list') || args.includes('-l')
  const wantsRemove = args.includes('--remove') || args.includes('-r')
  const targets = args.filter((a) => !a.startsWith('-'))

  const users = await getAllUsers()
  users.sort((a, b) => a.role.localeCompare(b.role) || String(a.name).localeCompare(String(b.name)))

  if (wantsList) {
    printUsers(users)
    return 0
  }

  if (targets.length !== 1) {
    console.error(USAGE)
    if (targets.length > 1) console.error('\n一次只能指定一位使用者。')
    return 1
  }

  const needle = targets[0]
  const matches = findMatches(users, needle)

  if (matches.length === 0) {
    console.error(`找不到使用者：${needle}`)
    console.error('可用 --list 查看所有使用者。')
    return 1
  }
  if (matches.length > 1) {
    console.error(`「${needle}」對應到 ${matches.length} 位使用者，請改用使用者ID：`)
    printUsers(matches)
    return 1
  }

  const user = matches[0]
  const nextRole = wantsRemove ? userRoleType.user : userRoleType.admin
  const label = `${user.name ?? '(未知)'} <${user.email ?? '無 email'}>`

  if (user.role === nextRole) {
    console.log(`${label} 已經是「${nextRole}」，未變更。`)
    return 0
  }

  await updateUserRoleById(user.id, nextRole)
  console.log(`${label}\n  ${user.role} → ${nextRole}（id: ${user.id}）`)

  if (user.status !== userStatusType.activate) {
    console.log(`  注意：此帳號目前狀態為「${user.status}」，無法登入。`)
  }

  // The startup sweep re-promotes everyone listed in config, so a demotion
  // that leaves the email in the list silently comes back on restart.
  const configured = (ConfigManager.admin.emails ?? []).map((e) => e.trim().toLowerCase())
  if (wantsRemove && user.email && configured.includes(user.email.toLowerCase())) {
    console.log('  警告：此 email 仍列在 config/local.yaml 的 admin.emails，')
    console.log('        Server 下次啟動會重新升為管理員，請一併從設定檔移除。')
  }

  console.log('  該使用者需重新登入才會套用新權限。')
  return 0
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
