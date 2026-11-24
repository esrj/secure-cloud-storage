// Run: npm run test:classifier
//
// The reply contract between the model and the app: the grammar schema that
// constrains what the model may write, and the parser that reads it back.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  ZH_LABEL_ORDER,
  ZH_CLASSIFY_JSON_SCHEMA,
  parseZhClassificationResponse,
  parseZhClassificationJson
} = await import(new URL('../../src/main/utils/classifyZhJson.js', import.meta.url).href)

// What Gemma 4 E4B answered for 陸軍類測試文章_01.pdf on 2026-11-24.
const EMPTY_LABELS_REPLY = '{ "labels": [ ], "final_labels": [ "陸軍", "演訓戰備" ] }'

test('schema: labels is exactly the six labels, in order, with fixed names', () => {
  const labels = ZH_CLASSIFY_JSON_SCHEMA.properties.labels
  assert.equal(labels.type, 'array')
  assert.equal(labels.minItems, 6)
  assert.equal(labels.maxItems, 6)
  assert.equal('items' in labels, false, 'no open-ended items: an empty array must not be legal')
  assert.deepEqual(
    labels.prefixItems.map((item) => item.properties.name),
    ZH_LABEL_ORDER.map((name) => ({ const: name }))
  )
  for (const item of labels.prefixItems) {
    assert.deepEqual(Object.keys(item.properties), ['name', 'score', 'evidence'])
    assert.deepEqual(item.properties.score, { type: 'number' })
  }
})

test('parser: a reply with an empty labels array is rejected', () => {
  assert.deepEqual(parseZhClassificationResponse(EMPTY_LABELS_REPLY), {
    ok: false,
    reason: 'NO_LABELS'
  })
  // The single-shot helper must not turn it into ["其他"] either.
  assert.deepEqual(parseZhClassificationJson(EMPTY_LABELS_REPLY, 0.55), {
    ok: false,
    reason: 'NO_LABELS'
  })
})

test('parser: a reply with only unknown label names is rejected', () => {
  const raw = JSON.stringify({
    labels: [{ name: 'NAVY', score: 0.9, evidence: ['x'] }, null, 'x'],
    final_labels: ['NAVY']
  })
  assert.deepEqual(parseZhClassificationResponse(raw), { ok: false, reason: 'NO_LABELS' })
})

test('parser: labels the model left out still read as score 0', () => {
  const raw = JSON.stringify({
    labels: [{ name: '陸軍', score: 0.9, evidence: ['檔案 1：陸軍'] }],
    final_labels: ['陸軍']
  })
  const parsed = parseZhClassificationResponse(raw)
  assert.equal(parsed.ok, true)
  assert.deepEqual(
    parsed.labels.map((l) => [l.name, l.score]),
    [
      ['海軍', 0],
      ['陸軍', 0.9],
      ['空軍', 0],
      ['聯合作戰', 0],
      ['演訓戰備', 0],
      ['其他', 0]
    ]
  )
})

test('parser: six explicit zero scores are a real answer and fall back to 其他', () => {
  const raw = JSON.stringify({
    labels: ZH_LABEL_ORDER.map((name) => ({ name, score: 0, evidence: [] })),
    final_labels: []
  })
  const parsed = parseZhClassificationJson(raw, 0.55)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.final_labels, ['其他'])
})
