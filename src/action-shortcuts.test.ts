import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ACTION_SHORTCUTS,
  shortcutFor,
  nodeForKey,
  type ActionShortcuts,
} from './action-shortcuts.ts'
import { ACTION_TREE, buildActionTree, type MenuNode } from './action-tree.ts'
import { formatShortcutBadge, hasModifier } from './shortcut.ts'
import type { KeyEventLike } from './shortcut.ts'

/** Нажатие клавиши `code` с перечисленными модификаторами. */
function press(code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
  return { code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }
}

const cmd = (code: string) => press(code, { metaKey: true })

const branch = ACTION_TREE.find((n) => n.id === 'translate') as Extract<MenuNode, { kind: 'branch' }>

test('у каждого корневого действия есть свой хоткей', () => {
  for (const node of ACTION_TREE) {
    assert.ok(node.shortcutKey, `у действия ${node.id} нет ключа хоткея`)
    const accel = shortcutFor(node, 0, true, DEFAULT_ACTION_SHORTCUTS)
    assert.ok(accel, `у действия ${node.id} не разрешился хоткей`)
  }
})

test('дефолты действий не отбирают клавиши у Vim: везде Cmd', () => {
  // Голая клавиша и Ctrl-комбинации разобраны Vim в normal/insert режимах;
  // Cmd в грамматике Vim не встречается вовсе.
  for (const accel of Object.values(DEFAULT_ACTION_SHORTCUTS)) {
    assert.ok(hasModifier(accel), `${accel} без модификатора`)
    assert.ok(accel.startsWith('Super+'), `${accel} не на Cmd`)
    assert.equal(accel.split('+').length, 2, `${accel} сложнее, чем Cmd+клавиша`)
  }
})

test('дефолты действий не сталкиваются между собой и с хоткеем записи', () => {
  const all = [...Object.values(DEFAULT_ACTION_SHORTCUTS), 'Super+KeyT']
  assert.equal(new Set(all).size, all.length, 'две команды на одну комбинацию')
})

test('нажатие корневого хоткея находит своё действие', () => {
  const atRoot = true
  const find = (e: KeyEventLike) => nodeForKey(e, ACTION_TREE, atRoot, DEFAULT_ACTION_SHORTCUTS)?.id
  assert.equal(find(cmd('KeyL')), 'translate')
  assert.equal(find(cmd('KeyK')), 'ask-ai')
  assert.equal(find(cmd('KeyF')), 'fix')
  assert.equal(find(cmd('KeyS')), 'shorten')
  assert.equal(find(cmd('KeyU')), 'summarize')
})

// Summarize и Shorten — разные действия, и по клавише их тоже не спутать:
// Cmd+S остаётся у Shorten, Summarize взял Cmd+U (Cmd+M занят системным
// Minimize, до окна такое нажатие не доходит).
test('Summarize не отбирает Cmd+S у Shorten', () => {
  assert.equal(DEFAULT_ACTION_SHORTCUTS.shortenShortcut, 'Super+KeyS')
  assert.equal(DEFAULT_ACTION_SHORTCUTS.summarizeShortcut, 'Super+KeyU')
  assert.notEqual(DEFAULT_ACTION_SHORTCUTS.summarizeShortcut, 'Super+KeyM')
})

test('нажатие без Cmd не запускает ничего — эти клавиши принадлежат редактору', () => {
  for (const code of ['KeyL', 'KeyK', 'KeyF', 'KeyS', 'KeyU']) {
    assert.equal(nodeForKey(press(code), ACTION_TREE, true, DEFAULT_ACTION_SHORTCUTS), null)
    assert.equal(
      nodeForKey(press(code, { ctrlKey: true }), ACTION_TREE, true, DEFAULT_ACTION_SHORTCUTS),
      null
    )
  }
})

test('лишний модификатор поверх комбинации — уже не она', () => {
  const e = press('KeyF', { metaKey: true, shiftKey: true })
  assert.equal(nodeForKey(e, ACTION_TREE, true, DEFAULT_ACTION_SHORTCUTS), null)
})

test('переназначение в настройках меняет и бейдж, и то, что срабатывает', () => {
  const custom: ActionShortcuts = { ...DEFAULT_ACTION_SHORTCUTS, fixShortcut: 'Ctrl+Alt+KeyG' }
  const fix = ACTION_TREE.find((n) => n.id === 'fix')!
  assert.equal(shortcutFor(fix, 2, true, custom), 'Ctrl+Alt+KeyG')
  assert.equal(formatShortcutBadge(shortcutFor(fix, 2, true, custom)!), '⌃⌥G')
  assert.equal(nodeForKey(cmd('KeyF'), ACTION_TREE, true, custom), null)
  assert.equal(
    nodeForKey(press('KeyG', { ctrlKey: true, altKey: true }), ACTION_TREE, true, custom)?.id,
    'fix'
  )
})

test('пункты подменю получают позиционные Cmd+цифра, а не настройку', () => {
  const atRoot = false
  assert.equal(shortcutFor(branch.children[0], 0, atRoot, DEFAULT_ACTION_SHORTCUTS), 'Super+Digit1')
  assert.equal(shortcutFor(branch.children[1], 1, atRoot, DEFAULT_ACTION_SHORTCUTS), 'Super+Digit2')
  assert.equal(shortcutFor(branch.children[2], 2, atRoot, DEFAULT_ACTION_SHORTCUTS), 'Super+Digit3')
  assert.equal(formatShortcutBadge('Super+Digit1'), '⌘1')
  assert.equal(
    nodeForKey(cmd('Digit2'), branch.children, atRoot, DEFAULT_ACTION_SHORTCUTS)?.id,
    'translate-spanish'
  )
})

// Больше девяти языков в настройках не запрещено: нумеруются первые девять в
// том порядке, в каком они написаны, десятый остаётся кнопкой без бейджа и
// работает мышью. Это и есть поведение MAX_POSITIONAL, проверенное на
// настоящем подменю, а не на одном узле.
test('позиционные номера получают первые девять языков, десятый — кнопка без бейджа', () => {
  const many = buildActionTree('a, b, c, d, e, f, g, h, i, j, k')
  const languages = (many[0] as Extract<MenuNode, { kind: 'branch' }>).children
  assert.equal(languages.length, 11)
  const accels = languages.map((n, i) => shortcutFor(n, i, false, DEFAULT_ACTION_SHORTCUTS))
  assert.deepEqual(accels.slice(0, 9), [
    'Super+Digit1',
    'Super+Digit2',
    'Super+Digit3',
    'Super+Digit4',
    'Super+Digit5',
    'Super+Digit6',
    'Super+Digit7',
    'Super+Digit8',
    'Super+Digit9',
  ])
  assert.deepEqual(accels.slice(9), [null, null])
  // И нажатием десятый не достаётся никому: цифр больше нет.
  assert.equal(nodeForKey(cmd('Digit9'), languages, false, DEFAULT_ACTION_SHORTCUTS)?.label, 'i')
})

test('десятому пункту подменю позиционного хоткея не достаётся', () => {
  const node = branch.children[0]
  assert.equal(shortcutFor(node, 8, false, DEFAULT_ACTION_SHORTCUTS), 'Super+Digit9')
  assert.equal(shortcutFor(node, 9, false, DEFAULT_ACTION_SHORTCUTS), null)
})

test('на подуровне корневые хоткеи не срабатывают: тех кнопок на экране нет', () => {
  assert.equal(nodeForKey(cmd('KeyF'), branch.children, false, DEFAULT_ACTION_SHORTCUTS), null)
})

test('в корне позиционные цифры не срабатывают', () => {
  assert.equal(nodeForKey(cmd('Digit1'), ACTION_TREE, true, DEFAULT_ACTION_SHORTCUTS), null)
})
