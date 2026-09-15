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
import { insertTranscriptAt, transcriptEditorExtensions } from './transcript-editor.ts'

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

// Вставка текста при дозаписи в позицию курсора/выделения. Чистая функция —
// insertTranscriptAt ничего не знает про CodeMirror, только про смещения в
// строке; applyInsertion ниже — тестовый хелпер, склеивающий её результат
// (insert-кусок) обратно в полный текст ровно тем же способом, каким это
// делает реальный dispatch ({ from, to, insert }), чтобы тесты проверяли и
// текст, и позицию каретки на одном и том же вызове.
function applyInsertion(existing: string, addition: string, from: number, to: number) {
  const { insert, cursor } = insertTranscriptAt(existing, addition, from, to)
  const text = existing.slice(0, from) + insert + existing.slice(to)
  return { text, cursor }
}

test('insertTranscriptAt: пустой прежний текст — добавка становится текстом (первая запись сессии)', () => {
  const { text, cursor } = applyInsertion('', 'привет', 0, 0)
  assert.equal(text, 'привет')
  assert.equal(cursor, 'привет'.length)
})

test('insertTranscriptAt: вставка в самый конец — пробел добавляется, если его не было', () => {
  const existing = 'привет'
  const { text, cursor } = applyInsertion(existing, 'мир', existing.length, existing.length)
  assert.equal(text, 'привет мир')
  assert.equal(cursor, 'привет мир'.length)
})

test('insertTranscriptAt: вставка в конец, уже кончающийся пробелом, — двойного не будет', () => {
  assert.equal(applyInsertion('привет ', 'мир', 7, 7).text, 'привет мир')
  // Перенос строки пользователь поставил сам (o/Enter в insert) — это тоже
  // пробельный символ, приклеивать к нему ещё и пробел незачем.
  assert.equal(applyInsertion('привет\n', 'мир', 7, 7).text, 'привет\nмир')
})

test('insertTranscriptAt: вставка в начало документа — пробел добавляется только справа', () => {
  const { text, cursor } = applyInsertion('мир', 'привет', 0, 0)
  assert.equal(text, 'привет мир')
  // Курсор сразу за вставленным куском, не за разделителем справа.
  assert.equal(cursor, 'привет'.length)
})

test('insertTranscriptAt: вставка в середину строки между словами — сосед уже пробельный, разделители не дублируются', () => {
  const existing = 'привет мир'
  const from = existing.indexOf(' ') + 1 // сразу после пробела, перед "мир"
  const { text, cursor } = applyInsertion(existing, 'большой', from, from)
  assert.equal(text, 'привет большой мир')
  assert.equal(cursor, 'привет большой'.length)
})

test('insertTranscriptAt: вставка в середину слова — соседей-пробелов нет ни слева, ни справа, разделители нужны с обеих сторон', () => {
  const existing = 'helloworld'
  const from = 'hello'.length // между "hello" и "world", пробела там нет
  const { text, cursor } = applyInsertion(existing, 'cool', from, from)
  assert.equal(text, 'hello cool world')
  assert.equal(cursor, 'hello cool'.length)
})

test('insertTranscriptAt: замена выделения — добавка встаёт ВМЕСТО выделенного, а не рядом с ним', () => {
  const existing = 'привет старый мир'
  const from = existing.indexOf('старый')
  const to = from + 'старый'.length
  const { text, cursor } = applyInsertion(existing, 'новый', from, to)
  assert.equal(text, 'привет новый мир')
  assert.equal(cursor, 'привет новый'.length)
})

test('insertTranscriptAt: замена выделения на всю строку — от пустого документа до только что надиктованного', () => {
  const existing = 'черновик под замену'
  const { text, cursor } = applyInsertion(existing, 'итоговый текст', 0, existing.length)
  assert.equal(text, 'итоговый текст')
  assert.equal(cursor, 'итоговый текст'.length)
})

test('insertTranscriptAt: пустая добавка не трогает документ вообще', () => {
  const empty = insertTranscriptAt('привет мир', '', 3, 3)
  assert.equal(empty.insert, '')
  assert.equal(empty.cursor, 3)
  const blank = insertTranscriptAt('привет мир', '   ', 3, 3)
  assert.equal(blank.insert, '')
  assert.equal(blank.cursor, 3)
})

test('insertTranscriptAt: добавка обрезается по краям (whisper отдаёт ведущий пробел)', () => {
  const { text } = applyInsertion('привет', ' мир ', 6, 6)
  assert.equal(text, 'привет мир')
})
