// Run: node --test test/recovery/*.test.js
// The share table's column default is written out in the SQL. It has to stay the id of the
// default recovery method, which the rest of the server takes from DEFAULT_METHOD_ID.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_METHOD_ID,
  SHARE_MIGRATION_SQL,
  SHARE_TABLE_SQL
} from '../../src/RecoverySchema.js'

const METHOD_ID_DEFAULT = /\bmethod_id\s+TEXT\s+NOT NULL DEFAULT '([^']*)'/g

test('the method_id column default is the default recovery method', () => {
  for (const statement of [SHARE_TABLE_SQL, SHARE_MIGRATION_SQL]) {
    const defaults = Array.from(statement.matchAll(METHOD_ID_DEFAULT), (match) => match[1])
    assert.deepEqual(defaults, [DEFAULT_METHOD_ID])
  }
})
