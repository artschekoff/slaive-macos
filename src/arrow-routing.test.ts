// Юнит-тесты правила "кому сейчас достаются стрелки" — см. arrow-routing.ts.
// Чистая функция без DOM и без vim: hasPendingVimOperator (transcript-
// editor.ts) читает внутренности пакета и здесь не участвует, тестируется
// только сама развилка по названию режима.
import test from 'node:test'
import assert from 'node:assert/strict'
import { arrowsControlList } from './arrow-routing.ts'

test('normal mode without a pending operator routes arrows to the list', () => {
  assert.equal(arrowsControlList('normal', false), true)
})

test('a pending operator keeps arrows with the editor even in normal mode', () => {
  // "d" ждёт моушен — стрелка должна вводить в него, а не листать список.
  assert.equal(arrowsControlList('normal', true), false)
})

test('insert mode always keeps arrows editing text', () => {
  assert.equal(arrowsControlList('insert', false), false)
})

test('visual mode keeps arrows extending the selection, not driving the list', () => {
  assert.equal(arrowsControlList('visual', false), false)
})

test('replace mode keeps arrows repositioning the overtype cursor, not driving the list', () => {
  assert.equal(arrowsControlList('replace', false), false)
})

test('an unknown future vim mode stays with the editor by default (allowlist, not denylist)', () => {
  assert.equal(arrowsControlList('some-future-mode', false), false)
})
