import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findShortcutConflict,
  conflictMessage,
  SHORTCUT_FIELDS,
} from './shortcut-conflicts.ts'

const settings = {
  hotkey: 'Super+KeyT',
  pasteShortcut: 'Enter',
  copyShortcut: 'Super+KeyC',
  mainPasteShortcut: 'Super+Enter',
  translateShortcut: 'Super+KeyL',
  askAiShortcut: 'Super+KeyK',
  fixShortcut: 'Super+KeyF',
  shortenShortcut: 'Super+KeyS',
  summarizeShortcut: 'Super+KeyU',
}

test('свободная комбинация конфликта не даёт', () => {
  assert.equal(findShortcutConflict('Super+KeyQ', 'fixShortcut', settings), null)
})

test('столкновение с глобальным хоткеем записи названо по имени', () => {
  // Именно этот случай проваливался молча: глобальный хоткей перехватывает
  // клавишу системно, и оконное действие не получает события вовсе.
  assert.equal(findShortcutConflict('Super+KeyT', 'fixShortcut', settings), 'Record hotkey')
})

test('столкновение двух оконных комбинаций тоже ловится', () => {
  assert.equal(findShortcutConflict('Super+KeyK', 'shortenShortcut', settings), 'Ask AI')
})

test('поле не конфликтует само с собой — переназначение на то же значение допустимо', () => {
  assert.equal(findShortcutConflict('Super+KeyF', 'fixShortcut', settings), null)
})

test('пустая комбинация конфликта не даёт', () => {
  assert.equal(findShortcutConflict('', 'fixShortcut', settings), null)
})

test('отсутствующие в объекте поля не ломают проверку', () => {
  assert.equal(findShortcutConflict('Super+KeyT', 'fixShortcut', { hotkey: 'Super+KeyT' }), 'Record hotkey')
})

test('дефолты приложения между собой не конфликтуют', () => {
  // Стережёт от правки дефолтов, которая тихо сделала бы две команды
  // неработающими из коробки.
  for (const { key } of SHORTCUT_FIELDS) {
    const accel = settings[key as keyof typeof settings]
    assert.equal(
      findShortcutConflict(accel, key, settings),
      null,
      `дефолт ${key} = ${accel} конфликтует с другим дефолтом`
    )
  }
})

test('сообщение называет и комбинацию, и занявшее её поле', () => {
  const msg = conflictMessage('Super+KeyT', 'Record hotkey')
  assert.ok(msg.includes('Super+KeyT'))
  assert.ok(msg.includes('Record hotkey'))
  assert.ok(msg.includes('silently never fires'))
})
