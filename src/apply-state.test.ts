// Юнит-тесты цикла применения действия: простое → ожидание → предложено →
// принято либо отменено; отмена возвращает исходный текст побайтово (см.
// бриф, "Тесты"). Сеть, DOM и Tauri здесь не участвуют.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  idleApplyState,
  startRequest,
  receiveResult,
  receiveError,
  isCurrentError,
  cancelApply,
  acceptApply,
} from './apply-state.ts'

test('idle -> pending -> proposed -> accept -> idle, the full happy path', () => {
  let s = idleApplyState()
  assert.equal(s.phase, 'idle')

  s = startRequest('original text', 1)
  assert.deepEqual(s, { phase: 'pending', original: 'original text', requestId: 1 })

  s = receiveResult(s, 1, 'proposed text')
  assert.deepEqual(s, { phase: 'proposed', original: 'original text', proposed: 'proposed text' })

  s = acceptApply(s)
  assert.deepEqual(s, { phase: 'idle' })
})

test('idle -> pending -> error -> idle, text is never part of the error transition', () => {
  let s = idleApplyState()
  s = startRequest('original text', 1)
  s = receiveError(s, 1)
  assert.deepEqual(s, { phase: 'idle' })
})

test('cancel from pending returns to idle', () => {
  const pending = startRequest('original text', 1)
  const s = cancelApply(pending)
  assert.deepEqual(s, { phase: 'idle' })
})

test('cancel from proposed returns to idle', () => {
  const proposed = receiveResult(startRequest('original text', 1), 1, 'proposed text')
  const s = cancelApply(proposed)
  assert.deepEqual(s, { phase: 'idle' })
})

test('a stale result (superseded requestId) is ignored and does not touch the state', () => {
  const pending = startRequest('original text', 2)
  // Ответ на requestId 1 — от запроса, который уже был отменён/заменён до
  // того, как пришёл этот ответ.
  const s = receiveResult(pending, 1, 'late text')
  assert.equal(s, pending) // тот же объект — ничего не поменялось
  assert.equal(s.phase, 'pending')
})

test('a stale error (superseded requestId) is ignored', () => {
  const pending = startRequest('original text', 2)
  const s = receiveError(pending, 1)
  assert.equal(s, pending)
})

test('a result arriving after the request was already cancelled is ignored', () => {
  const pending = startRequest('original text', 1)
  const cancelled = cancelApply(pending)
  const s = receiveResult(cancelled, 1, 'late text')
  assert.equal(s, cancelled)
  assert.equal(s.phase, 'idle')
})

test('accept is a no-op outside the proposed phase', () => {
  const idle = idleApplyState()
  assert.equal(acceptApply(idle), idle)
  const pending = startRequest('x', 1)
  assert.equal(acceptApply(pending), pending)
})

// isCurrentError — guard consulted by MainWindow's runRequest `.catch`, so a
// "Cancelled." rejection from a cancelled/superseded request never paints
// the error banner over text that arrived correctly (see the brief's second
// defect: false "Cancelled." under captured text).

test('isCurrentError: false once the request was cancelled (applyState already back to idle)', () => {
  const pending = startRequest('original text', 1)
  // Cancel уже перевёл состояние в idle СИНХРОННО, до того как отменённый
  // промис успел долететь до .catch — ровно порядок onCancel/follow:text.
  const cancelledState = cancelApply(pending)
  assert.equal(isCurrentError(cancelledState, 1), false)
})

test('isCurrentError: false once a new request superseded the old one', () => {
  const firstPending = startRequest('original text', 1)
  const cancelledThenRestarted = startRequest('new text', 2)
  // Ответ на requestId 1 долетает уже после того, как запрос 2 стартовал.
  void firstPending
  assert.equal(isCurrentError(cancelledThenRestarted, 1), false)
})

test('isCurrentError: true for a genuine failure of the still-current request', () => {
  const pending = startRequest('original text', 1)
  // Ничего не отменяло и не заменяло этот запрос — applyState всё ещё pending
  // с тем же requestId, когда пришёл отказ (сеть, ключ, провайдер).
  assert.equal(isCurrentError(pending, 1), true)
})

test('isCurrentError: false outside the pending phase entirely (idle, proposed)', () => {
  assert.equal(isCurrentError(idleApplyState(), 1), false)
  const proposed = receiveResult(startRequest('x', 1), 1, 'y')
  assert.equal(isCurrentError(proposed, 1), false)
})

test('original is preserved byte for byte through the whole pending/proposed cycle', () => {
  const original = 'line one\nline two — with an em dash and emoji 🎤'
  const pending = startRequest(original, 1)
  assert.equal(pending.phase === 'pending' ? pending.original : null, original)

  const proposed = receiveResult(pending, 1, 'something completely different')
  assert.equal(proposed.phase === 'proposed' ? proposed.original : null, original)

  // Cancel не восстанавливает original обратным преобразованием — оно уже
  // лежало нетронутым в состоянии всё это время; вызывающая сторона просто
  // читает его и подставляет в редактор как есть, отсюда и байтовая точность.
  assert.equal(proposed.phase === 'proposed' ? proposed.original === original : false, true)
})
