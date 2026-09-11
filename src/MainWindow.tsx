import { useEffect, useRef, useState, type ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { EditorView } from '@codemirror/view'
import { createTranscriptEditor, resetEditorContent, watchVimMode, type VimMode } from './transcript-editor'
import { rootMenuState, currentLevel, enterNode, goBack, isRoot, menuDepth, type MenuState } from './menu-state'
import type { LeafNode } from './action-tree'
import {
  idleApplyState,
  startRequest,
  receiveResult,
  receiveError,
  cancelApply,
  acceptApply,
  type ApplyState,
} from './apply-state'
import { runAiAction, cancelAiAction, openSettingsWindow, getSettings, type Settings } from './api'
import {
  DEFAULT_ACTION_SHORTCUTS,
  nodeForKey,
  shortcutFor,
  type ActionShortcuts,
} from './action-shortcuts'
import { formatShortcutBadge } from './shortcut'

type FollowPayload = { text: string }

/** Главное окно: текст сверху (неподвижная часть интерфейса — см. бриф), под
 *  ним многоуровневое меню действий (Translate/Ask AI/Fix/Shorten), каждое
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
  const [menuState, setMenuState] = useState<MenuState>(rootMenuState)
  const [applyState, setApplyState] = useState<ApplyState>(idleApplyState)
  const [actionError, setActionError] = useState<string | null>(null)
  const [promptQuery, setPromptQuery] = useState('')

  // Хоткеи действий — ОКОННЫЕ, не глобальные (см. action-shortcuts.ts):
  // обычный keydown ниже, никакого tauri-plugin-global-shortcut. В состоянии,
  // а не в константе, потому что бейдж на кнопке рисуется из настройки и
  // обязан перерисоваться, когда её поменяли: главное окно между вызовами не
  // пересоздаётся (прячется/показывается), поэтому значения грузятся один раз
  // на mount и дальше обновляются событием settings:changed — тот же приём,
  // что у Paste/Copy в Overlay.tsx.
  const [actionShortcuts, setActionShortcuts] = useState<ActionShortcuts>(DEFAULT_ACTION_SHORTCUTS)
  useEffect(() => {
    const take = (s: Settings): ActionShortcuts => ({
      translateShortcut: s.translateShortcut,
      askAiShortcut: s.askAiShortcut,
      fixShortcut: s.fixShortcut,
      shortenShortcut: s.shortenShortcut,
    })
    getSettings().then((s) => setActionShortcuts(take(s)))
    const un = listen<Settings>('settings:changed', (e) => setActionShortcuts(take(e.payload)))
    return () => {
      un.then((f) => f())
    }
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
      setMenuState(rootMenuState())
      setApplyState(idleApplyState())
      setActionError(null)
      setPromptQuery('')
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
    setMenuState(rootMenuState())
    setPromptQuery('')
  }

  const onAccept = () => {
    if (applyState.phase !== 'proposed') return
    // Текст уже лежит в редакторе (см. эффект синхронизации выше) — Accept
    // просто закрывает цикл и возвращает меню в корень.
    setApplyState(acceptApply(applyState))
    setMenuState(rootMenuState())
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

  // Хоткеи действий: обычный window keydown, как Paste/Copy в оверлее, а НЕ
  // tauri-plugin-global-shortcut — глобальная регистрация может не удаться,
  // конфликтует с другими приложениями и срабатывала бы даже когда окна не
  // видно. Проверку "в фокусе ли редактор" делать не нужно: дефолты все на
  // Cmd, а переназначить на голую клавишу настройки не дают (см.
  // ShortcutCapture в Settings.tsx), Cmd же в грамматике Vim не встречается —
  // тот же довод, по которому Copy в Overlay.tsx работает независимо от
  // фокуса.
  //
  // Условия недоступности — ровно те же, что у самих кнопок, и проверяются
  // ОДИН раз здесь, а не дублируются по действиям: пустой текст и не-idle фаза
  // (кнопки disabled / вместо меню показана панель Accept/Cancel/Working),
  // открытая форма Ask AI (кнопок уровня на экране нет — есть Send/Back).
  // Какие кнопки сейчас нарисованы, решает `level`: хоткей действия, до
  // которого не добрались меню, не сработает по построению.
  //
  // Эффект без списка зависимостей — намеренно, тот же приём, что у
  // prevDepthRef ниже: обработчик читает половину состояния окна (текст,
  // фазу, уровень меню, сами хоткеи, обработчик действия), и перевесить один
  // window-слушатель на каждый рендер дешевле и честнее, чем держать ref на
  // каждое из этих значений, как приходится в Overlay.tsx, где слушатель
  // навешен один раз. Устаревшего замыкания при этом не бывает по построению.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hasText || applyState.phase !== 'idle' || showingPrompt) return
      const node = nodeForKey(e, level, atRoot, actionShortcuts)
      if (!node) return
      e.preventDefault()
      if (node.kind === 'leaf') onLeafClick(node)
      else setMenuState(enterNode(menuState, node))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
      <div className="action-grid action-grid-2">
        <button className="primary" disabled={!hasText || !promptQuery.trim()} onClick={onPromptSubmit}>
          Send
        </button>
        <button onClick={() => setMenuState(goBack(menuState))}>← Back</button>
      </div>
    </>
  ) : (
    <div className="action-grid action-grid-2">
      {!isRoot(menuState) && <button onClick={() => setMenuState(goBack(menuState))}>← Back</button>}
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

        {/* .mw-panel-stack накладывает уходящую и текущую панели в одну
            grid-ячейку (см. styles.css) — обе видимы одновременно ровно то
            время, что требует бриф, без сдвига разметки под ними. */}
        <div className="mw-panel-stack">
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
              <div className="action-grid action-grid-1">
                <button onClick={onCancel}>Cancel</button>
              </div>
            </div>
          )}

          {applyState.phase === 'proposed' && (
            <div key="proposed" className="mw-panel mw-apply-panel">
              <div className="action-grid action-grid-2">
                <button className="primary" onClick={onAccept}>
                  Accept
                </button>
                <button onClick={onCancel}>Cancel</button>
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
    </div>
  )
}
