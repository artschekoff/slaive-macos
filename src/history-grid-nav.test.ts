// Юнит-тесты двумерной навигации по сетке истории — см. history-grid-nav.ts
// и отчёт (раздел про историю): цикл на краях строк/колонок, подтягивание к
// ближайшему пункту в неполной последней строке, вырожденные сетки.
import test from 'node:test'
import assert from 'node:assert/strict'
import { moveGridDown, moveGridUp, moveGridLeft, moveGridRight } from './history-grid-nav.ts'

// 3 колонки, 9 плиток — три полные строки:
// 0 1 2
// 3 4 5
// 6 7 8
test('moveGridDown steps to the same column one row below', () => {
  assert.equal(moveGridDown(0, 9, 3), 3)
  assert.equal(moveGridDown(4, 9, 3), 7)
})

test('moveGridDown from the bottom row wraps to the top row, same column', () => {
  assert.equal(moveGridDown(6, 9, 3), 0)
  assert.equal(moveGridDown(8, 9, 3), 2)
})

test('moveGridUp steps to the same column one row above', () => {
  assert.equal(moveGridUp(7, 9, 3), 4)
})

test('moveGridUp from the top row wraps to the bottom row, same column', () => {
  assert.equal(moveGridUp(1, 9, 3), 7)
})

// 3 колонки, 10 плиток — неполная последняя строка (один пункт, индекс 9):
// 0 1 2
// 3 4 5
// 6 7 8
// 9
test('moveGridDown into a short last row clamps to the nearest existing tile, not the void', () => {
  assert.equal(moveGridDown(7, 10, 3), 9) // колонка 1 в последней строке не существует — ближайшая 9
  assert.equal(moveGridDown(6, 10, 3), 9) // колонка 0 — единственный пункт последней строки
})

test('moveGridUp from the short last row lands under its real column, not a phantom one', () => {
  assert.equal(moveGridUp(9, 10, 3), 6)
})

test('moveGridDown wraps from the short last row back to a full top row', () => {
  assert.equal(moveGridDown(9, 10, 3), 0)
})

test('moveGridUp/Down on a single (possibly short) row are no-ops — wrap target is the same row', () => {
  assert.equal(moveGridDown(1, 2, 3), 1)
  assert.equal(moveGridUp(1, 2, 3), 1)
})

test('moveGridUp/Down on an empty grid stay at 0, not crash', () => {
  assert.equal(moveGridDown(0, 0, 3), 0)
  assert.equal(moveGridUp(0, 0, 3), 0)
})

test('moveGridUp/Down tolerate a degenerate zero column count instead of dividing by zero', () => {
  assert.equal(moveGridDown(0, 5, 0), 1)
  assert.equal(moveGridUp(0, 5, 0), 4)
})

test('moveGridRight/Left are the same wrap-around ribbon as the action column', () => {
  assert.equal(moveGridRight(0, 5), 1)
  assert.equal(moveGridRight(4, 5), 0) // цикл с последнего пункта на первый
  assert.equal(moveGridLeft(0, 5), 4) // цикл с первого пункта на последний
})
