// Регрессионный тест на список расширений редактора транскрипта. Сам баг
// (visual-mode невидим, undo не работает) не проявлялся ни в tsc, ни в
// существующих тестах — `Extension` в CodeMirror 6 непрозрачен, отсутствие
// одного расширения не даёт ошибки компиляции и не роняет остальную логику.
// Тест слабый сам по себе (не рендерит DOM, не нажимает клавиши), но это
// разница между тихой деградацией при будущем рефакторе и падающей проверкой:
// если кто-то уберёт drawSelection()/history()/allowMultipleSelections из
// transcriptEditorExtensions, эти проверки должны упасть.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EditorState } from '@codemirror/state'
import { drawSelection } from '@codemirror/view'
import { historyField } from '@codemirror/commands'
import { joinTranscript, transcriptEditorExtensions } from './transcript-editor.ts'

test('transcriptEditorExtensions: drawSelection() подключён (иначе visual-mode выделение невидимо)', () => {
  const extensions = transcriptEditorExtensions({})
  // Extension — произвольно вложенные массивы; .flat(Infinity) разворачивает
  // их без клонирования содержимого, так что сравнение по ссылке (===) ниже
  // остаётся валидным. cursorLayer/selectionLayer/hideNativeSelection —
  // синглтоны модуля @codemirror/view (создаются один раз при загрузке
  // модуля, см. node_modules/@codemirror/view/dist/index.js, строки
  // ~9551/9583) — drawSelection(), вызванный здесь отдельно, встраивает те
  // же самые объекты, что и вызов внутри transcriptEditorExtensions.
  const flatExtensions = (extensions as unknown[]).flat(Infinity)
  const probe = (drawSelection() as unknown[]).flat(Infinity)
  const sharesDrawSelectionPiece = probe.some((piece) => flatExtensions.includes(piece))
  assert.ok(
    sharesDrawSelectionPiece,
    'drawSelection() отсутствует — visual-mode будет менять состояние, но пользователь не увидит выделение'
  )
})

test('transcriptEditorExtensions: history() подключён (иначе vim-овский "u" молча ничего не делает)', () => {
  const extensions = transcriptEditorExtensions({})
  const state = EditorState.create({ doc: '', extensions })
  // historyField — тот самый StateField, который undo()/redo() из
  // '@codemirror/commands' читают через state.field(historyField, false);
  // без history() поле отсутствует, и undo()/redo() тихо ничего не делают
  // (см. node_modules/@codemirror/commands/dist/index.js, ~строка 289) —
  // ровно симптом из репорта.
  assert.notEqual(
    state.field(historyField, false),
    undefined,
    'history() отсутствует — undo/redo станут молчаливым no-op'
  )
})

test('transcriptEditorExtensions: allowMultipleSelections включён (нужен visual block и мультикурсору vim)', () => {
  const extensions = transcriptEditorExtensions({})
  const state = EditorState.create({ doc: '', extensions })
  assert.equal(
    state.facet(EditorState.allowMultipleSelections),
    true,
    'allowMultipleSelections выключен — vim-овский visual block (Ctrl-V) схлопнется в обычный charwise'
  )
})

// Склейка текста при дозаписи. Чистая функция, но именно она решает, не
// потеряется ли уже надиктованное: joinTranscript никогда не возвращает
// меньше, чем ей дали прежним текстом.
test('joinTranscript: пустой прежний текст — добавка становится текстом', () => {
  assert.equal(joinTranscript('', 'привет'), 'привет')
})

test('joinTranscript: прежний текст без пробела на конце — пробел добавляется', () => {
  assert.equal(joinTranscript('привет', 'мир'), 'привет мир')
})

test('joinTranscript: прежний текст с пробелом на конце — двойного не будет', () => {
  assert.equal(joinTranscript('привет ', 'мир'), 'привет мир')
  // Перенос строки пользователь поставил сам (o/Enter в insert) — это тоже
  // пробельный символ, приклеивать к нему ещё и пробел незачем.
  assert.equal(joinTranscript('привет\n', 'мир'), 'привет\nмир')
})

test('joinTranscript: пустая добавка не меняет прежний текст', () => {
  assert.equal(joinTranscript('привет', ''), 'привет')
  assert.equal(joinTranscript('привет', '   '), 'привет')
  assert.equal(joinTranscript('', ''), '')
})

test('joinTranscript: добавка обрезается по краям (whisper отдаёт ведущий пробел)', () => {
  assert.equal(joinTranscript('привет', ' мир '), 'привет мир')
})

test('joinTranscript: прежний текст всегда остаётся префиксом результата', () => {
  // Инвариант «дозапись не съедает уже сделанное»: что бы ни пришло добавкой,
  // накопленный текст обязан остаться в начале результата целиком.
  for (const existing of ['', 'а', 'правленный руками текст', 'с пробелом ']) {
    for (const addition of ['', '   ', 'добавка', ' добавка ']) {
      assert.ok(joinTranscript(existing, addition).startsWith(existing))
    }
  }
})
