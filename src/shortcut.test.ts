// Юнит-тесты чистых функций из shortcut.ts — разбор события клавиатуры и
// форматирование бейджа. Запускаются встроенным тест-раннером Node (без
// дополнительных зависимостей): `node --test src/shortcut.test.ts`.
// Обработка самих клавиш в Overlay/Settings — уже UI и здесь не тестируется.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseKeyEvent,
  hasModifier,
  matchesShortcut,
  formatShortcutBadge,
  displayShortcut,
  type KeyEventLike,
} from './shortcut.ts'

function key(code: string, mods: Partial<Omit<KeyEventLike, 'code'>> = {}): KeyEventLike {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  }
}

test('parseKeyEvent: обычная клавиша без модификаторов', () => {
  assert.equal(parseKeyEvent(key('Enter')), 'Enter')
})

test('parseKeyEvent: один модификатор без обычной клавиши — null (ждём дальше)', () => {
  assert.equal(parseKeyEvent(key('MetaLeft', { metaKey: true })), null)
  assert.equal(parseKeyEvent(key('ShiftRight', { shiftKey: true })), null)
})

test('parseKeyEvent: Cmd+C -> Super+KeyC (порядок модификаторов фиксирован)', () => {
  assert.equal(parseKeyEvent(key('KeyC', { metaKey: true })), 'Super+KeyC')
})

test('parseKeyEvent: несколько модификаторов идут в порядке Ctrl, Alt, Shift, Super', () => {
  assert.equal(
    parseKeyEvent(key('KeyT', { metaKey: true, ctrlKey: true, shiftKey: true })),
    'Ctrl+Shift+Super+KeyT'
  )
})

test('parseKeyEvent: Shift+Enter отличается от Enter', () => {
  assert.notEqual(parseKeyEvent(key('Enter', { shiftKey: true })), parseKeyEvent(key('Enter')))
  assert.equal(parseKeyEvent(key('Enter', { shiftKey: true })), 'Shift+Enter')
})

test('hasModifier', () => {
  assert.equal(hasModifier('Enter'), false)
  assert.equal(hasModifier('Super+KeyC'), true)
})

test('matchesShortcut: голый Enter пастит, Shift+Enter — нет', () => {
  const pasteShortcut = 'Enter'
  assert.equal(matchesShortcut(key('Enter'), pasteShortcut), true)
  assert.equal(matchesShortcut(key('Enter', { shiftKey: true }), pasteShortcut), false)
})

test('matchesShortcut: переназначенный Paste-хоткей ловит новую комбинацию, не старую', () => {
  const pasteShortcut = 'Shift+Enter'
  assert.equal(matchesShortcut(key('Enter', { shiftKey: true }), pasteShortcut), true)
  assert.equal(matchesShortcut(key('Enter'), pasteShortcut), false)
})

test('matchesShortcut: одинокий модификатор никогда не совпадает', () => {
  assert.equal(matchesShortcut(key('MetaLeft', { metaKey: true }), 'Super+KeyC'), false)
})

test('formatShortcutBadge: дефолт Paste — Enter -> ⏎', () => {
  assert.equal(formatShortcutBadge('Enter'), '⏎')
})

test('formatShortcutBadge: дефолт Copy — Cmd+C -> ⌘C', () => {
  assert.equal(formatShortcutBadge('Super+KeyC'), '⌘C')
})

test('formatShortcutBadge: все четыре модификатора в порядке macOS', () => {
  assert.equal(
    formatShortcutBadge('Ctrl+Alt+Shift+Super+KeyT'),
    '⌃⌥⇧⌘T'
  )
})

test('formatShortcutBadge: цифровая клавиша', () => {
  assert.equal(formatShortcutBadge('Super+Digit1'), '⌘1')
})

test('formatShortcutBadge: Escape -> ⎋ (не назначаем, но форматтер общий)', () => {
  assert.equal(formatShortcutBadge('Escape'), '⎋')
})

test('displayShortcut: Super отображается как Cmd, код клавиши — как есть', () => {
  // Как и раньше (displayHotkey): читаемо превращается только модификатор,
  // код клавиши выводится как есть ("KeyC", не "C") — это уже существующее
  // поведение поля захвата, а не часть бейджа на кнопках (тот компактный
  // формат делает formatShortcutBadge).
  assert.equal(displayShortcut('Super+KeyC'), 'Cmd + KeyC')
})

test('displayShortcut: клавиша без модификатора выводится как код клавиши', () => {
  assert.equal(displayShortcut('Enter'), 'Enter')
})
