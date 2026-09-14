import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findShortcutConflict,
  conflictMessage,
  SHORTCUT_FIELDS,
} from './shortcut-conflicts.ts'
import {
  DEFAULT_COPY_SHORTCUT,
  DEFAULT_FOLLOW_SHORTCUT,
  DEFAULT_PASTE_SHORTCUT,
} from './shortcut.ts'
import { DEFAULT_ACCEPT_SHORTCUT, DEFAULT_ACTION_SHORTCUTS } from './action-shortcuts.ts'

// Дефолты берутся из тех же констант, что раскладывает по окнам живой код, а
// не переписываются сюда руками: копия разошлась бы с оригиналом молча, и
// тест «дефолты не конфликтуют» ниже сторожил бы выдуманный набор вместо
// настоящего. Литералами остались ровно два значения, у которых экспортируемой
// константы на фронтенде нет вовсе: глобальный хоткей записи и Paste главного
// окна (оба живут в Settings::default() на бэкенде, см. src-tauri/src/settings.rs,
// и там же сторожатся своим тестом default_shortcuts_do_not_collide).
const settings = {
  hotkey: 'Super+KeyT',
  captureHotkey: 'Ctrl+Super+Space',
  pasteShortcut: DEFAULT_PASTE_SHORTCUT,
  copyShortcut: DEFAULT_COPY_SHORTCUT,
  followShortcut: DEFAULT_FOLLOW_SHORTCUT,
  mainPasteShortcut: 'Super+Enter',
  acceptShortcut: DEFAULT_ACCEPT_SHORTCUT,
  ...DEFAULT_ACTION_SHORTCUTS,
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

// Ровно тот случай, ради которого проверку просили расширить: Follow просили
// на Ctrl+F, а Cmd+F в главном окне уже занят Fix. Похоже — но не одно и то
// же, и полагаться на «это же разные окна» нельзя: findShortcutConflict
// сравнивает строки и про окна ничего не знает.
test('Follow на Ctrl+F не конфликтует с Fix на Cmd+F', () => {
  assert.equal(settings.followShortcut, 'Ctrl+KeyF')
  assert.equal(settings.fixShortcut, 'Super+KeyF')
  assert.equal(findShortcutConflict(settings.followShortcut, 'followShortcut', settings), null)
  // И обратно: Fix не считает себя занятым Follow'ом.
  assert.equal(findShortcutConflict(settings.fixShortcut, 'fixShortcut', settings), null)
})

// Accept намеренно стоит рядом с Paste главного окна (⇧⌘⏎ против ⌘⏎) — это
// две РАЗНЫЕ комбинации, и путать их нельзя ни проверке, ни пользователю.
test('Accept на Shift+Cmd+Enter не конфликтует с Paste на Cmd+Enter', () => {
  assert.equal(settings.acceptShortcut, 'Shift+Super+Enter')
  assert.equal(settings.mainPasteShortcut, 'Super+Enter')
  assert.equal(findShortcutConflict(settings.acceptShortcut, 'acceptShortcut', settings), null)
  assert.equal(findShortcutConflict(settings.mainPasteShortcut, 'mainPasteShortcut', settings), null)
})

// Новое поле, не попавшее в SHORTCUT_FIELDS, не проверяется ВООБЩЕ — молча,
// ровно как конфликт, который этот файл и должен ловить. Поэтому список
// сторожится по составу, а не только по поведению.
test('каждое хранимое поле с комбинацией перечислено в SHORTCUT_FIELDS', () => {
  const listed = SHORTCUT_FIELDS.map((f) => f.key).sort()
  assert.deepEqual(listed, Object.keys(settings).sort())
})

test('хоткей захвата участвует в проверке конфликтов', () => {
  // Он глобальный, как и хоткей записи: столкновение с чем угодно другим
  // означает, что одна из двух команд молча перестанет срабатывать.
  assert.equal(
    findShortcutConflict(settings.captureHotkey, 'hotkey', settings),
    'Capture selection'
  )
})

test('сообщение называет и комбинацию, и занявшее её поле', () => {
  const msg = conflictMessage('Super+KeyT', 'Record hotkey')
  assert.ok(msg.includes('Super+KeyT'))
  assert.ok(msg.includes('Record hotkey'))
  assert.ok(msg.includes('silently never fires'))
})
