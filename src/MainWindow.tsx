import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { EditorView } from '@codemirror/view'
import {
  createTranscriptEditor,
  resetEditorContent,
  watchVimMode,
  hasPendingVimOperator,
  type VimMode,
} from './transcript-editor'
import { arrowsControlList } from './arrow-routing'
import {
  rootMenuState,
  currentLevel,
  currentLevelLabel,
  enterNode,
  goBack,
  isRoot,
  menuDepth,
  moveSelectionDown,
  moveSelectionUp,
  resetSelectionForLevel,
  clampSelectionIndex,
  branchPathIds,
  type MenuState,
} from './menu-state'
import {
  buildActionTree,
  DEFAULT_TRANSLATE_LANGUAGES,
  type LeafNode,
  type PromptNode,
} from './action-tree'
import {
  buildColumnItems,
  resolveRecentActions,
  toRecentAction,
  type ColumnItem,
  type RecentAction,
  type ResolvedRecentAction,
} from './recent-actions'
import {
  idleApplyState,
  startRequest,
  receiveResult,
  receiveError,
  isCurrentError,
  cancelApply,
  acceptApply,
  type ApplyState,
} from './apply-state'
import { panelGuard, panelTabStop, livePanelKey, nextFocusTarget } from './panel-focus'
import {
  runAiAction,
  cancelAiAction,
  openSettingsWindow,
  getSettings,
  getSourceApp,
  hideMainWindow,
  checkAccessibilityPermission,
  copyText,
  pasteText,
  openPrivacyPane,
  listRecentActions,
  touchRecentAction,
  forgetRecentAction,
  type HistoryEntry,
  type Settings,
  type SourceApp,
  type PasteFormat,
} from './api'
import { HistoryView } from './HistoryView'
import {
  DEFAULT_ACCEPT_SHORTCUT,
  DEFAULT_ACTION_SHORTCUTS,
  ESCAPE_SHORTCUT,
  nodeForKey,
  quickIndexForKey,
  quickShortcutFor,
  shortcutFor,
  type ActionShortcuts,
} from './action-shortcuts'
import { formatShortcutBadge, matchesShortcut } from './shortcut'

// Дефолт хоткея Paste главного окна — дублирует Settings::default() на
// бэкенде (src-tauri/src/settings.rs), как и DEFAULT_ACTION_SHORTCUTS рядом:
// заглушка до первого ответа get_settings, дальше её перекрывает настройка.
const DEFAULT_MAIN_PASTE_SHORTCUT = 'Super+Enter'
const DEFAULT_MAIN_COPY_SHORTCUT = 'Super+KeyC'

type FollowPayload = { text: string; wasRich: boolean }

// Три кнопки выбора формата. Это UI-уровень; в команду вставки они переводятся
// через toPasteCommandFormat ниже (api.ts знает только verbatim/plain/rich).
type PasteChoice = 'rich' | 'markdown' | 'plain'
const PASTE_FORMAT_KEY = 'slaive.pasteFormat'
// Дефолт 'rich': раз выделение было с разметкой, скорее всего её хотят живой обратно.
const DEFAULT_PASTE_CHOICE: PasteChoice = 'rich'
const PASTE_CHOICES: { id: PasteChoice; label: string }[] = [
  { id: 'rich', label: 'Rich' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'plain', label: 'Plain' },
]

// 'markdown' = отдать Markdown-исходник как есть, то есть команде это
// 'verbatim' (писать текстом, без конвертации). 'rich'/'plain' — одноимённо.
const toPasteCommandFormat = (choice: PasteChoice): PasteFormat =>
  choice === 'markdown' ? 'verbatim' : choice

// Подписи строки с Undo. Две, потому что причины замены разные, и «откуда
// взялся этот текст» — единственное, что здесь нужно объяснить.
const HISTORY_NOTICE = 'Loaded from history. The text that was here has been replaced.'
const NEW_TEXT_NOTICE = 'New text arrived. The text that was here has been replaced.'

/** Главное окно: текст сверху (неподвижная часть интерфейса — см. бриф), под
 *  ним многоуровневое меню действий (Translate/Ask AI/Fix/Shorten/Summarize), каждое
 *  из которых уходит в ИИ-провайдер через run_ai_action ТОЛЬКО по явному
 *  нажатию. Единственный способ получить текст в это окно — событие
 *  Follow из оверлея (см. follow:text ниже); само окно ничего не
 *  запрашивает и не отправляет само по себе. */
export function MainWindow() {
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // hasText — единственный кусочек содержимого редактора, который нужен
  // React'у: включает/выключает действия меню (см. бриф: "Пустой текст —
  // действия недоступны"). Сам текст CodeMirror держит как единственный
  // источник истины — тот же приём, что в Overlay.tsx.
  const [hasText, setHasText] = useState(false)
  const [vimMode, setVimMode] = useState<VimMode>('normal')

  // Было ли у пришедшего текста форматирование (rich-захват). Только тогда
  // показываем выбор формата вставки; диктовка и текст без разметки приходят с
  // false и вставляются как есть, без лишних кнопок. Приходит в follow:text.
  const [wasRich, setWasRich] = useState(false)
  // Выбор формата, запомненный между вызовами. Читаем localStorage один раз;
  // битое/чужое значение отбрасываем к дефолту.
  const [pasteChoice, setPasteChoice] = useState<PasteChoice>(() => {
    try {
      const saved = localStorage.getItem(PASTE_FORMAT_KEY)
      if (saved && PASTE_CHOICES.some((c) => c.id === saved)) return saved as PasteChoice
    } catch {
      // приватное окно / заблокированный storage — молча на дефолт
    }
    return DEFAULT_PASTE_CHOICE
  })
  const chooseFormat = (choice: PasteChoice) => {
    setPasteChoice(choice)
    try {
      localStorage.setItem(PASTE_FORMAT_KEY, choice)
    } catch {
      // не сохранилось — не беда, в этой сессии выбор всё равно действует
    }
  }

  // Языки перевода — настройка, а не константа: из неё строится подменю
  // Translate (см. action-tree.ts). Держим сырую строку настройки, а дерево
  // пересобираем только когда она изменилась — иначе каждое settings:changed
  // (смена хоткея, ключа провайдера) давало бы новый массив узлов и сбрасывало
  // бы меню в корень на ровном месте.
  const [rawLanguages, setRawLanguages] = useState(DEFAULT_TRANSLATE_LANGUAGES)
  const actionTree = useMemo(() => buildActionTree(rawLanguages), [rawLanguages])
  // Слушатель follow:text навешен один раз на монтировании и замыкает значения
  // того рендера — дерево ему нужно через ref, иначе после правки языков он
  // сбрасывал бы меню в корень УСТАРЕВШЕГО дерева. Остальные обработчики
  // пересоздаются на каждый рендер и читают `actionTree` напрямую.
  const actionTreeRef = useRef(actionTree)
  actionTreeRef.current = actionTree

  const [menuState, setMenuState] = useState<MenuState>(() => rootMenuState(actionTree))
  // Список языков поменяли — состав кнопок другой, и стек меню держит ссылку
  // на прежнее дерево. Возврат в корень нового дерева: остаться на уровне,
  // которого больше нет, нельзя, а угадывать соответствие старых пунктов новым
  // незачем.
  useEffect(() => {
    setMenuState(rootMenuState(actionTree))
  }, [actionTree])
  const [applyState, setApplyState] = useState<ApplyState>(idleApplyState)
  const [actionError, setActionError] = useState<string | null>(null)
  // Временное «Copied» на кнопке копирования — как в Overlay.tsx.
  const [copied, setCopied] = useState(false)
  const [promptQuery, setPromptQuery] = useState('')

  // Недавно выполненные действия — три верхних пункта корня меню, по которым
  // то же самое вызывается одним нажатием, без прохода по уровням. Лежат на
  // диске рядом с историей расшифровок (см. recent_actions.rs), поэтому
  // читаются один раз на монтировании: окно между вызовами не пересоздаётся,
  // а дальше список приходит ОТВЕТОМ на каждое изменение (touch/forget
  // возвращают получившийся порядок) — второй ходки за ним не нужно.
  //
  // Хранится путь плюс параметр, без подписи; подпись собирается по живому
  // дереву (см. recent-actions.ts), поэтому правка списка языков в настройках
  // автоматически убирает из быстрого списка язык, которого больше нет.
  const [recentActions, setRecentActions] = useState<RecentAction[]>([])
  useEffect(() => {
    listRecentActions()
      .then(setRecentActions)
      // Нет файла или он не читается — список просто пуст. Поднимать из-за
      // этого баннер над текстом незачем: ни одно действие от списка не
      // зависит, все кнопки меню на месте.
      .catch(() => setRecentActions([]))
  }, [])
  const resolvedRecent = useMemo(
    () => resolveRecentActions(actionTree, recentActions),
    [actionTree, recentActions]
  )

  // Столбец меню действий, переключаемый стрелками (бриф: "все кнопки в
  // меню... столбец... переключать стрелочками вверх и вниз", то же для
  // языков Translate). Индекс — не часть MenuState (см. menu-state.ts): он
  // не про то, где в дереве стоит пользователь, а про то, какая кнопка
  // ТЕКУЩЕГО уровня подсвечена. Переходы (вниз/вверх/сброс на новом уровне)
  // — чистые функции оттуда, проверенные без DOM; здесь только хранение и
  // клавиши.
  const [selectedIndex, setSelectedIndex] = useState(0)
  // Контейнер списка — ЕДИНСТВЕННЫЙ tab-стоп уровня (aria-activedescendant
  // паттерн listbox, см. отчёт): сами кнопки получают tabIndex={-1} и не
  // участвуют в обходе Tab по отдельности. Ref переживает смену уровня (тот
  // же DOM-узел не пересоздаётся React между рендерами одного уровня —
  // пересоздаётся только при смене key у .mw-panel, см. ниже), поэтому
  // .focus() из эффекта ниже всегда бьёт по актуальному контейнеру. Держится
  // это на одном условии, и оно проверяется в renderIdlePanel ниже: ref
  // принадлежит ТОЛЬКО живой панели, а не снимку уезжающей.
  const gridRef = useRef<HTMLDivElement | null>(null)
  // Достаются ли сейчас стрелки/Home/End списку БЕЗ настоящего DOM-фокуса на
  // нём (см. arrow-routing.ts и отчёт) — общая проверка для столбца действий
  // здесь и для сетки истории в HistoryView (передаётся туда пропом ниже).
  // Пересчитывается на каждое нажатие, а не запоминается в состоянии:
  // hasPendingVimOperator читает внутренности vim, которые меняются БЕЗ
  // ре-рендера React, — застывшее значение из прошлого рендера могло бы
  // соврать про то, ждёт ли редактор аргумент оператора прямо сейчас.
  const arrowsAvailable = () => arrowsControlList(vimMode, hasPendingVimOperator(viewRef.current))
  // Поле свободного запроса Ask AI — та же роль в фокус-цикле, что у
  // gridRef: единственное место, куда стоит вернуть фокус после Enter на
  // ветке Ask AI в списке действий, иначе клавиатурный путь обрывался бы
  // ровно на этой одной ветке (у остальных пунктов корня либо запускается
  // действие сразу, либо открывается точно такой же список — подменю
  // Translate).
  const promptInputRef = useRef<HTMLInputElement | null>(null)
  // Панель Accept/Cancel/Working — третье и последнее место фокус-цикла
  // окна: пока она на экране, списка нет вовсе, и без неё фокус оставался в
  // <body> (см. nextFocusTarget в panel-focus.ts — там же довод, почему
  // целью выбрана панель, а не кнопка на ней). Ref один на обе фазы: pending
  // и proposed исключают друг друга, в стопке всегда ровно одна из этих
  // панелей, и снимков с них не делается — та беда с ref'ом, что была у
  // уровней меню, здесь невозможна по построению.
  const applyPanelRef = useRef<HTMLDivElement | null>(null)
  // Был ли фокус ВНУТРИ нижней области окна — списка, поля Ask AI или
  // панели применения — непосредственно перед тем, как живая панель
  // сменилась (провал в Translate, возврат Back, запуск действия,
  // завершение действия в корень). React убирает старую .mw-panel из
  // дерева, а удаление сфокусированного узла НЕ порождает событие blur
  // (стандартное поведение DOM) — ref, а не state, поэтому и остаётся true
  // сквозь такое удаление, ровно то состояние, которое нужно эффекту ниже.
  // Обычный уход фокуса (Tab на Paste, клик по полю текста) блюром
  // сбрасывает его как положено.
  //
  // Переход фокуса МЕЖДУ панелью и кнопкой внутри неё флаг не сбрасывает, и
  // это не случайность: onFocus/onBlur в React — это focusin/focusout, они
  // всплывают, поэтому за blur контейнера немедленно приходит focus от
  // ребёнка, и итоговое значение остаётся true.
  const menuHadFocusRef = useRef(false)
  // Модальный слой «нет права на вставку» — тот же, что в оверлее, и по той
  // же причине: право одно на оба окна (Accessibility), отказ одинаков, и
  // показывается он СРАЗУ по нажатию Paste, а не после заведомо провальной
  // попытки (см. onPaste ниже).
  const [showAccessModal, setShowAccessModal] = useState(false)

  // История расшифровок занимает место дерева действий в нижней области окна
  // (см. JSX ниже). Верхняя область с текстом при этом остаётся на экране:
  // это неподвижная часть интерфейса (бриф главного окна), и видеть, что
  // именно будет заменено, полезнее, чем на секунду её прятать.
  const [showHistory, setShowHistory] = useState(false)
  // Что лежало в редакторе ДО того, как туда положили другой текст: запись из
  // истории или новый текст извне (диктовка по Follow, захват выделения по
  // глобальному хоткею). Замена задумана в обоих случаях, но человек мог
  // полчаса править надиктованное руками, и «задумано» не оправдывает
  // молчаливую потерю этой работы.
  //
  // С приходом захвата это перестало быть краем: раньше чужой текст попадал
  // сюда только по явному нажатию Follow, а теперь — по глобальному хоткею,
  // из любого приложения, когда главное окно даже не на виду.
  //
  // Спрашивать подтверждение перед каждой заменой нельзя: текст в редакторе
  // есть почти всегда (в это окно иначе и не попадают), диалог выскакивал бы
  // на каждое нажатие плитки и через день перестал бы читаться. Поэтому
  // замена происходит сразу, а рядом остаётся строка с кнопкой Undo, которая
  // кладёт прежний текст обратно ПОБАЙТОВО — тот же приём и та же гарантия,
  // что у Cancel в цикле действий ИИ (см. `original` в apply-state.ts).
  //
  // Не полагаемся на undo самого редактора (vim `u` замену тоже откатывает,
  // история изменений у CodeMirror общая на весь документ): про него надо
  // знать, он требует normal-режима и фокуса в поле, и проверить его можно
  // только руками в живом приложении. Собственный снимок работает по
  // построению.
  // Текст и подпись едут вместе: две разные причины замены объясняются
  // по-разному, а расходиться между собой они не должны.
  const [replaced, setReplaced] = useState<{ text: string; message: string } | null>(null)

  // Хоткеи действий — ОКОННЫЕ, не глобальные (см. action-shortcuts.ts):
  // обычный keydown ниже, никакого tauri-plugin-global-shortcut. В состоянии,
  // а не в константе, потому что бейдж на кнопке рисуется из настройки и
  // обязан перерисоваться, когда её поменяли: главное окно между вызовами не
  // пересоздаётся (прячется/показывается), поэтому значения грузятся один раз
  // на mount и дальше обновляются событием settings:changed — тот же приём,
  // что у Paste/Copy в Overlay.tsx.
  const [actionShortcuts, setActionShortcuts] = useState<ActionShortcuts>(DEFAULT_ACTION_SHORTCUTS)
  // Хоткей Paste — отдельным состоянием, а не пятым полем ActionShortcuts:
  // тот тип описывает ровно узлы дерева действий (ActionShortcutKey), а Paste
  // не действие меню и в дереве его нет. Грузится и обновляется тем же
  // эффектом — источник настроек один.
  const [mainPasteShortcut, setMainPasteShortcut] = useState(DEFAULT_MAIN_PASTE_SHORTCUT)
  // Copy — как Paste выше: действие над готовым текстом, не узел дерева.
  const [mainCopyShortcut, setMainCopyShortcut] = useState(DEFAULT_MAIN_COPY_SHORTCUT)
  // Accept — по той же причине отдельным состоянием, что и Paste выше: это не
  // узел дерева действий, а шаг цикла применения (см. apply-state.ts).
  const [acceptShortcut, setAcceptShortcut] = useState(DEFAULT_ACCEPT_SHORTCUT)
  useEffect(() => {
    const take = (s: Settings): ActionShortcuts => ({
      translateShortcut: s.translateShortcut,
      askAiShortcut: s.askAiShortcut,
      generateShortcut: s.generateShortcut,
      fixShortcut: s.fixShortcut,
      shortenShortcut: s.shortenShortcut,
      summarizeShortcut: s.summarizeShortcut,
    })
    const apply = (s: Settings) => {
      setActionShortcuts(take(s))
      setMainPasteShortcut(s.mainPasteShortcut)
      setMainCopyShortcut(s.mainCopyShortcut)
      setAcceptShortcut(s.acceptShortcut)
      // Строка, а не разобранный список: разбор и запасной дефолт живут в
      // одном месте (buildActionTree), а сравнение "поменялось ли" здесь
      // сводится к сравнению строк — новый массив узлов появляется только
      // когда пользователь реально правил список.
      setRawLanguages(s.translateLanguages)
    }
    getSettings().then(apply)
    const un = listen<Settings>('settings:changed', (e) => apply(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Приложение-источник: то же самое, что показывает шапка оверлея, и тот же
  // PID (prev_app_pid), в который вставляет paste_text. `undefined` — ответа
  // ещё нет (шапка молчит, чтобы не мигнуть «нет цели» и тут же сменить это
  // на имя приложения), `null` — цели нет и Paste недоступен.
  const [sourceApp, setSourceApp] = useState<SourceApp | null | undefined>(undefined)
  const refreshSourceApp = () => {
    getSourceApp()
      .then(setSourceApp)
      .catch(() => setSourceApp(null))
  }
  // Запрашиваем на монтировании, на каждый Follow (см. ниже) и на возврат
  // фокуса в окно: окно между вызовами не пересоздаётся (прячется/
  // показывается), а цель за это время могла смениться — пользователь мог
  // надиктовать из другого приложения или закрыть то, что было запомнено.
  // Возврат фокуса — единственный момент, когда он снова смотрит на шапку.
  useEffect(() => {
    refreshSourceApp()
    window.addEventListener('focus', refreshSourceApp)
    return () => window.removeEventListener('focus', refreshSourceApp)
  }, [])

  // Монотонный счётчик — каждому запуску действия свой requestId, чтобы
  // устаревший ответ (после Cancel или после запуска следующего действия) не
  // перезаписал текст, к которому он уже не относится (см. apply-state.ts).
  const requestIdRef = useRef(0)

  // Зеркало applyState для обработчика follow:text: подписка вешается один
  // раз (deps []), и обычная переменная состояния в её замыкании навсегда
  // осталась бы первой, то есть idle, — а решать надо по текущей фазе.
  // Синхронизируем эффектом, а не присваиванием в теле рендера: эффекты
  // успевают отработать до любого события из Tauri.
  const applyStateRef = useRef(applyState)
  useEffect(() => {
    applyStateRef.current = applyState
  }, [applyState])

  useEffect(() => {
    const parent = editorContainerRef.current
    if (!parent) return
    const view = createTranscriptEditor(parent, {
      onDocChanged: setHasText,
      placeholderText: '—',
    })
    viewRef.current = view
    const unwatch = watchVimMode(view, setVimMode)
    return () => {
      unwatch()
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // Текст извне: Follow из оверлея и захват выделения по глобальному хоткею.
  // Новый текст — новый цикл: меню в корень, состояние применения сброшено,
  // форма Ask AI очищена — тот же принцип "новый цикл, чистый лист", что у
  // rec:start в Overlay.tsx. Приходит и когда окно только что показано Rust'ом
  // (show_main_window), и когда оно уже было открыто и просто поднимается
  // наверх — в обоих случаях второе окно не плодится (см. follow_to_main_window).
  useEffect(() => {
    const un = listen<FollowPayload>('follow:text', (e) => {
      const view = viewRef.current
      const previous = view?.state.doc.toString() ?? ''
      // Запрос к ИИ, запущенный для ПРЕЖНЕГО текста, к новому отношения не
      // имеет: applyState сейчас сбросится, и ответу будет некуда лечь.
      // Рвём его, а не оставляем идти вхолостую до конца — за него платят.
      // При phase==='proposed' ответ уже пришёл, будить некого (notify_waiters
      // на стороне Rust безопасен, когда никто не ждёт), — то же решение,
      // что у onCancel ниже.
      if (applyStateRef.current.phase === 'pending') void cancelAiAction()
      if (view) resetEditorContent(view, e.payload.text)
      // Форматирование у нового текста могло появиться или пропасть — выбор
      // формата показываем/прячем по этому флагу (см. mw-source-row ниже).
      setWasRich(e.payload.wasRich)
      setMenuState(rootMenuState(actionTreeRef.current))
      setApplyState(idleApplyState())
      setActionError(null)
      setPromptQuery('')
      // Новый текст — новый цикл: история закрывается.
      setShowHistory(false)
      // А вот прежний текст не теряется. До захвата сюда попадали только по
      // явному нажатию Follow, то есть намеренно; теперь текст прилетает по
      // глобальному хоткею из чужого приложения, и в редакторе в этот момент
      // могут лежать получасовые правки или предложение модели на экране.
      // Строка с Undo — та же гарантия и тот же побайтовый откат, что у
      // замены из истории; терять было нечего только у пустого редактора.
      setReplaced(previous.trim() ? { text: previous, message: NEW_TEXT_NOTICE } : null)
      // Текст новый — возможно, и приложение, из которого он пришёл, тоже
      // другое. Шапку и доступность Paste перечитываем на каждый приход
      // текста, а не один раз на монтировании.
      refreshSourceApp()
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Синхронизация редактора с proposed: НЕ делается инлайн в обработчике
  // промиса run_ai_action (там могла бы дважды выполниться сторонняя работа
  // под React.StrictMode, которое в dev нарочно дважды зовёт updater-функции
  // setState) — вместо этого эффект реагирует на смену applyState.proposed
  // и синхронизирует редактор ровно один раз на каждое новое значение,
  // отслеживая последнее применённое через ref.
  const lastSyncedProposedRef = useRef<string | null>(null)
  useEffect(() => {
    if (applyState.phase === 'proposed' && lastSyncedProposedRef.current !== applyState.proposed) {
      lastSyncedProposedRef.current = applyState.proposed
      const view = viewRef.current
      if (view) resetEditorContent(view, applyState.proposed)
    }
    if (applyState.phase === 'idle') {
      lastSyncedProposedRef.current = null
    }
  }, [applyState])

  const currentText = () => viewRef.current?.state.doc.toString() ?? ''

  const runRequest = (system: string, user: string) => {
    const id = ++requestIdRef.current
    const original = currentText()
    setApplyState(startRequest(original, id))
    setActionError(null)
    // С текстом начали работать — предложение вернуть то, что было до
    // замены, дальше только мешало бы: откатывать теперь есть куда и без
    // него (Cancel), а строка внизу относилась бы к позапрошлому состоянию.
    setReplaced(null)
    runAiAction(system, user)
      .then((result) => {
        setApplyState((prev) => receiveResult(prev, id, result))
      })
      .catch((e) => {
        // "Cancelled." приходит сюда же, что и настоящий отказ провайдера:
        // и follow:text, и onCancel рвут запрос через cancelAiAction(), и
        // run_ai_action на этом возвращает Err("Cancelled."), а промис здесь
        // — тот же самый, что у .then выше, catch общий на оба пути. Раньше
        // баннер рисовался безусловно, и получалось "Cancelled." под
        // текстом, который на самом деле пришёл верным: ни одна из этих
        // отмен не была неудачей.
        //
        // isCurrentError — та же проверка requestId, что внутри
        // receiveResult/receiveError (см. apply-state.ts), только без
        // побочного перехода состояния: нужно решить, рисовать ли баннер,
        // ДО того как applyState перейдёт в idle. applyStateRef, а не
        // замыкание рендера, которому принадлежит этот `.catch`, — та же
        // причина, по которой follow:text ниже читает его же: к моменту,
        // когда ответ долетел, могло пройти сколько угодно рендеров.
        const isCurrent = isCurrentError(applyStateRef.current, id)
        setApplyState((prev) => receiveError(prev, id))
        if (isCurrent) setActionError(String(e))
      })
  }

  // Запоминание выполненного действия. Молча, без баннера: само действие уже
  // пошло к провайдеру, список быстрого вызова — удобство поверх него, и
  // сообщать об неудачной записи файла поверх текста, с которым человек
  // прямо сейчас работает, значило бы перебить главное второстепенным.
  // Следующее действие попробует снова. В консоль тоже ничего: в запросе
  // лежит личный текст (см. recent-actions.ts).
  const remember = (action: RecentAction) => {
    touchRecentAction(action.path, action.query)
      .then(setRecentActions)
      .catch(() => {})
  }

  /**
   * ЕДИНСТВЕННЫЙ путь запуска действия — им идут все точки входа: клик по
   * кнопке, Enter в столбце, хоткей, форма Ask AI и пункт быстрого вызова.
   * Быстрое действие не получает второго пути исполнения: тот же узел, тот же
   * запрос к модели, тот же цикл «предложено → принять или отменить».
   *
   * `branchIds` — ветки, через которые пришли (см. branchPathIds): вместе с
   * узлом они и составляют путь, который запоминается. Запоминаем В МОМЕНТ
   * ЗАПУСКА, а не после Accept: список отвечает на вопрос «к чему я тянусь»,
   * и действие, отменённое из-за неудачного предложения, — ровно то, которое
   * повторят. Действие, выполненное из быстрого списка, тем же вызовом
   * поднимается в нём наверх, а не исключается из него.
   */
  const runNode = (target: LeafNode | PromptNode, query: string, branchIds: string[]) => {
    if (applyState.phase !== 'idle') return
    if (!hasText && !target.worksOnEmpty) return
    // Обычному prompt-действию (Ask AI) нужны и текст, и запрос; узел с
    // worksOnEmpty (Generate) запускается с любым их сочетанием, включая
    // полностью пустое — «сгенерировать с нуля».
    if (target.kind === 'prompt' && !target.worksOnEmpty && !query) return
    const { system, user } =
      target.kind === 'leaf'
        ? target.buildRequest(currentText())
        : target.buildRequest(currentText(), query)
    remember(toRecentAction(branchIds, target, query))
    runRequest(system, user)
  }

  const onLeafClick = (node: LeafNode) => runNode(node, '', branchPathIds(menuState))

  const onPromptSubmit = () => {
    const prompt = menuState.prompt
    if (!prompt) return
    runNode(prompt, promptQuery.trim(), branchPathIds(menuState))
  }

  // Пункт быстрого вызова: путь уже запомнен целиком, поэтому ветки берутся
  // из него, а не из текущего положения в меню — быстрый вызов на то и
  // быстрый, что по уровням не ходят.
  const onQuickAction = (recent: ResolvedRecentAction) =>
    runNode(recent.target, recent.action.query, recent.action.path.slice(0, -1))

  // Удаление одного пункта — без подтверждения, как у плитки истории и по той
  // же причине: это приватный инструмент (в запросе Ask AI лежит личный
  // текст), и путь к нему не должен быть длиннее остальных. Цена ошибки —
  // одна строка, которая вернётся сама, как только действие выполнят снова.
  //
  // Отказ, в отличие от записи выше, показывается: человек попросил убрать
  // личный текст, и промолчать здесь значило бы соврать ровно в том месте,
  // где он рассчитывает на обратное. Список при этом не трогаем — на диске
  // запись осталась. Тот же приём, что у onDelete в HistoryView.
  const onForgetRecent = (recent: ResolvedRecentAction) => {
    forgetRecentAction(recent.action.path, recent.action.query)
      .then(setRecentActions)
      .catch((e) => setActionError(String(e)))
  }

  // Cancel всегда применяет `original` из applyState — при pending текст в
  // редакторе и так уже оригинал (эффект выше ничего туда не писал), при
  // proposed это и есть побайтовый откат: original ни разу не трогался с
  // момента startRequest (см. apply-state.ts), поэтому применить его — не
  // "восстановить похожий текст", а вернуть ровно то, что было.
  const onCancel = () => {
    if (applyState.phase !== 'pending' && applyState.phase !== 'proposed') return
    // Пока запрос в полёте — рвём его, а не только отпускаем интерфейс.
    // При phase==='proposed' ответ уже пришёл, будить некого: notify_waiters
    // на стороне Rust безопасен, когда никто не ждёт.
    if (applyState.phase === 'pending') void cancelAiAction()
    const view = viewRef.current
    if (view) resetEditorContent(view, applyState.original)
    setApplyState(cancelApply(applyState))
    setMenuState(rootMenuState(actionTree))
    setPromptQuery('')
  }

  // Нажатие на плитку истории: ПОЛНЫЙ текст записи уезжает в редактор, вид
  // возвращается к дереву действий — там, где с текстом и работают.
  // В корень, а не на прежний уровень: текст другой, значит цикл другой, —
  // ровно то же решение, что принимает follow:text выше.
  const onPickHistory = (entry: HistoryEntry) => {
    const view = viewRef.current
    const previous = view?.state.doc.toString() ?? ''
    if (view) resetEditorContent(view, entry.text)
    setShowHistory(false)
    setMenuState(rootMenuState(actionTree))
    setPromptQuery('')
    setActionError(null)
    // Строка с Undo — только если было что терять. Замена пустого редактора
    // ничего не стоила, и сообщать об этом не о чем.
    setReplaced(previous.trim() ? { text: previous, message: HISTORY_NOTICE } : null)
  }

  const onUndoReplace = () => {
    if (replaced === null) return
    const view = viewRef.current
    if (view) resetEditorContent(view, replaced.text)
    setReplaced(null)
  }

  // Возврат на уровень выше — одна функция на оба входа: полосу ← над сеткой
  // и Escape. Черновик запроса Ask AI намеренно не чистится: это делают
  // Accept/Cancel и приход нового текста, а возврат на уровень — навигация, а
  // не отмена введённого (поведение до переезда кнопки было ровно таким же).
  const onBack = () => setMenuState(goBack(menuState))

  // Paste доступен только когда есть ЧТО отправлять (текст), КУДА (запомненный
  // PID разрешился в живое приложение) и когда цикл применения закрыт: в фазе
  // proposed в редакторе лежит предложение ИИ, и отправить его, минуя явное
  // Accept, значило бы обойти решение, которое окно специально спрашивает.
  const canPaste = hasText && applyState.phase === 'idle' && !!sourceApp

  // Полный повтор пути оверлея (см. onPaste в Overlay.tsx), и намеренно тот
  // же самый: право проверяется ДО попытки, потому что без него вставка
  // гарантированно провалится, а пользователь увидит это только после
  // скрытия окна и фиксированной паузы внутри paste_text. Отказ — модальный
  // слой с дорогой в System Settings, а текст при этом всё равно кладётся в
  // буфер: копирование прав не требует.
  //
  // Окно убирается ДО paste_text, а не после: пока оно на экране, впереди
  // стоит Slaive, и активировать приложение-цель системе пришлось бы из-под
  // него. Тот же порядок, что у панели, которая прячет себя первой строкой
  // paste_text.
  // ponytail: редкий отказ УЖЕ ПОСЛЕ проверки (право отозвали в эти
  // миллисекунды, или не создался CGEvent) всплывает в оверлее — paste_text
  // шлёт свои ошибки туда, — а главное окно к этому моменту уже скрыто. Текст
  // при этом в буфере, и сообщение оверлея прямо об этом говорит. Усложнять
  // (адресовать ошибку окну-инициатору) — если этот путь окажется частым.
  // Копирование — тот же путь, что у Copy в Overlay.tsx: прав не требует,
  // работает даже когда Paste выключен (нет приложения-цели). Ошибку кладём в
  // общий actionError, успех — во временное подтверждение на самой кнопке.
  const onCopy = () => {
    const value = currentText()
    if (!value) return
    copyText(value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((e) => setActionError(String(e)))
  }

  const onPaste = () => {
    if (!canPaste) return
    const value = currentText()
    if (!value) return
    // Цепочкой, а не двумя параллельными вызовами: порядок «окно ушло →
    // вставляем» должен быть порядком, а не совпадением. Отказ спрятать окно
    // вставку не отменяет — paste_text всё равно активирует приложение-цель.
    // Формат — только когда был rich-захват; иначе текст плоский, вставляем
    // как есть. Выбор markdown/rich/plain переводится в формат команды.
    const format: PasteFormat = wasRich ? toPasteCommandFormat(pasteChoice) : 'verbatim'
    const sendToSourceApp = () =>
      hideMainWindow()
        .catch(() => {})
        .then(() => pasteText(value, format))
        .catch((e) => setActionError(String(e)))

    checkAccessibilityPermission()
      .then((allowed) => {
        if (allowed) return sendToSourceApp()
        copyText(value).catch(() => {
          // Даже копирование не удалось — модальный слой остаётся
          // единственным сообщением, второй баннер поверх него не нужен.
        })
        setShowAccessModal(true)
      })
      .catch(() => {
        // Сама проверка права не удалась — не блокируем пользователя слоем
        // «нет права», в котором не уверены: идём обычным путём, он даст свою
        // проверенную ошибку, если права и правда нет.
        void sendToSourceApp()
      })
  }

  const onAccept = () => {
    if (applyState.phase !== 'proposed') return
    // Текст уже лежит в редакторе (см. эффект синхронизации выше) — Accept
    // просто закрывает цикл и возвращает меню в корень.
    setApplyState(acceptApply(applyState))
    setMenuState(rootMenuState(actionTree))
    setPromptQuery('')
  }

  // Направление перехода: глубина уровня выросла — проваливаемся вперёд
  // (новая область приезжает справа, старая уезжает влево), упала —
  // возвращаемся назад (наоборот). Верхняя область с текстом в этом не
  // участвует вообще — она не читает depth/direction и не перерисовывается
  // по ним, только по follow:text/Accept/Cancel (см. эффекты выше).
  const depth = menuDepth(menuState)
  const prevDepthRef = useRef(depth)
  const direction: 'forward' | 'back' = depth >= prevDepthRef.current ? 'forward' : 'back'
  useEffect(() => {
    prevDepthRef.current = depth
  })

  const level = currentLevel(menuState)
  const showingPrompt = menuState.prompt !== null
  const atRoot = isRoot(menuState)

  // Состав столбца: быстрые действия (только в корне) и пункты уровня — ОДИН
  // массив, потому что это одна колонка. Стрелочная навигация считает индекс
  // по нему, поэтому «стрелки проходят быстрые действия» получается по
  // построению, а не вторым механизмом выбора (см. recent-actions.ts).
  const columnItems = buildColumnItems(level, resolvedRecent, atRoot)
  // Комбинации, которые главное окно уже перехватывает: позиционный ⌘N
  // быстрого пункта не должен затенить назначенную пользователем (см.
  // quickShortcutFor). Собирается здесь, потому что только здесь известны все
  // поля настроек этого окна.
  const takenAccels = [
    ...Object.values(actionShortcuts),
    mainPasteShortcut,
    mainCopyShortcut,
    acceptShortcut,
  ]

  // Доступность пункта — то же правило, что у кнопок уровня: без текста
  // действие нечего делать, кроме узлов с worksOnEmpty.
  const itemDisabled = (item: ColumnItem) =>
    !hasText && !(item.kind === 'recent' ? item.recent.target : item.node).worksOnEmpty

  // Активация пункта столбца — один переход на клик, Enter и хоткей.
  const activateColumnItem = (item: ColumnItem) => {
    if (item.kind === 'recent') return onQuickAction(item.recent)
    if (item.node.kind === 'leaf') return onLeafClick(item.node)
    setMenuState(enterNode(menuState, item.node))
  }

  // Хоткеи окна: обычный window keydown, как Paste/Copy в оверлее, а НЕ
  // tauri-plugin-global-shortcut — глобальная регистрация может не удаться,
  // конфликтует с другими приложениями и срабатывала бы даже когда окна не
  // видно. Все комбинации здесь с Cmd (переназначить на голую клавишу
  // настройки не дают, см. ShortcutCapture в Settings.tsx), а Cmd в
  // грамматике Vim не встречается — поэтому спрашивать «в фокусе ли
  // редактор» им не нужно, тот же довод, что у Copy в Overlay.tsx.
  //
  // Слушатель висит на ФАЗЕ ПЕРЕХВАТА (capture), а не всплытия, и это нужно
  // ровно ради Escape. Редактор здесь — тот же CodeMirror с Vim, и на
  // всплытии Escape до окна уже не доходит: vim разбирает его сам. На
  // перехвате нажатие видно ДО редактора, а значит `vimMode` в этот момент —
  // гарантированно режим ДО этой клавиши, а не после (та самая гонка, из-за
  // которой Overlay.tsx режим в обработчике читать не может: там слушатель
  // на всплытии). Единственное, что отдаём редактору, — Escape в insert:
  // это выход в normal, и отбирать его нельзя.
  //
  // Условия недоступности — ровно те же, что у самих кнопок, и проверяются
  // ОДИН раз здесь, а не дублируются по действиям: пустой текст и не-idle фаза
  // (кнопки disabled / вместо меню показана панель Accept/Cancel/Working),
  // открытая форма Ask AI (кнопок уровня на экране нет — есть Send). Какие
  // кнопки сейчас нарисованы, решает `level`: хоткей действия, до которого не
  // добрались меню, не сработает по построению. У Paste своё условие —
  // `canPaste`, то же самое, что выключает кнопку в шапке.
  //
  // Эффект без списка зависимостей — намеренно, тот же приём, что у
  // prevDepthRef ниже: обработчик читает половину состояния окна (текст,
  // фазу, уровень меню, сами хоткеи, обработчик действия), и перевесить один
  // window-слушатель на каждый рендер дешевле и честнее, чем держать ref на
  // каждое из этих значений, как приходится в Overlay.tsx, где слушатель
  // навешен один раз. Устаревшего замыкания при этом не бывает по построению.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editorFocused = viewRef.current?.hasFocus ?? false

      if (e.key === 'Escape') {
        // Слой права не должен быть ловушкой — тот же приём, что в оверлее:
        // Escape закрывает его раньше всего остального, независимо от фокуса.
        if (showAccessModal) {
          e.preventDefault()
          setShowAccessModal(false)
          return
        }
        if (editorFocused && vimMode === 'insert') return // выход в normal — не наше дело
        // История — такой же «слой поверх окна», как уровень меню: Escape
        // выводит из неё туда же, куда полоса ← над сеткой.
        if (showHistory) {
          e.preventDefault()
          setShowHistory(false)
          return
        }
        // Цикл применения открыт — Escape это Cancel, а не Back. Так и
        // только так: человек, который смотрит на предложение модели, нажмёт
        // именно эту клавишу, потому что она везде означает «выйти отсюда», а
        // единственный выход отсюда и есть Cancel. Уровнем выше в этот момент
        // всё равно не уйти — полоса ← выключена (см. JSX), — так что Escape
        // не отбирается у Back, а достаётся ему обратно, как только цикл
        // закрыт.
        //
        // Отличить одно состояние от другого можно глазами, а не памятью:
        // бейдж ⎋ рисуется ровно на той кнопке, которая сейчас его получит, —
        // на ← Back, пока меню живое, и на Cancel, пока идёт (или ждёт
        // решения) запрос. Двух включённых ⎋ на экране не бывает: бейдж на
        // ← Back показывается только в фазе idle.
        //
        // Из pending тоже Cancel, а не «ничего»: запрос в полёте рвётся тем
        // же путём, что и по кнопке (см. onCancel).
        if (applyState.phase === 'pending' || applyState.phase === 'proposed') {
          e.preventDefault()
          onCancel()
          return
        }
        // Возврат на уровень выше — то же, что делает полоса ← над сеткой.
        // В корне не делаем ничего: закрывать окно по Escape никто не просил,
        // а «ничего» здесь честнее, чем придуманное действие.
        if (!atRoot) {
          e.preventDefault()
          onBack()
        }
        return
      }

      // Пока открыт слой права, окно ничего больше не слушает: у слоя ровно
      // два выхода — Open Settings и Close.
      if (showAccessModal) return

      // Accept — единственное, что срабатывает в фазе proposed, и только в
      // ней: вне цикла применения принимать нечего, а в pending предложения
      // ещё нет. Проверка стоит ДО общего guard'а «фаза не idle — выходим»
      // ниже именно поэтому.
      if (matchesShortcut(e, acceptShortcut)) {
        if (applyState.phase !== 'proposed') return
        e.preventDefault()
        onAccept()
        return
      }

      if (matchesShortcut(e, mainPasteShortcut)) {
        if (!canPaste) return
        e.preventDefault()
        onPaste()
        return
      }

      // Copy — как Paste выше: доступен с любого вида, пока есть текст.
      // Прав не требует (см. onCopy), поэтому guard один — на пустой текст.
      if (matchesShortcut(e, mainCopyShortcut)) {
        if (!hasText) return
        e.preventDefault()
        onCopy()
        return
      }

      // Пока открыта история, сетки действий на экране нет — срабатывать их
      // хоткеям не по чему. Paste выше остаётся: текст в редакторе никуда не
      // делся, и отправить его можно с любого вида. Тот же довод, что у
      // условия «какие кнопки сейчас нарисованы, решает level».
      if (showHistory) return

      // Пустой текст больше не выключает всю клавиатуру меню: Generate
      // (worksOnEmpty) обязан запускаться и с пустого редактора. Доступность
      // конкретного пункта проверяется ниже, в точках активации.
      if (applyState.phase !== 'idle' || showingPrompt) return

      // Стрелки/Home/End БЕЗ предварительного Tab — см. arrow-routing.ts и
      // отчёт. Работает только пока список ЕЩЁ не получил настоящий
      // DOM-фокус: если он уже там (Tab), клавиша и так дойдёт до его
      // собственного onKeyDown ниже через обычный bubble — обработка здесь
      // же удвоила бы шаг. Первое же такое нажатие переводит фокус на
      // список по-настоящему (gridRef.focus(), тот же переход, что и у
      // Tab), поэтому дальше Home/End/Enter достаются его НЕИЗМЕНЁННОМУ
      // обработчику. Весь этот довод стоит на том, что gridRef указывает на
      // ЖИВОЙ список: пока ref уносил с собой снимок уезжающей панели,
      // .focus() здесь был no-op'ом и Enter не срабатывал вовсе (см.
      // renderIdlePanel ниже).
      //
      // Enter сюда намеренно не входит: в этом окне (в отличие от оверлея)
      // голый <CR> в NORMAL-режиме уже занят глобальным
      // vim-экшеном slaivePaste (см. Overlay.tsx — Vim это синглтон
      // процесса, а не per-компонент, и main.tsx статически импортирует
      // Overlay.tsx, так что регистрация действует и здесь) — но сама цель
      // (vimActionTargets.onPaste) в этом окне никогда не перепривязывается,
      // поэтому голый Enter в NORMAL здесь и без нас уже no-op, а не
      // "j^"-переход на следующую строку. Раз реального поведения тут нет,
      // отбирать нечего, но и учить Enter новому смыслу без явного фокуса —
      // лишний риск, а не необходимость: то, что достаётся списку по Tab,
      // работает без изменений, а один лишний Arrow/Home/End перед Enter не
      // ломает сценарий из брифа ("стрелки листают, Enter подтверждает").
      // contains, а не строгое равенство: фокус может стоять на КНОПКЕ
      // внутри списка (tabIndex=-1 фокусируется кликом мыши) — тогда то же
      // событие после этого обработчика дошло бы и до onKeyDown списка, и
      // один Arrow шагал бы на два пункта.
      if (
        columnItems.length > 0 &&
        !(gridRef.current?.contains(document.activeElement) ?? false) &&
        arrowsAvailable()
      ) {
        let moved = true
        switch (e.key) {
          // Чипы текут по горизонтали с переносом, поэтому ←/→ — те же
          // шаги по порядку пунктов, что ↓/↑ (порядок один, линейный).
          // Вертикальная пара осталась: ряд чипов переносится, и «вниз» по
          // привычке столбца не должно умереть. В NORMAL стрелки и раньше
          // принадлежали списку (см. arrow-routing.ts) — hjkl у редактора
          // никто не отбирает.
          case 'ArrowDown':
          case 'ArrowRight':
            setSelectedIndex((i) => moveSelectionDown(i, columnItems.length))
            break
          case 'ArrowUp':
          case 'ArrowLeft':
            setSelectedIndex((i) => moveSelectionUp(i, columnItems.length))
            break
          case 'Home':
            setSelectedIndex(0)
            break
          case 'End':
            setSelectedIndex(columnItems.length - 1)
            break
          default:
            moved = false
        }
        if (moved) {
          e.preventDefault()
          // Событие обработано целиком здесь — ниже по дереву (onKeyDown
          // списка, CodeMirror) его видеть не должны: второй обработчик
          // означал бы второй шаг на то же нажатие.
          e.stopPropagation()
          gridRef.current?.focus()
          return
        }
      }

      // Узлы уровня — ПЕРВЫМИ, и это не произвольный порядок: настроенная
      // пользователем комбинация должна делать то, что написано в
      // настройках, даже если он назначил на неё ⌘1. Затенить её позиционный
      // хоткей быстрого пункта не может и по построению (quickShortcutFor не
      // выдаёт занятый номер), но порядок разбора говорит об этом тем же
      // решением, а не второй договорённостью.
      const node = nodeForKey(e, level, atRoot, actionShortcuts)
      if (node) {
        if (!hasText && !node.worksOnEmpty) return
        e.preventDefault()
        if (node.kind === 'leaf') onLeafClick(node)
        else setMenuState(enterNode(menuState, node))
        return
      }

      // Быстрый вызов — позиционные ⌘1…⌘3, только в корне: ровно там, где
      // эти пункты и нарисованы (см. buildColumnItems). В подменю те же
      // номера принадлежат языкам, и обе роли никогда не бывают на экране
      // одновременно.
      if (!atRoot) return
      const quick = quickIndexForKey(e, resolvedRecent.length, takenAccels)
      if (quick === null) return
      const recent = resolvedRecent[quick]
      if (!hasText && !recent.target.worksOnEmpty) return
      e.preventDefault()
      onQuickAction(recent)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  // Плавная высота нижней области меню — переходы между уровнями, промптом,
  // историей и панелью Accept/Cancel меняют состав мгновенно, а ВЫСОТА
  // контейнера доезжает анимацией, как у листов macOS. Устройство: внешний
  // .mw-menu анимирует height, внутренний .mw-menu-inner никогда не зажат и
  // всегда меряется натуральной высотой (поэтому не нужно снимать инлайн-
  // стили посреди анимации, чтобы узнать цель). ResizeObserver на внутреннем
  // ловит любую причину смены высоты — навигацию, появление строки ошибки,
  // перенос кнопок при ресайзе окна — без перечисления этих причин руками.
  // Прерывание безопасно: from берётся из текущей (в том числе полу-
  // проехавшей) высоты внешнего, анимация просто перенацеливается.
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuInnerRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const outer = menuRef.current
    const inner = menuInnerRef.current
    if (!outer || !inner) return
    let target: number | null = null
    const ro = new ResizeObserver(() => {
      const to = inner.offsetHeight
      if (target !== null && Math.abs(target - to) < 1) return
      const from = outer.getBoundingClientRect().height
      target = to
      if (Math.abs(from - to) < 1) return
      // Тот же контракт, что у переходов панелей в styles.css: при
      // reduced-motion высота меняется мгновенно, без анимации.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      outer.style.height = `${from}px`
      outer.style.overflow = 'hidden'
      void outer.offsetHeight // reflow: from должен примениться до transition
      // 200мс — в такт боковому скольжению панелей; кривая — системная
      // маковская (та же, что у листов), резкий старт и мягкий доезд.
      outer.style.transition = 'height 200ms cubic-bezier(0.32, 0.72, 0, 1)'
      outer.style.height = `${to}px`
    })
    ro.observe(inner)
    const done = (e: TransitionEvent) => {
      if (e.propertyName !== 'height') return
      // Возврат к height: auto — между переходами контейнер живёт обычной
      // жизнью потока, инлайн-фиксация существует только на время анимации.
      outer.style.transition = ''
      outer.style.height = ''
      outer.style.overflow = ''
      target = null
    }
    outer.addEventListener('transitionend', done)
    return () => {
      ro.disconnect()
      outer.removeEventListener('transitionend', done)
    }
  }, [])

  // Содержимое ТЕКУЩЕГО уровня меню (список кнопок или форма Ask AI) — как
  // JSX и как ключ, которым отличаем один уровень от другого. Строится
  // безусловно (не только пока applyState.phase === 'idle'): нужно и чтобы
  // решить, что показывать сейчас, и чтобы при СЛЕДУЮЩЕМ рендере знать, что
  // было "предыдущим уровнем" для анимации проваливания, даже если между
  // двумя посещениями idle был визит в pending/proposed — у тех своя, другая
  // анимация (поднимается снизу, а не сбоку, см. бриф), они этот трекинг не
  // трогают.
  const idlePanelKey = showingPrompt
    ? `prompt:${menuState.prompt!.id}`
    : `level:${depth}:${level.map((n) => n.id).join(',')}`
  // Отпечаток быстрого списка — только ПУТИ, без запросов: запрос это личный
  // текст, и в строке, которая живёт в ключах React, ему не место. Нужен
  // отдельно от idlePanelKey, и именно поэтому отдельно: по idlePanelKey
  // решается НАПРАВЛЕНИЕ скольжения между уровнями, а смена состава быстрого
  // списка — не переход на другой уровень, и анимировать её нечем. Сброс
  // подсветки же нужен: строки сдвинулись, и индекс остался бы указывать на
  // другое действие, чем то, на которое смотрит человек.
  const quickFingerprint = resolvedRecent.map((r) => r.action.path.join('>')).join('|')
  // Индекс под подсветкой стрелок, но всегда внутри границ ТЕКУЩЕГО level —
  // clampSelectionIndex (menu-state.ts) страхует момент между тем, как
  // список языков поменялся в настройках, и эффектом ниже, который сбросит
  // selectedIndex на 0 для нового уровня.
  const selectedGridIndex = clampSelectionIndex(selectedIndex, columnItems.length)
  // Разметка уровня строится ФУНКЦИЕЙ с флагом `live`, и флаг этот не
  // косметика. Снимок уезжающей панели (outgoingPanel ниже) — это та же самая
  // разметка, отрендеренная вторым элементом стопки, и без флага React видел
  // бы в ней ОДИН И ТОТ ЖЕ ref на двух элементах. Привязка достаётся живому
  // (он в стопке последний), но когда через 200мс снимок убирают, React
  // отвязывает ref ВМЕСТЕ с ним — обнуляет gridRef.current, хотя живой список
  // стоит на экране. Дальше gridRef.current?.focus() — молчаливый no-op:
  // стрелки продолжают двигать подсветку (она из состояния), а настоящий
  // DOM-фокус в список больше не попадает НИКОГДА, и Enter уходит в редактор,
  // где голый <CR> в normal занят no-op'ом slaivePaste (см. Overlay.tsx).
  // Это и был баг «стрелки листают, Enter не срабатывает» — причём липкий: он
  // оставался до следующей смены уровня. Поэтому ref'ы принадлежат только
  // живой панели: снимок всё равно лишь уезжает за край, фокусировать его
  // нечем и незачем.
  const renderIdlePanel = (live: boolean): ReactNode => showingPrompt ? (
    <>
      <input
        ref={live ? promptInputRef : null}
        // Tab-стоп — только у живой панели (panelTabStop): поле ввода
        // снимка иначе осталось бы остановкой Tab на те же 200мс.
        tabIndex={panelTabStop(live)}
        className="mw-prompt-input"
        value={promptQuery}
        placeholder={menuState.prompt!.placeholder}
        disabled={!hasText && !menuState.prompt!.worksOnEmpty}
        onChange={(e) => setPromptQuery(e.target.value)}
        onFocus={() => {
          menuHadFocusRef.current = true
        }}
        onBlur={() => {
          menuHadFocusRef.current = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onPromptSubmit()
        }}
      />
      {/* Возврат из формы больше не стоит рядом с Send: он переехал в полосу
          над сеткой (.mw-trail ниже) вместе с возвратом из подменю — одно
          место на весь возврат, при любой глубине и любом числе кнопок. */}
      <div className="action-grid action-grid-1">
        <button
          className="primary"
          // Generate (worksOnEmpty) отправляется всегда — и с пустым сидом,
          // и с пустым текстом; Ask AI по-прежнему требует и то и другое.
          disabled={!menuState.prompt!.worksOnEmpty && (!hasText || !promptQuery.trim())}
          onClick={onPromptSubmit}
        >
          Send
        </button>
      </div>
    </>
  ) : (
    // Сетка пунктов — единый столбец (бриф: "все кнопки... столбец,
    // переключаемый стрелочками"), .action-grid-1 вместо прежней
    // .action-grid-2 — тот же грид-механизм, что у прочих сеток окна, просто
    // с одной колонкой, строк ровно по числу пунктов level. Раньше первой
    // ячейкой в ней стоял ← Back, из-за чего он читался третьим вариантом
    // выбора наравне с языками — этого по-прежнему нет: Back живёт в
    // .mw-trail отдельной строкой (см. ниже), а не в этом гриде. Нумерация
    // ⌘1…⌘9 при этом не менялась и не меняется — она всегда считалась по
    // индексу в `level`, куда Back не входил (см. shortcutFor).
    //
    // role="listbox"/"option" + aria-activedescendant — управляемый фокус
    // одного составного виджета (ARIA APG: listbox с единственным tab-стопом
    // на контейнере), а не по кнопке на tab-стоп (roving tabindex): бриф
    // прямо описывает именно этот контракт — "контейнер — tab-стоп, стрелки
    // двигают выбор внутри него, Home/End — к краям, выбранный пункт
    // объявляется". Сами кнопки исключены из обхода Tab (tabIndex={-1}), их
    // aria-selected рисует подсветку, а aria-activedescendant контейнера
    // называет её AT-читалке — без него читалка знает, что фокус в списке, но
    // не знает, какой пункт сейчас выбран.
    <div
      ref={live ? gridRef : null}
      className="action-grid action-grid-1"
      role="listbox"
      aria-label={currentLevelLabel(menuState) ?? 'Actions'}
      // Единственный tab-стоп уровня — и только пока панель живая
      // (panelTabStop): у снимка уезжающей он был вторым, невидимым
      // listbox'ом на пути Tab.
      tabIndex={panelTabStop(live)}
      aria-activedescendant={
        columnItems.length > 0
          ? `mw-option-${depth}-${columnItems[selectedGridIndex].key}`
          : undefined
      }
      onFocus={() => {
        menuHadFocusRef.current = true
      }}
      onBlur={() => {
        menuHadFocusRef.current = false
      }}
      onKeyDown={(e) => {
        if (columnItems.length === 0) return
        // Vim-навигация по списку: j/k — те же движения, что ArrowDown/Up.
        // Работает только когда фокус УЖЕ на списке (этот обработчик) — в
        // редакторе j/k остаются vim-моушенами по строкам текста, отбирать
        // их глобально нельзя. Голые клавиши, без модификаторов: ⌘K и
        // прочие хоткеи действий уже обработаны глобальным перехватчиком,
        // но тот не гасит всплытие — без проверки ⌘K двигал бы выбор.
        // l/h добавлены к j/k с переходом на чипы: пункты текут по
        // горизонтали, и «вправо/влево» — естественная пара движений; все
        // четыре шагают по одному линейному порядку. Здесь фокус УЖЕ на
        // списке, у редактора эти буквы не отбираются.
        if (
          (e.key === 'j' || e.key === 'k' || e.key === 'l' || e.key === 'h') &&
          !e.metaKey && !e.ctrlKey && !e.altKey
        ) {
          e.preventDefault()
          setSelectedIndex((i) =>
            e.key === 'j' || e.key === 'l'
              ? moveSelectionDown(i, columnItems.length)
              : moveSelectionUp(i, columnItems.length)
          )
          return
        }
        switch (e.key) {
          case 'ArrowDown':
          case 'ArrowRight':
            e.preventDefault()
            setSelectedIndex((i) => moveSelectionDown(i, columnItems.length))
            return
          case 'ArrowUp':
          case 'ArrowLeft':
            e.preventDefault()
            setSelectedIndex((i) => moveSelectionUp(i, columnItems.length))
            return
          case 'Home':
            e.preventDefault()
            setSelectedIndex(0)
            return
          case 'End':
            e.preventDefault()
            setSelectedIndex(columnItems.length - 1)
            return
          case 'Enter': {
            // Активирует подсвеченный пункт — тот же переход, что у клика по
            // нему. Условие недоступности то же самое, что у самих кнопок
            // ниже (пустой текст, кроме узлов с worksOnEmpty).
            const item = columnItems[selectedGridIndex]
            if (itemDisabled(item)) return
            e.preventDefault()
            activateColumnItem(item)
            return
          }
        }
      }}
    >
      {columnItems.map((item, i) => {
        const selected = i === selectedGridIndex
        const id = `mw-option-${depth}-${item.key}`
        const disabled = itemDisabled(item)
        // Быстрое действие — та же кнопка столбца, но с крестиком удаления
        // поверх, ровно как плитка истории (см. HistoryView.tsx): кнопка
        // выполнения — единственный пункт обхода, крестик из него исключён
        // (tabIndex={-1}) и остаётся инструментом мыши. Клавиатурного
        // удаления здесь нет намеренно, по той же причине, что и в истории:
        // вешать удаление на клавишу рядом со стрелками навигации без
        // явного запроса — слишком дорогая ошибка.
        // ponytail: удаление только мышью — добавить клавишу, если появится
        // запрос на полностью клавиатурный путь к нему.
        if (item.kind === 'recent') {
          const accel = quickShortcutFor(i, takenAccels)
          return (
            <div className="mw-recent" key={item.key}>
              <button
                id={id}
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                className={`mw-recent-run${selected ? ' is-selected' : ''}`}
                disabled={disabled}
                onClick={() => activateColumnItem(item)}
                title={`Run ${item.recent.label} again`}
              >
                {item.recent.label}
                {accel && <span className="shortcut-badge">{formatShortcutBadge(accel)}</span>}
              </button>
              <button
                className="mw-recent-forget"
                tabIndex={-1}
                onClick={() => onForgetRecent(item.recent)}
                title="Remove this from the recent list"
                aria-label="Remove this from the recent list"
              >
                ×
              </button>
            </div>
          )
        }
        // Бейдж рисуется из НАСТРОЙКИ (или из позиции в подменю), а не из
        // зашитой строки: поменял комбинацию в настройках — подпись на кнопке
        // поменялась вместе с тем, что реально срабатывает, потому что и то и
        // другое берётся из одного вызова shortcutFor. Индекс берётся из
        // самого пункта (его место в `level`), а не из места в столбце:
        // нумерация ⌘1…⌘9 в подменю не должна зависеть от того, сколько
        // строк приехало выше.
        const accel = shortcutFor(item.node, item.index, atRoot, actionShortcuts)
        // Первая кнопка уровня отделяет действия от быстрого списка над ней —
        // классом на ней самой, а не отдельной строкой-разделителем: пустого
        // заголовка над пустотой при пустом списке тогда не бывает по
        // построению, да и лишнего пункта в role="listbox" не появляется.
        const firstAfterRecent = item.index === 0 && atRoot && resolvedRecent.length > 0
        return (
          <button
            key={item.key}
            id={id}
            role="option"
            aria-selected={selected}
            // Не отдельный tab-стоп (см. пояснение выше про контейнер) —
            // мышь по-прежнему кликает кнопку напрямую, клавиатура работает
            // через контейнер.
            tabIndex={-1}
            className={
              [selected ? 'is-selected' : '', firstAfterRecent ? 'mw-after-recent' : '']
                .filter(Boolean)
                .join(' ') || undefined
            }
            disabled={disabled}
            onClick={() => activateColumnItem(item)}
          >
            {item.node.label}
            {accel && <span className="shortcut-badge">{formatShortcutBadge(accel)}</span>}
          </button>
        )
      })}
    </div>
  )

  const idlePanelNode: ReactNode = renderIdlePanel(true)
  // Снимок для уезжающей панели — та же разметка, но без ref'ов (см. выше).
  // Строится на каждый рендер, а не по требованию: эффект ниже берёт снимок
  // ПРЕДЫДУЩЕГО рендера, то есть к моменту надобности он обязан уже
  // существовать. Цена — пара десятков объектов-элементов React на рендер; в
  // DOM они попадают ровно тогда, когда панель действительно уезжает.
  const idlePanelSnapshot: ReactNode = renderIdlePanel(false)

  // Подсветка стрелками — сброс на первый пункт при смене уровня
  // (resetSelectionForLevel всегда 0, см. menu-state.ts): "докуда долистал"
  // не должно пережить провал в другой уровень или возврат назад — там
  // другой состав кнопок.
  useEffect(() => {
    setSelectedIndex(resetSelectionForLevel())
  }, [idlePanelKey, quickFingerprint])

  // Ключ ЖИВОЙ панели стопки: не «какой уровень меню открыт», а «что сейчас
  // стоит на его месте» — уровень, форма Ask AI или панель
  // Working/Accept-Cancel (см. livePanelKey в panel-focus.ts). Эффект ниже
  // висит на нём одном, и в этом вся разница с прежней зависимостью от
  // idlePanelKey: уровень при действии из КОРНЯ не меняется, а панель —
  // меняется, трижды.
  const liveKey = livePanelKey(applyState.phase, idlePanelKey)

  // Возврат DOM-фокуса в меню после подмены живой панели, если он был там
  // непосредственно перед подменой (см. menuHadFocusRef выше). Без этого
  // клавиатурный путь обрывался бы на каждом провале в Translate/Ask AI,
  // возврате Back и на каждом запуске действия: React убирает старый
  // .mw-panel из дерева (см. ниже), сфокусированный узел удаляется без
  // blur, и фокус молча утекает в <body> — следующую стрелку уже некому
  // поймать, Tab начинает обход с начала окна, Enter не достаётся никому.
  // Обычный уход фокуса (Tab на Paste, клик в поле текста) блюром
  // сбрасывает флаг как положено, и это правило его не переопределяет.
  //
  // Решение «куда именно» вынесено в nextFocusTarget (panel-focus.ts) — там
  // и довод про панель применения; здесь остаётся только перевод фокуса.
  // Зависимость одна, liveKey: showingPrompt входит в него префиксом ключа
  // уровня (prompt: против level:), фаза — своей веткой, так что второй
  // зависимости было бы нечего добавить.
  useEffect(() => {
    switch (
      nextFocusTarget({
        menuHadFocus: menuHadFocusRef.current,
        phase: applyState.phase,
        showingPrompt,
      })
    ) {
      case 'apply':
        applyPanelRef.current?.focus()
        break
      case 'prompt':
        promptInputRef.current?.focus()
        break
      case 'list':
        gridRef.current?.focus()
        break
      case 'none':
        break
    }
  }, [liveKey])

  // Уходящая панель уровня меню (для эффекта "старая уезжает влево/вправо,
  // новая приезжает с другой стороны" — бриф явно просит показывать ОБЕ
  // одновременно, а не просто анимировать появление новой). Хранится
  // отдельно от текущей: React убирает старый .mw-panel из дерева сразу при
  // смене уровня (следующий блок JSX всегда рендерит ТЕКУЩИЙ idlePanelNode),
  // поэтому снимок уходящей панели и её направление берём ЗДЕСЬ, до того как
  // текущая заменится, и держим его отдельным элементом ровно 200мс. Снимок —
  // это idlePanelSnapshot, вариант разметки БЕЗ ref'ов: иначе он уносил бы с
  // собой привязку фокуса живого списка (см. renderIdlePanel выше).
  //
  // Таймер, а не onAnimationEnd: тот не сработал бы, если пользователь нажал
  // следующий уровень раньше, чем предыдущая анимация успела доиграть —
  // элемент к этому моменту уже заменён (см. guard по ключу в эффекте ниже),
  // а с ним и слушатель. Таймер снаружи не завязан на жизнь конкретного DOM-
  // узла, поэтому переживает такую замену корректно.
  const [outgoingPanel, setOutgoingPanel] = useState<{
    key: string
    node: ReactNode
    direction: 'forward' | 'back'
  } | null>(null)
  const prevIdlePanelRef = useRef<{ key: string; node: ReactNode } | null>(null)
  const outgoingTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    if (applyState.phase !== 'idle') {
      // Уход в pending/proposed — своя, вертикальная анимация (см. JSX
      // ниже), боковой переход ей не нужен; "предыдущий idle-уровень" не
      // трогаем, чтобы после Accept/Cancel (который сбрасывает меню в
      // корень) следующее сравнение было относительно него, а не относительно
      // pending/proposed, у которых нет понятия "уровень".
      return
    }
    const prev = prevIdlePanelRef.current
    if (prev && prev.key !== idlePanelKey) {
      if (outgoingTimeoutRef.current !== null) window.clearTimeout(outgoingTimeoutRef.current)
      const outgoingKey = prev.key
      setOutgoingPanel({ key: prev.key, node: prev.node, direction })
      outgoingTimeoutRef.current = window.setTimeout(() => {
        // Быстрые повторные нажатия просто заменяют outgoingPanel новым
        // снимком (setOutgoingPanel выше) раньше, чем успевает сработать
        // этот таймер — guard по ключу не даёт СТАРОМУ таймеру стереть УЖЕ
        // подменённую панель, поэтому анимации не накапливаются и не
        // оставляют «застрявших» уровней.
        setOutgoingPanel((cur) => (cur?.key === outgoingKey ? null : cur))
        outgoingTimeoutRef.current = null
      }, 200)
    }
    prevIdlePanelRef.current = { key: idlePanelKey, node: idlePanelSnapshot }
  }, [idlePanelKey, applyState.phase])

  useEffect(
    () => () => {
      if (outgoingTimeoutRef.current !== null) window.clearTimeout(outgoingTimeoutRef.current)
    },
    []
  )

  return (
    // .chassis-flush — тот же приём, что у окна настроек: корпус .chassis
    // рассчитан на плавающую панель оверлея (скруглённые углы, рамка,
    // внешняя тень над чужим содержимым экрана), а главное окно — обычное
    // непрозрачное окно с рамкой ОС, где всё это оставляет светлый ободок по
    // краям и срезанные углы. Материал корпуса остаётся, обрамление панели
    // снимается.
    <div className="main-window chassis chassis-flush">
      {/* Шапка источника — то же, что показывает оверлей над строкой статуса,
          теми же классами (.source-app / .source-app-icon / .source-app-name)
          и из того же разрешения имени и иконки по PID. Здесь она нужнее, чем
          там: оверлей всплывает поверх приложения, которое пользователь и так
          видит, а главное окно обычное и забирает фокус — «куда уйдёт Paste»
          из него иначе ниоткуда не следует.

          Кнопка Paste стоит в этой же строке не ради экономии места: она
          отправляет текст именно в то приложение, которое здесь названо, и
          читать это надо одной фразой, а не собирать из двух концов окна.
          Меню действий она при этом не трогает вовсе — ни сетку, ни
          анимацию переходов. */}
      <div className="mw-source-row">
        {sourceApp ? (
          <span className="source-app">
            {sourceApp.icon && <img className="source-app-icon" src={sourceApp.icon} alt="" />}
            <span className="source-app-name">{sourceApp.name}</span>
          </span>
        ) : (
          // sourceApp === undefined — ответа ещё нет, молчим; null — цели
          // нет, и это надо сказать словами, иначе выключенная кнопка Paste
          // выглядит поломкой. Оба случая (окно открыли без диктовки; то
          // приложение закрылось) неотличимы для пользователя и лечатся
          // одинаково, поэтому и текст один.
          sourceApp === null && (
            <span className="source-app source-app-missing">
              No source app — dictate with the hotkey from the app you want the text in
            </span>
          )
        )}
        {/* Выбор формата вставки — только для текста с разметкой. Это и есть
            «спросить, в каком формате вставить», но без модалки: три кнопки
            рядом с Paste, выбор запоминается (см. chooseFormat). */}
        {wasRich && (
          <div className="mw-format" role="group" aria-label="Paste format">
            {PASTE_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`mw-format-btn${pasteChoice === c.id ? ' selected' : ''}`}
                aria-pressed={pasteChoice === c.id}
                onClick={() => chooseFormat(c.id)}
                title={
                  c.id === 'rich'
                    ? 'Paste with live formatting (bold, code, lists)'
                    : c.id === 'markdown'
                      ? 'Paste the Markdown source as plain text'
                      : 'Paste as plain text, formatting stripped'
                }
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        <button
          className="mw-copy"
          disabled={!hasText}
          onClick={onCopy}
          title="Copy the text to the clipboard"
        >
          {copied ? 'Copied' : (
            <>
              Copy <span className="shortcut-badge">{formatShortcutBadge(mainCopyShortcut)}</span>
            </>
          )}
        </button>
        <button
          className="primary mw-paste"
          disabled={!canPaste}
          onClick={onPaste}
          title={
            sourceApp
              ? `Paste the text into ${sourceApp.name}`
              : 'Slaive has nowhere to paste: no app is remembered from a dictation yet.'
          }
        >
          Paste <span className="shortcut-badge">{formatShortcutBadge(mainPasteShortcut)}</span>
        </button>
      </div>

      <div className="mw-editor-row">
        <div className="transcript-field" ref={editorContainerRef} />
      </div>

      <div className="mw-menu" ref={menuRef}>
        <div className="mw-menu-inner" ref={menuInnerRef}>
        {actionError && (
          <div className="mw-error">
            <span>{actionError}</span>
            <div className="mw-error-actions">
              <button onClick={() => openSettingsWindow()}>Open Settings</button>
              <button onClick={() => setActionError(null)}>Dismiss</button>
            </div>
          </div>
        )}

        {/* Полоса возврата — ВНЕ .mw-panel-stack, поэтому она не участвует в
            скольжении уровней: едет только содержимое сетки, а точка
            возврата стоит на месте. Место у неё одно и то же при любом числе
            пунктов и на любой глубине именно потому, что она собственная
            строка .mw-menu, а не ячейка сетки действий, — число кнопок в
            сетке на её положение больше не влияет никак.
            Отвечает сразу за две вещи: возврат и ориентацию («← Translate» —
            где ты находишься). В корне возврата в ней нет — возвращаться
            некуда, — но сама полоса есть: с появлением истории у неё
            появился второй, постоянный житель (см. ниже). В
            pending/proposed она остаётся, но выключена: уровень, внутри
            которого запущено действие, никуда не делся и его полезно видеть,
            а уходить с панели Accept/Cancel вбок нельзя — та же причина, по
            которой там выключены и сами действия. Заодно меню не дёргается
            по высоте ровно в тот момент, когда играет анимация. */}
        {/* Строка с предложением вернуть заменённый текст. Живёт над полосой
            возврата, а не под сеткой: она про ТЕКСТ, который лежит выше, и
            читается по дороге от него к действиям. Оформлена нейтрально, а не
            как ошибка (.mw-error) — ничего не сломалось, это уведомление. */}
        {replaced !== null && (
          <div className="mw-notice">
            <span>{replaced.message}</span>
            <div className="mw-error-actions">
              <button onClick={onUndoReplace}>Undo</button>
              <button onClick={() => setReplaced(null)}>Dismiss</button>
            </div>
          </div>
        )}

        {/* Полоса теперь есть ВСЕГДА, а не только в подменю: справа в ней
            стоит вход в историю, и он должен быть на одном месте при любой
            глубине меню — как и сам возврат. Побочно исчез скачок разметки
            на 20px при спуске в подменю.
            Вход в историю оформлен той же приглушённой кнопкой, что и
            возврат: это навигация по окну, а не действие над текстом, и
            стоять по весу в одном ряду с Translate/Fix он не должен.
            Выключается там же, где выключается возврат (идёт запрос к ИИ):
            уходить с панели Accept/Cancel некуда — ни вбок, ни в историю. */}
        <div className="mw-trail">
          {/* Бейдж ⎋ на возврате. Escape умел это и раньше, но нигде не был
              написан — «работает, но никто не знает» ничем не лучше, чем «не
              работает». Рисуется тем же formatShortcutBadge из той же записи
              акселератора, что и остальные бейджи (ESCAPE_SHORTCUT), а не
              зашитым символом.

              В сетке уровня бейдж на возврате НЕ показывается, когда кнопка
              выключена (идёт запрос к ИИ): в этот момент Escape принадлежит
              Cancel, и обещать его здесь было бы ложью. Ровно этим человек и
              отличает два состояния Escape — по тому, у какой кнопки сейчас
              стоит ⎋. */}
          {showHistory ? (
            <button type="button" className="mw-back" onClick={() => setShowHistory(false)}>
              ← Actions <span className="shortcut-badge">{formatShortcutBadge(ESCAPE_SHORTCUT)}</span>
            </button>
          ) : (
            !atRoot && (
              <button
                type="button"
                className="mw-back"
                disabled={applyState.phase !== 'idle'}
                onClick={onBack}
              >
                ← {currentLevelLabel(menuState) ?? 'Back'}
                {applyState.phase === 'idle' && (
                  <span className="shortcut-badge">{formatShortcutBadge(ESCAPE_SHORTCUT)}</span>
                )}
              </button>
            )
          )}
          <span className={`vim-mode vim-mode-${vimMode} mw-vim-mode`}>{vimMode.toUpperCase()}</span>
          {!showHistory && (
            <button
              type="button"
              className="mw-back mw-history-open"
              disabled={applyState.phase !== 'idle'}
              onClick={() => setShowHistory(true)}
              title="Earlier transcripts, stored on this Mac"
            >
              History
            </button>
          )}
        </div>

        {/* История занимает место дерева действий целиком: это не ещё один
            уровень меню (в неё не «проваливаются» из Translate и из неё не
            возвращаются на уровень выше), а другой вид того же окна. Поэтому
            она вне .mw-panel-stack и не участвует в боковых переходах —
            анимации уровней её не видят, а она не путается в их учёте
            уходящих панелей. */}
        {showHistory && <HistoryView onPick={onPickHistory} arrowsAvailable={arrowsAvailable} />}

        {/* .mw-panel-stack накладывает уходящую и текущую панели в одну
            grid-ячейку (см. styles.css) — обе видимы одновременно ровно то
            время, что требует бриф, без сдвига разметки под ними. */}
        <div className="mw-panel-stack" hidden={showHistory}>
          {/* Каждая панель стопки объявляет свою достижимость сама
              (panelGuard, см. panel-focus.ts): живая — обычный интерфейс,
              уезжающий снимок — inert, картинка без мыши, фокуса и места в
              дереве доступности. Без этого 200мс после КАЖДОЙ смены уровня
              клик мог попасть по кнопке, которая уезжает за край, —
              сработало бы то, во что человек не целился, с уровня, который
              он уже покинул. */}
          {outgoingPanel && (
            <div
              key={outgoingPanel.key}
              className={`mw-panel mw-exit-${outgoingPanel.direction}`}
              {...panelGuard(false)}
            >
              {outgoingPanel.node}
            </div>
          )}

          {/* Появление панели Accept/Cancel/Working — своё движение
              (поднимается снизу), не боковое: это не следующий уровень
              меню, а другой режим (см. бриф). Простое условное монтирование
              без outgoing-трекинга — ponytail: если понадобится тоже
              показать её "въезд поверх уезжающего меню" одновременно, а не
              просто сверху текущего кадра, добавить тот же приём outgoing,
              что и у уровней меню выше. */}
          {applyState.phase === 'pending' && (
            <div
              key="pending"
              className="mw-panel mw-apply-panel"
              // Панель — цель фокуса, пока список снят с экрана (см.
              // applyPanelRef выше). tabIndex={-1}: фокусируется кодом, но
              // остановкой Tab не становится — следующие остановки Tab это
              // Cancel здесь и Accept/Cancel в proposed, то есть ровно то,
              // чем из этой фазы можно выйти.
              ref={applyPanelRef}
              tabIndex={-1}
              role="group"
              aria-label="Working"
              onFocus={() => {
                menuHadFocusRef.current = true
              }}
              onBlur={() => {
                menuHadFocusRef.current = false
              }}
              {...panelGuard(true)}
            >
              <span className="mw-spinner" aria-hidden="true" />
              <span className="mw-pending-label">Working…</span>
              {/* Cancel в pending рвёт запрос — и делает это по Escape тоже
                  (см. обработчик клавиш выше), поэтому бейдж здесь такой же,
                  как у proposed ниже: одна клавиша, одно обещание. */}
              <div className="action-grid action-grid-1">
                <button onClick={onCancel}>
                  Cancel <span className="shortcut-badge">{formatShortcutBadge(ESCAPE_SHORTCUT)}</span>
                </button>
              </div>
            </div>
          )}

          {applyState.phase === 'proposed' && (
            <div
              key="proposed"
              className="mw-panel mw-apply-panel"
              // То же, что у pending выше: фокус живёт на панели, Accept и
              // Cancel — следующие остановки Tab. Ref тот же (фазы
              // исключают друг друга), ключ другой — панель пересоздаётся,
              // поэтому фокус переносится заново.
              ref={applyPanelRef}
              tabIndex={-1}
              role="group"
              aria-label="AI proposal"
              onFocus={() => {
                menuHadFocusRef.current = true
              }}
              onBlur={() => {
                menuHadFocusRef.current = false
              }}
              {...panelGuard(true)}
            >
              {/* Два выхода из цикла и две подписанные клавиши. У Accept она
                  намеренно тугая (⇧⌘⏎, настройка acceptShortcut): принятие
                  затирает текст пользователя предложением модели, и вернуть
                  прежний можно только через Undo редактора. У Cancel — ⎋,
                  привычное «выйти отсюда»; пока эта панель на экране, Escape
                  принадлежит ей, а не возврату по меню. */}
              <div className="action-grid action-grid-2">
                <button className="primary" onClick={onAccept}>
                  Accept <span className="shortcut-badge">{formatShortcutBadge(acceptShortcut)}</span>
                </button>
                <button onClick={onCancel}>
                  Cancel <span className="shortcut-badge">{formatShortcutBadge(ESCAPE_SHORTCUT)}</span>
                </button>
              </div>
            </div>
          )}

          {applyState.phase === 'idle' && (
            <div
              key={idlePanelKey}
              className={`mw-panel mw-enter-${direction}`}
              {...panelGuard(true)}
            >
              {idlePanelNode}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* Тот же слой, что в оверлее, и та же разметка с теми же классами:
          право одно (Accessibility), отказ один, и объяснение должно быть
          одним — второй формулировки той же беды пользователю не нужно.
          Не ловушка: Escape (см. обработчик клавиш выше) и кнопка Close
          закрывают слой без последствий, текст уже лежит в буфере. */}
      {showAccessModal && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Accessibility permission required"
          >
            <p className="modal-text">
              Slaive can't send keystrokes to other apps yet, so Paste can't insert the text
              automatically. The text is already on your clipboard — press Cmd+V to paste it
              manually, or turn on Accessibility access below to make Paste work directly.
            </p>
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() => {
                  openPrivacyPane('accessibility')
                  setShowAccessModal(false)
                }}
              >
                Open Settings
              </button>
              <button onClick={() => setShowAccessModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
