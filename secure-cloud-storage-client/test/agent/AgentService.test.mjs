// Run: npm run test:agent
// (node --test --experimental-test-module-mocks test/agent/*.test.mjs)
//
// runAgentTurn with the LLM call injected: which tasks it sends to the server, and what the
// user is told when the LLM cannot be used.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

const src = (p) => new URL(`../../src/main/${p}`, import.meta.url).href
const quiet = { info() {}, warn() {}, error() {}, debug() {} }
mock.module(src('Logger.js'), { namedExports: { logger: quiet } })

const { runAgentTurn } = await import(src('services/AgentService.js'))
const { describeLlmError } = await import(src('services/llmErrors.js'))

const file = (name, tags, extra = {}) => ({
  fileId: name,
  name,
  ext: name.split('.').pop(),
  file_type: name.split('.').pop(),
  size: 1000,
  sizeLabel: '1 KB',
  date: '2026-01-01',
  upload_time: '2026-01-01 10:00',
  is_public: false,
  is_own: true,
  desc: '',
  tags,
  uploader_name: 'sam',
  folder_path: '/',
  location: '我的檔案/',
  ...extra
})
const files = [
  file('空軍演訓報告.pdf', ['空軍']),
  file('海軍補給.docx', ['海軍']),
  file('會議紀錄.txt', ['其他'])
]

/** An LLM stand-in that records every call and answers per task. */
function llm(answers) {
  const calls = []
  const generate = async (call) => {
    calls.push(call)
    const answer = answers[call.task]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, generate }
}

test('a normal turn: parse task, local filtering, summary task', async () => {
  const { calls, generate } = llm({
    parse: '```json\n{"intent":"找空軍文件","filters":{"tags.any":["空軍"]},"sort":null}\n```',
    summary: '找到一份空軍相關的檔案。'
  })
  const history = [
    { role: 'user', content: '之前的問題' },
    { role: 'assistant', content: '' }, // an empty reply must not be sent on
    { role: 'assistant', content: 'x'.repeat(5000) }
  ]
  const result = await runAgentTurn({ userMessage: '幫我找空軍的文件', history, files, generate })

  assert.equal(result.summary, '找到一份空軍相關的檔案。')
  assert.equal(result.llmError, '')
  assert.deepEqual(result.files.map((f) => f.name), ['空軍演訓報告.pdf'])
  assert.equal(result.files[0]._score, undefined)

  assert.deepEqual(calls.map((c) => c.task), ['parse', 'summary'])
  // The client sends a task name and messages, never a prompt or model settings.
  for (const call of calls) assert.deepEqual(Object.keys(call).sort(), ['messages', 'task'])
  const parseMessages = calls[0].messages
  assert.equal(parseMessages.length, 3)
  assert.deepEqual(parseMessages[0], { role: 'user', content: '之前的問題' })
  assert.equal(parseMessages[1].content.length, 2001) // clipped history
  assert.deepEqual(parseMessages.at(-1), { role: 'user', content: '幫我找空軍的文件' })
  assert.match(calls[1].messages[0].content, /空軍演訓報告\.pdf/)
  assert.doesNotMatch(calls[1].messages[0].content, /海軍補給/)
})

test('every request stays within what the server accepts', async () => {
  const { calls, generate } = llm({ parse: '{"intent":"all","filters":{}}', summary: 'ok' })
  const many = Array.from({ length: 30 }, (_, i) =>
    file(`${'很長的檔名'.repeat(50)}-${i}.pdf`, Array.from({ length: 40 }, (_, t) => `標籤${t}`), {
      location: '我的檔案/' + '資料夾/'.repeat(100)
    })
  )
  const history = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'y'.repeat(3000)
  }))
  await runAgentTurn({ userMessage: 'q'.repeat(3000), history, files: many, generate })
  for (const call of calls) {
    assert.ok(call.messages.length <= 8, `${call.task}: ${call.messages.length} messages`)
    for (const m of call.messages) {
      assert.ok(m.content.length <= 16000, `${call.task}: ${m.content.length} chars`)
    }
  }
})

test('LLM down: keyword search, and the reply says why', async () => {
  const reason = describeLlmError('LLM_TIMEOUT')
  const { calls, generate } = llm({ parse: new Error(reason) })
  const result = await runAgentTurn({ userMessage: '找空軍', history: [], files, generate })

  assert.deepEqual(calls.map((c) => c.task), ['parse']) // no summary call once the LLM failed
  assert.equal(result.llmError, reason)
  assert.deepEqual(result.files.map((f) => f.name), ['空軍演訓報告.pdf'])
  assert.ok(result.summary.startsWith(`（AI 無法使用：${reason}。已改用關鍵字搜尋）`))
  assert.match(result.summary, /找到 1 份相關檔案：空軍演訓報告\.pdf/)
})

test('LLM down and nothing matches: the reply still says the AI was not used', async () => {
  const reason = describeLlmError('LLM_UNAVAILABLE')
  const { generate } = llm({ parse: new Error(reason) })
  const result = await runAgentTurn({ userMessage: '找潛艦', history: [], files, generate })

  assert.equal(result.matchCount, 0)
  assert.ok(result.summary.startsWith(`（AI 無法使用：${reason}。已改用關鍵字搜尋）`))
  assert.match(result.summary, /查無符合「找潛艦」的檔案/)
})

test('an answer that is not JSON falls back to keywords with its own reason', async () => {
  const { calls, generate } = llm({ parse: '抱歉，我無法處理', summary: 'unused' })
  const result = await runAgentTurn({ userMessage: '找海軍', history: [], files, generate })
  assert.deepEqual(calls.map((c) => c.task), ['parse'])
  assert.equal(result.llmError, '語言模型的回答無法解讀')
  assert.deepEqual(result.files.map((f) => f.name), ['海軍補給.docx'])
})

test('summary fails after a good parse: results stay, the reason is appended', async () => {
  const reason = describeLlmError('LLM_RATE_LIMITED')
  const { generate } = llm({
    parse: '{"intent":"x","filters":{"tags":{"any":["海軍"]}}}',
    summary: new Error(reason)
  })
  const result = await runAgentTurn({ userMessage: '找海軍', history: [], files, generate })
  assert.deepEqual(result.files.map((f) => f.name), ['海軍補給.docx'])
  assert.equal(result.summary, `找到 1 份符合條件的檔案。（AI 摘要無法產生：${reason}）`)
  assert.equal(result.llmError, reason)
})

test('an empty summary keeps the plain count instead of an empty bubble', async () => {
  const { generate } = llm({ parse: '{"intent":"x","filters":{}}', summary: '   ' })
  const result = await runAgentTurn({ userMessage: '全部', history: [], files, generate })
  assert.equal(result.summary, '找到 3 份符合條件的檔案。')
})

test('describeLlmError: every server code has a readable reason', () => {
  for (const code of ['LLM_BUSY', 'LLM_RATE_LIMITED', 'LLM_TIMEOUT', 'LLM_UNAVAILABLE']) {
    assert.doesNotMatch(describeLlmError(code), /LLM_/)
  }
  assert.equal(describeLlmError('Server did not respond.'), '伺服器沒有回應')
  assert.match(describeLlmError('something new'), /something new/)
})
