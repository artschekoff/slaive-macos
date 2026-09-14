import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { EditorView } from '@codemirror/view'
import { createTranscriptEditor, resetEditorContent, watchVimMode, type VimMode } from './transcript-editor'
import {
  rootMenuState,
  currentLevel,
  currentLevelLabel,
  enterNode,
  goBack,
  isRoot,
  menuDepth,
  type MenuState,
} from './menu-state'
import { buildActionTree, DEFAULT_TRANSLATE_LANGUAGES, type LeafNode } from './action-tree'
import {
  idleApplyState,
  startRequest,
  receiveResult,
  receiveError,
  cancelApply,
  acceptApply,
  type ApplyState,
} from './apply-state'
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
  type HistoryEntry,
  type Settings,
  type SourceApp,
} from './api'
import { HistoryView } from './HistoryView'
import {
  DEFAULT_ACCEPT_SHORTCUT,
  DEFAULT_ACTION_SHORTCUTS,
  ESCAPE_SHORTCUT,
  nodeForKey,
  shortcutFor,
  type ActionShortcuts,
} from './action-shortcuts'
import { formatShortcutBadge, matchesShortcut } from './shortcut'

// Дефолт хоткея Paste главного окна — дублирует Settings::default() на
// бэкенде (src-tauri/src/settings.rs), как и DEFAULT_ACTION_SHORTCUTS рядом:
// заглушка до первого ответа get_settings, дальше её перекрывает настройка.
const DEFAULT_MAIN_PASTE_SHORTCUT = 'Super+Enter'

type FollowPayload = { text: string }

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
  const [promptQuery, setPromptQuery] = useState('')
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
  // Что лежало в редакторе ДО того, как туда положили запись из истории.
  // Замена текста задумана (история — способ вернуться к прежней расшифровке,
  // а не дописать к текущей), но человек мог полчаса править надиктованное
  // руками, и «задумано» не оправдывает молчаливую потерю этой работы.
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
  const [replacedText, setReplacedText] = useState<string | null>(null)

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
  // Accept — по той же причине отдельным состоянием, что и Paste выше: это не
  // узел дерева действий, а шаг цикла применения (см. apply-state.ts).
  const [acceptShortcut, setAcceptShortcut] = useState(DEFAULT_ACCEPT_SHORTCUT)
  useEffect(() => {
    const take = (s: Settings): ActionShortcuts => ({
      translateShortcut: s.translateShortcut,
      askAiShortcut: s.askAiShortcut,
      fixShortcut: s.fixShortcut,
      shortenShortcut: s.shortenShortcut,
      summarizeShortcut: s.summarizeShortcut,
    })
    const apply = (s: Settings) => {
      setActionShortcuts(take(s))
      setMainPasteShortcut(s.mainPasteShortcut)
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

  // Follow из оверлея — единственный способ получить текст в это окно. Новый
  // текст — новый цикл: меню в корень, состояние применения сброшено, форма
  // Ask AI очищена — тот же принцип "новый цикл, чистый лист", что у
  // rec:start в Overlay.tsx. Приходит и когда окно только что показано Rust'ом
  // (show_main_window), и когда оно уже было открыто и просто поднимается
  // наверх — в обоих случаях второе окно не плодится (см. follow_to_main_window).
  useEffect(() => {
    const un = listen<FollowPayload>('follow:text', (e) => {
      const view = viewRef.current
      if (view) resetEditorContent(view, e.payload.text)
      setMenuState(rootMenuState(actionTreeRef.current))
      setApplyState(idleApplyState())
      setActionError(null)
      setPromptQuery('')
      // Новый текст — новый цикл: история закрывается, а предложение вернуть
      // прежний текст теряет смысл (прежний текст только что заменён не
      // историей, а новой диктовкой).
      setShowHistory(false)
      setReplacedText(null)
      // Текст новый — возможно, и приложение, из которого его надиктовали,
      // тоже другое. Шапку и доступность Paste перечитываем на каждый Follow,
      // а не один раз на монтировании.
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
    // истории, дальше только мешало бы: откатывать теперь есть куда и без
    // него (Cancel), а строка внизу относилась бы к позапрошлому состоянию.
    setReplacedText(null)
    runAiAction(system, user)
      .then((result) => {
        setApplyState((prev) => receiveResult(prev, id, result))
      })
      .catch((e) => {
        setApplyState((prev) => receiveError(prev, id))
        setActionError(String(e))
      })
  }

  const onLeafClick = (node: LeafNode) => {
    if (!hasText || applyState.phase !== 'idle') return
    const { system, user } = node.buildRequest(currentText())
    runRequest(system, user)
  }

  const onPromptSubmit = () => {
    const prompt = menuState.prompt
    const query = promptQuery.trim()
    if (!prompt || !hasText || !query || applyState.phase !== 'idle') return
    const { system, user } = prompt.buildRequest(currentText(), query)
    runRequest(system, user)
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
    setReplacedText(previous.trim() ? previous : null)
  }

  const onUndoReplace = () => {
    if (replacedText === null) return
    const view = viewRef.current
    if (view) resetEditorContent(view, replacedText)
    setReplacedText(null)
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
  const onPaste = () => {
    if (!canPaste) return
    const value = currentText()
    if (!value) return
    // Цепочкой, а не двумя параллельными вызовами: порядок «окно ушло →
    // вставляем» должен быть порядком, а не совпадением. Отказ спрятать окно
    // вставку не отменяет — paste_text всё равно активирует приложение-цель.
    const sendToSourceApp = () =>
      hideMainWindow()
        .catch(() => {})
        .then(() => pasteText(value))
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

      // Пока открыта история, сетки действий на экране нет — срабатывать их
      // хоткеям не по чему. Paste выше остаётся: текст в редакторе никуда не
      // делся, и отправить его можно с любого вида. Тот же довод, что у
      // условия «какие кнопки сейчас нарисованы, решает level».
      if (showHistory) return

      if (!hasText || applyState.phase !== 'idle' || showingPrompt) return
      const node = nodeForKey(e, level, atRoot, actionShortcuts)
      if (!node) return
      e.preventDefault()
      if (node.kind === 'leaf') onLeafClick(node)
      else setMenuState(enterNode(menuState, node))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

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
  const idlePanelNode: ReactNode = showingPrompt ? (
    <>
      <input
        className="mw-prompt-input"
        value={promptQuery}
        placeholder={menuState.prompt!.placeholder}
        disabled={!hasText}
        onChange={(e) => setPromptQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onPromptSubmit()
        }}
      />
      {/* Возврат из формы больше не стоит рядом с Send: он переехал в полосу
          над сеткой (.mw-trail ниже) вместе с возвратом из подменю — одно
          место на весь возврат, при любой глубине и любом числе кнопок. */}
      <div className="action-grid action-grid-1">
        <button className="primary" disabled={!hasText || !promptQuery.trim()} onClick={onPromptSubmit}>
          Send
        </button>
      </div>
    </>
  ) : (
    // Сетка пунктов — только пункты. Раньше первой ячейкой в ней стоял
    // ← Back, из-за чего он читался третьим вариантом выбора наравне с
    // языками, а его место зависело от числа пунктов: в подменю из двух он
    // слева сверху, в подменю из трёх уехал бы в другую ячейку. Нумерация
    // ⌘1…⌘9 при этом не менялась и не меняется — она всегда считалась по
    // индексу в `level`, куда Back не входил (см. shortcutFor).
    <div className="action-grid action-grid-2">
      {level.map((node, i) => {
        // Бейдж рисуется из НАСТРОЙКИ (или из позиции в подменю), а не из
        // зашитой строки: поменял комбинацию в настройках — подпись на кнопке
        // поменялась вместе с тем, что реально срабатывает, потому что и то и
        // другое берётся из одного вызова shortcutFor.
        const accel = shortcutFor(node, i, atRoot, actionShortcuts)
        return (
          <button
            key={node.id}
            disabled={!hasText}
            onClick={() => (node.kind === 'leaf' ? onLeafClick(node) : setMenuState(enterNode(menuState, node)))}
          >
            {node.label}
            {accel && <span className="shortcut-badge">{formatShortcutBadge(accel)}</span>}
          </button>
        )
      })}
    </div>
  )

  // Уходящая панель уровня меню (для эффекта "старая уезжает влево/вправо,
  // новая приезжает с другой стороны" — бриф явно просит показывать ОБЕ
  // одновременно, а не просто анимировать появление новой). Хранится
  // отдельно от текущей: React убирает старый .mw-panel из дерева сразу при
  // смене уровня (следующий блок JSX всегда рендерит ТЕКУЩИЙ idlePanelNode),
  // поэтому снимок уходящей панели и её направление берём ЗДЕСЬ, до того как
  // текущая заменится, и держим его отдельным элементом ровно 200мс.
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
    prevIdlePanelRef.current = { key: idlePanelKey, node: idlePanelNode }
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
        <span className={`vim-mode vim-mode-${vimMode} mw-vim-mode`}>{vimMode.toUpperCase()}</span>
      </div>

      <div className="mw-menu">
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
        {replacedText !== null && (
          <div className="mw-notice">
            <span>Loaded from history. The text that was here has been replaced.</span>
            <div className="mw-error-actions">
              <button onClick={onUndoReplace}>Undo</button>
              <button onClick={() => setReplacedText(null)}>Dismiss</button>
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
        {showHistory && <HistoryView onPick={onPickHistory} />}

        {/* .mw-panel-stack накладывает уходящую и текущую панели в одну
            grid-ячейку (см. styles.css) — обе видимы одновременно ровно то
            время, что требует бриф, без сдвига разметки под ними. */}
        <div className="mw-panel-stack" hidden={showHistory}>
          {outgoingPanel && (
            <div key={outgoingPanel.key} className={`mw-panel mw-exit-${outgoingPanel.direction}`}>
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
            <div key="pending" className="mw-panel mw-apply-panel">
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
            <div key="proposed" className="mw-panel mw-apply-panel">
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
            <div key={idlePanelKey} className={`mw-panel mw-enter-${direction}`}>
              {idlePanelNode}
            </div>
          )}
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
