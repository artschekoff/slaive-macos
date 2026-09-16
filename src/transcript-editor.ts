// Общая логика редактора транскрипта (CodeMirror + Vim) — используется и
// оверлеем (Overlay.tsx), и главным окном (MainWindow.tsx): один и тот же тип
// поля, одна и та же построчная навигация, один и тот же способ читать и
// заменять содержимое. Раньше это целиком жило в Overlay.tsx — при появлении
// второго окна с тем же полем дублирование разъехалось бы при первой же
// правке (тот же принцип, что бриф просит применить к общим кускам CSS).
import { EditorState, type Extension } from '@codemirror/state'
import { drawSelection, EditorView, placeholder } from '@codemirror/view'
import { history } from '@codemirror/commands'
import { getCM, Vim, vim, type CodeMirrorV } from '@replit/codemirror-vim'

// Текущий Vim-режим редактора — см. одноимённый тип в Overlay.tsx: только
// 'normal'/'insert' участвуют в решениях, остальные ('replace'/'visual')
// просто отображаются как есть в бейдже.
export type VimMode = string

// ЛИНЕЙНАЯ НАВИГАЦИЯ (дополнение к брифу главного окна, применяется к обоим
// редакторам). Пользователь надиктовывает длинные пассажи и хочет двигаться
// по ним построчно в Vim, но текст должен вставляться ОДНОЙ строкой — если
// только пользователь сам не поставил перенос явно.
//
// Решение структурное, а не через вставку и отслеживание "автоматических"
// переносов: маркеры расходятся с текстом при первой же правке (dd/p), и
// различие становится ненадёжным. Вместо этого:
//
//  - текст остаётся ОДНОЙ логической строкой, редактор переносит её визуально
//    (EditorView.lineWrapping ниже);
//  - j/k переопределены на gj/gk, 0/$ — на g0/g$: это движение по ЭКРАННОЙ
//    строке вместо логической, так что навигация ощущается построчной, хотя
//    строка в документе одна;
//  - перенос, который поставил сам пользователь (o, Enter в insert режиме) —
//    обычный символ '\n' в документе, ничем не помечен и не отличается от
//    остального текста. Вставлять/вычищать при копировании нечего: у
//    автоматических переносов просто нет символьного представления.
//
// Проверено по исходнику пакета: @replit/codemirror-vim — плоская обёртка
// над CodeMirror 6, реальный keymap лежит в его зависимости
// @replit/codemirror-vim-core (node_modules/@replit/codemirror-vim-core/vim.js):
//   строка 116: { keys: 'j', motion: 'moveByLines', motionArgs: { linewise: true } }
//   строка 118: { keys: 'gj', motion: 'moveByDisplayLines', ... }
//   строка 119: { keys: 'gk', motion: 'moveByDisplayLines', ... }
//   строка 138: { keys: 'g$', motion: 'moveToEndOfDisplayLine' }
//   строка 140: { keys: 'g0', motion: 'moveToStartOfDisplayLine' }
// — то есть j/k и gj/gk, 0/$ и g0/g$ действительно два РАЗНЫХ семейства
// моушенов (логическая строка документа vs видимая на экране), не синонимы.
// С одной логической строкой в документе moveByLines(j/k)/moveToStartOfLine(0)
// естественно ходить некуда — навигация имеет смысл только через
// moveByDisplayLines/moveTo{Start,End}OfDisplayLine (gj/gk/g0/g$).
//
// `Vim.noremap(lhs, rhs, ctx)` — штатный публичный API пакета (строка 832 в
// том же файле) для нерекурсивного ремапа существующей комбинации на другую
// существующую; это НЕ то же самое, что `Vim.defineAction`/`Vim.mapCommand`
// (те определяют НОВЫЕ команды, как используется ниже в Overlay.tsx для
// <CR>/<Esc>) — здесь нужен именно ремап, потому что gj/gk/g0/g$ уже
// существуют как штатные моушены.
let lineNavigationRemapped = false
export function ensureLineNavigationRemap() {
  if (lineNavigationRemapped) return
  lineNavigationRemapped = true
  // 'noremap', а не 'map' — исключает случайную рекурсию, если что-то ещё
  // (сейчас ничего) когда-нибудь тоже переопределит gj/gk.
  for (const ctx of ['normal', 'visual'] as const) {
    Vim.noremap('j', 'gj', ctx)
    Vim.noremap('k', 'gk', ctx)
    Vim.noremap('0', 'g0', ctx)
    Vim.noremap('$', 'g$', ctx)
  }
}

/** Общие расширения редактора транскрипта. `onDocChanged` — узкий колбэк
 *  "есть ли текст", а не полный текст на каждое нажатие: оба окна используют
 *  CodeMirror как единственный источник истины и читают doc напрямую в
 *  момент действия (Paste/Copy/запуск действия меню), не через React state
 *  на каждый символ (см. Overlay.tsx/MainWindow.tsx).
 *
 *  `onDocText` — тот же слушатель, но с полным текстом; нужен ТРЕТЬЕМУ
 *  пользователю редактора — полю словаря в настройках (DictionaryField.tsx).
 *  Там читать документ «в момент действия» нельзя: кнопка Save живёт в
 *  подвале окна, снаружи раздела, а раздел при переключении на соседний
 *  размонтируется вместе с редактором — текст к моменту нажатия Save уже
 *  уничтожен. Поэтому словарь (и только он) зеркалит документ в состояние
 *  React. Оверлей и главное окно этот колбэк не передают и продолжают жить
 *  по-старому. */
export function transcriptEditorExtensions(opts: {
  onDocChanged?: (hasText: boolean) => void
  onDocText?: (text: string) => void
  placeholderText?: string
}): Extension[] {
  ensureLineNavigationRemap()
  const extensions: Extension[] = [
    vim(),
    // drawSelection()/history()/allowMultipleSelections были упущены при
    // первой сборке списка расширений — без них визуальный режим и undo
    // выглядели "сломанными", хотя vim.js исправно вёл своё внутреннее
    // состояние. Разобрано и проверено по исходнику пакетов:
    //
    // drawSelection() — @replit/codemirror-vim (node_modules/@replit/
    // codemirror-vim/dist/index.js, themeSpec/hideNativeSelection, строка
    // ~1197) сам гасит НАТИВНОЕ выделение браузера в vim-режиме: `.cm-vimMode
    // .cm-line ::selection { background: transparent !important }`. Это
    // сделано намеренно — блочный курсор normal-режима несовместим с родным
    // rendering'ом selection. Без drawSelection() красить выделение
    // становится больше нечему: `.transcript-field .cm-selectionBackground`
    // в styles.css уже ждёт этот элемент (rgba(10,132,255,.35)), но пакет,
    // который его создаёт, в списке отсутствовал. Сама visual-mode машина
    // (диапазон выделения, `v`/`d`/`y`/`x`/`p`) работала всё это время —
    // просто результат был невидим.
    drawSelection(),
    // history() — @codemirror/commands. codemirror-vim не идёт через
    // CodeMirror-овский keymap для undo/redo: `u` вызывает
    // CodeMirror.commands.undo (node_modules/@replit/codemirror-vim/dist/
    // index.js, строка ~769), которая делает `runHistoryCommand(cm, true)` →
    // напрямую дергает `undo(cm.cm6)`, импортированный из
    // '@codemirror/commands' (строка 7 того же файла) — то есть вызывает
    // command-функцию как есть, а не через keymap-биндинг. Проверено по
    // node_modules/@codemirror/commands/dist/index.js: `undo`/`redo` читают
    // `state.field(historyField_, false)` — второй аргумент `false` значит
    // "не кидать, если поля нет, вернуть undefined" (строка ~289), и тогда
    // функция просто ничего не делает — без исключения, без лога, именно
    // симптом из репорта ("u ничего не делает"). historyKeymap НЕ нужен:
    // раз вызов идёт напрямую по ссылке на функцию, а не через
    // `keymap.of(...)`, CodeMirror-овские биндинги (обычно Mod-z/Mod-y) для
    // работы vim-овского `u`/`Ctrl-r` не требуются — добавлять их значило бы
    // тянуть Mod-z поверх уже работающего vim-биндинга без причины.
    history(),
    // allowMultipleSelections — visual block (Ctrl-V) и множественные
    // курсоры в vim.js реализованы как несколько CodeMirror-диапазонов
    // выделения одновременно; без этого флага CodeMirror схлопывает любое
    // multi-range выделение до одного диапазона, и блочный visual молча
    // деградирует до обычного charwise.
    EditorState.allowMultipleSelections.of(true),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ spellcheck: 'false' }),
  ]
  if (opts.placeholderText !== undefined) extensions.push(placeholder(opts.placeholderText))
  extensions.push(
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) return
      opts.onDocChanged?.(update.state.doc.length > 0)
      // toString() только когда колбэк реально передан: у оверлея и главного
      // окна на каждое нажатие клавиши материализовывать весь документ
      // незачем.
      if (opts.onDocText) opts.onDocText(update.state.doc.toString())
    })
  )
  return extensions
}

/** Создаёт EditorView с общими расширениями транскрипта поверх заданного
 *  контейнера. Единственная разница между оверлеем и главным окном —
 *  Enter/Escape-экшены оверлея (Paste/Close) — остаётся в Overlay.tsx,
 *  потому что специфична именно ему.
 *
 *  `doc` — начальное содержимое; по умолчанию пусто, как было у обоих окон
 *  транскрипта (текст туда приходит позже, событием). Словарь настроек,
 *  наоборот, открывается уже заполненным, и подставлять его вторым шагом
 *  через `resetEditorContent` нельзя: это правка документа, она разбудила бы
 *  `onDocText` и пометила настройки изменёнными в момент открытия раздела. */
export function createTranscriptEditor(
  parent: HTMLElement,
  opts: {
    onDocChanged?: (hasText: boolean) => void
    onDocText?: (text: string) => void
    placeholderText?: string
    doc?: string
  }
): EditorView {
  return new EditorView({
    state: EditorState.create({ doc: opts.doc ?? '', extensions: transcriptEditorExtensions(opts) }),
    parent,
  })
}

/** Заменяет содержимое редактора целиком и гарантированно возвращает Vim в
 *  normal-режим — используется и при очистке поля, и при подстановке нового
 *  текста (транскрипт, Follow, Accept/Cancel действия меню). Оба случая не
 *  должны наследовать insert/visual режим или курсор предыдущего цикла.
 *
 *  exitInsertMode/exitVisualMode двигают курсор и трогают внутреннее
 *  состояние vim исходя из предположения "мы сейчас в этом режиме" — вызывать
 *  их вслепую небезопасно, поэтому оба вызова под явной проверкой текущего
 *  режима. */
export function resetEditorContent(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
  })
  normalizeVimMode(view)
}

/** Возврат редактора в normal-режим — общая часть замены содержимого и
 *  дозаписи (см. `appendTranscript`).
 *
 *  `Vim.exitVisualMode(cm, false)` — второй аргумент (`moveHead`) обязателен
 *  именно `false`, а не дефолт. По умолчанию exitVisualMode переставляет
 *  курсор на `vim.sel.head` — собственную копию позиции, которую vim ведёт
 *  ПОКА обрабатывает свои же клавиши (visual-mode моушены). Наш dispatch
 *  выше приходит В ОБХОД этого механизма (обычный `view.dispatch`, а не
 *  `Vim.handleKey`), поэтому `vim.sel` на этот момент — снимок ДО правки,
 *  ссылающийся на позиции в старом документе. С дефолтным moveHead
 *  exitVisualMode тихо перезаписал бы курсор, который мы только что
 *  поставили (см. `appendTranscript`), этим самым стухшим снимком —
 *  ровно тот случай "выглядит как работающая фича, а на деле нет" из
 *  отчёта. `false` отключает этот перезаход: exitVisualMode выходит из
 *  режима, курсора не касается. Проверено по исходнику пакета
 *  (node_modules/@replit/codemirror-vim-core/vim.js, exitVisualMode —
 *  `if (moveHead !== false) cm.setCursor(...)`). */
function normalizeVimMode(view: EditorView) {
  const cm = getCM(view)
  if (cm?.state.vim?.visualMode) Vim.exitVisualMode(cm as CodeMirrorV, false)
  if (cm?.state.vim?.insertMode) Vim.exitInsertMode(cm as CodeMirrorV)
}

/** Переводит редактор в insert-режим программно, тем же путём, которым это
 *  делает нажатие `i` — `Vim.handleKey(cm, 'i', 'mapping')` — команда `i`
 *  ничего не удаляет и не меняет в тексте, только режим.
 *
 *  Единственный вызывающий — DictionaryField.tsx, и не переиспользуется в
 *  общем `createTranscriptEditor` для оверлея/главного окна: там NORMAL по
 *  умолчанию — сознательный выбор (Enter/Escape в normal-контексте отданы
 *  под Paste/Close через `Vim.mapCommand`, см. Overlay.tsx), и перевод в
 *  insert сразу при открытии сломал бы эти биндинги.
 *
 *  Здесь — наоборot: поле словаря выглядит как обычное текстовое поле
 *  настроек, соседствует с обычными input/textarea в том же окне, и ничего
 *  в интерфейсе не подсказывает, что первое нажатие клавиши по умолчанию
 *  уйдёт командой, а не текстом. Часть команд NORMAL-режима — не «ничего не
 *  произошло», а `dd`/`S`/`x`/`cc` — они меняют документ. На сиде из 71
 *  строки это ровно тот случай: обычный ввод в предположительно пустое поле
 *  тихо стирает несколько строк раньше, чем первый настоящий символ вообще
 *  попадёт в документ, и это уходит на диск по Save безвозвратно (истории
 *  undo редактора следующий запуск приложения уже не видит). Esc
 *  по-прежнему возвращает в NORMAL — dd/j/k/`/` для тех, кто их использует
 *  сознательно (см. соседний хинт в Settings.tsx), никуда не делись. */
export function enterInsertMode(view: EditorView) {
  const cm = getCM(view)
  if (cm) Vim.handleKey(cm, 'i', 'mapping')
}

/** Разделитель СЛЕВА от добавки — между текстом, что стоит ДО точки вставки
 *  (`before`), и самой добавкой. Пусто, если склеивать не с чем (перед
 *  точкой вставки ничего нет) или `before` уже кончается пробельным
 *  символом (включая перенос строки, который пользователь поставил сам): не
 *  создаём двойной пробел и не склеиваем слова. */
export function appendSeparator(before: string, addition: string): string {
  if (!before || !addition) return ''
  return /\s$/.test(before) ? '' : ' '
}

/** Зеркало `appendSeparator` — разделитель СПРАВА от добавки, между самой
 *  добавкой и текстом, что стоит ПОСЛЕ точки вставки (`after`). Та же логика,
 *  та же причина, другая сторона: пусто, если после точки вставки ничего
 *  нет (курсор в конце документа) или `after` уже НАЧИНАЕТСЯ пробельным
 *  символом. `addition` сюда приходит уже обрезанной по краям (см.
 *  `insertTranscriptAt`), поэтому проверять её конец на пробел не нужно —
 *  его там структурно не может быть. */
export function prependSeparator(after: string, addition: string): string {
  if (!after || !addition) return ''
  return /^\s/.test(after) ? '' : ' '
}

/** Что вставить в позицию курсора/выделения и куда после этого поставить
 *  каретку — чистая функция, вынесена из работы с редактором, чтобы
 *  поддавалась тесту без DOM. `from`/`to` — диапазон, который вставка
 *  заменяет (`from === to`, когда ничего не выделено, — обычный курсор;
 *  `from < to` — выделение, и оно заменяется целиком, а не раздвигается).
 *
 *  Раньше (`joinTranscript`) добавка всегда клеилась в конец документа,
 *  поэтому разделитель нужен был только один — со стороны уже
 *  накопленного текста. Вставка в произвольную точку ломает это
 *  допущение: слева от точки вставки и справа от неё — два РАЗНЫХ куска
 *  существующего текста, и у каждого свой сосед по добавке. Вставка
 *  между словами (например курсор в пробеле "привет | мир") и вставка в
 *  середину слова ("hello|world", пробелов нет ни слева, ни справа) не
 *  разведены веткой if — это один и тот же чек "не пробел ли уже там",
 *  просто гонится независимо в обе стороны через appendSeparator/
 *  prependSeparator.
 *
 *  Курсор после вставки — СРАЗУ ЗА добавленным куском (`add`), не считая
 *  правого разделителя: тот отделяет добавку от старого текста, а не
 *  является частью того, что надиктовал пользователь. Если этого не
 *  делать, а ставить каретку в конец `insert`, вторая дозапись подряд
 *  вставала бы ПЕРЕД пробелом-разделителем первой, а не после неё.
 *
 *  Добавка обрезается по краям: whisper отдаёт сегменты с ведущим
 *  пробелом, и без trim по обе стороны точки вставки копились бы двойные
 *  пробелы. Пустая (или состоящая из пробелов) добавка не должна трогать
 *  документ вообще — сигнал об этом: пустой `insert` и `cursor === from`
 *  (вызывающий код обязан пропустить dispatch, см. `appendTranscript`). */
export function insertTranscriptAt(
  existing: string,
  addition: string,
  from: number,
  to: number
): { insert: string; cursor: number } {
  const add = addition.trim()
  if (!add) return { insert: '', cursor: from }
  const before = existing.slice(0, from)
  const after = existing.slice(to)
  const leftSep = appendSeparator(before, add)
  const rightSep = prependSeparator(after, add)
  return { insert: leftSep + add + rightSep, cursor: from + leftSep.length + add.length }
}

/** Дописывает фрагмент в позицию курсора (или вместо выделения), ничего
 *  больше в документе не трогая.
 *
 *  Правки пользователя не теряются структурно, а не по договорённости:
 *  единственное изменение, которое уходит в редактор, — вставка в диапазон
 *  [from, to), а не полная замена документа (сравни с `resetEditorContent`,
 *  где `from: 0, to: doc.length`). Всё, что вне этого диапазона, dispatch
 *  вообще не видит.
 *
 *  `from`/`to` берутся из `view.state.selection.main` — ТЕКУЩЕГО состояния
 *  редактора в момент, когда пришла расшифровка, а не какого-то дефолта.
 *  Между началом записи и этим вызовом (см. rec:start в Overlay.tsx —
 *  ветка `append`) обработчики уровня/статуса/размера окна ни разу не
 *  делают dispatch в этот view, так что к моменту вставки здесь лежит
 *  именно то место, где пользователь остановился, — а не сброшенное в
 *  начало или в конец за время записи.
 *
 *  Раньше вставка всегда шла в конец документа (аргумент был — в Vim
 *  normal-режиме курсор стоит там, где человек последний раз навигировал,
 *  и вставка туда была бы неожиданной). Пользователь поработал с этим
 *  поведением и попросил обратное: вставлять туда, где стоит курсор —
 *  это и обжитый опыт весомее исходной теории, конец был лишь предсказуем,
 *  не удобен.
 *
 *  Пустая (или состоящая из пробелов) добавка не трогает документ вообще —
 *  ни выделение при этом не сбрасывается, ни курсор не двигается. */
export function appendTranscript(view: EditorView, addition: string) {
  const { from, to } = view.state.selection.main
  const { insert, cursor } = insertTranscriptAt(view.state.doc.toString(), addition, from, to)
  if (!insert) return
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: cursor },
  })
  // Тот же возврат в normal, что и у resetEditorContent, и по той же причине:
  // после появления нового текста режим предыдущего цикла наследовать нельзя.
  normalizeVimMode(view)
}

/** Подписка на смену Vim-режима (для бейджа NORMAL/INSERT). Возвращает
 *  функцию отписки. */
export function watchVimMode(view: EditorView, onModeChange: (mode: VimMode) => void): () => void {
  const cm = getCM(view)
  const handler = (mode: { mode: string }) => onModeChange(mode.mode)
  cm?.on('vim-mode-change', handler)
  return () => cm?.off('vim-mode-change', handler)
}

/** Ждёт ли vim СЕЙЧАС аргумент-моушен для оператора (`d`, `c`, `y`, `>`...
 *  уже нажаты, стрелка/hjkl — следующая клавиша, которую он проглотит как
 *  свой аргумент). Нужна главному окну (см. arrow-routing.ts): пока такой
 *  оператор висит, `vim-mode-change` НЕ шлёт отдельного режима — `mode`
 *  остаётся `'normal'`, хотя стрелка сейчас принадлежит редактору, а не
 *  списку действий сверху.
 *
 *  Проверено по исходнику пакета (@replit/codemirror-vim-core/vim.js):
 *  `inputState.operator` — то самое поле, которое движок сам читает, решая,
 *  в каком контексте клавиш он сейчас находится (`context = "operatorPending"`,
 *  см. функцию, строящую keymap-контекст) — не догадка о частностях
 *  реализации, а то же самое условие, что использует сам vim. */
export function hasPendingVimOperator(view: EditorView | null): boolean {
  if (!view) return false
  const cm = getCM(view)
  return !!cm?.state.vim?.inputState?.operator
}
