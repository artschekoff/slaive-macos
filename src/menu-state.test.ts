// Юнит-тесты обхода дерева меню: вход в узел, возврат, возврат из корня —
// см. бриф ("Тесты"). Сеть, DOM и Tauri здесь не участвуют.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_TREE } from './action-tree.ts'
import { rootMenuState, isRoot, currentLevel, enterNode, goBack, menuDepth } from './menu-state.ts'

test('root state starts at the root of ACTION_TREE and is flagged as root', () => {
  const s = rootMenuState()
  assert.equal(isRoot(s), true)
  assert.equal(currentLevel(s), ACTION_TREE)
  assert.equal(menuDepth(s), 1)
})

test('root exposes exactly the four actions from the brief', () => {
  const s = rootMenuState()
  const ids = currentLevel(s).map((n) => n.id)
  assert.deepEqual(ids, ['translate', 'ask-ai', 'fix', 'shorten'])
})

test('entering a branch node drills into its children and leaves the root', () => {
  const s = rootMenuState()
  const translate = currentLevel(s).find((n) => n.id === 'translate')!
  const next = enterNode(s, translate)
  assert.equal(isRoot(next), false)
  assert.equal(menuDepth(next), 2)
  const ids = currentLevel(next).map((n) => n.id)
  assert.deepEqual(ids, ['translate-en', 'translate-ru'])
})

test('entering a leaf node does not change the menu state', () => {
  const s = rootMenuState()
  const fix = currentLevel(s).find((n) => n.id === 'fix')!
  const next = enterNode(s, fix)
  assert.equal(next, s)
})

test('entering a prompt node shows the prompt without touching the stack', () => {
  const s = rootMenuState()
  const askAi = currentLevel(s).find((n) => n.id === 'ask-ai')!
  const next = enterNode(s, askAi)
  assert.equal(next.prompt?.id, 'ask-ai')
  assert.equal(next.stack, s.stack)
  assert.equal(isRoot(next), false)
  assert.equal(menuDepth(next), 2)
})

test('goBack from a branch level returns to the root', () => {
  const s = rootMenuState()
  const translate = currentLevel(s).find((n) => n.id === 'translate')!
  const drilled = enterNode(s, translate)
  const back = goBack(drilled)
  assert.equal(isRoot(back), true)
  assert.equal(currentLevel(back), ACTION_TREE)
})

test('goBack from the prompt form returns to the level it was opened from, not the root', () => {
  const s = rootMenuState()
  const askAi = currentLevel(s).find((n) => n.id === 'ask-ai')!
  const prompted = enterNode(s, askAi)
  const back = goBack(prompted)
  assert.equal(back.prompt, null)
  assert.equal(isRoot(back), true) // ask-ai живёт прямо в корне, поэтому назад — снова корень
  assert.equal(currentLevel(back), ACTION_TREE)
})

test('goBack from the root is a no-op, not an error', () => {
  const s = rootMenuState()
  const back = goBack(s)
  assert.equal(back, s)
  assert.equal(isRoot(back), true)
})

test('goBack twice from a two-level drill returns exactly to the root, no further', () => {
  const s = rootMenuState()
  const translate = currentLevel(s).find((n) => n.id === 'translate')!
  const drilled = enterNode(s, translate)
  const back1 = goBack(drilled)
  const back2 = goBack(back1) // уже в корне — no-op
  assert.equal(isRoot(back1), true)
  assert.equal(back2, back1)
})
