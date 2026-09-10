import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  copyText,
  getLastRecording,
  getSettings,
  hideOverlay,
  openPrivacyPane,
  pasteText,
  startRecording,
  stopRecording,
  type PrivacyPane,
  type Settings,
} from './api'
import {
  DEFAULT_COPY_SHORTCUT,
  DEFAULT_PASTE_SHORTCUT,
  formatShortcutBadge,
  matchesShortcut,
} from './shortcut'

type Phase = 'idle' | 'recording' | 'transcribing' | 'ready' | 'error'

// Ширина одного бара дорожки и зазор между ними — должны совпадать с
// `.overlay .level` (flex: 0 0 2px) и `.overlay .levels` (gap: 1px) в
// styles.css. Раньше здесь была фиксированная константа (200 баров),
// подобранная не от ширины контейнера, а "на глаз" — из-за этого дорожка
// либо вылезала за правый край панели (баров помещалось больше, чем
// хватало ширины), либо начинала сдвигаться слишком поздно (баров
// помещалось меньше, чем задавал жёсткий предел). Предел теперь считается
// от реальной ширины контейнера, поэтому оба симптома пропадают вместе.
const BAR_WIDTH_PX = 2
const BAR_GAP_PX = 1
const BAR_FOOTPRINT_PX = BAR_WIDTH_PX + BAR_GAP_PX

// Дорожка уровня — диагностика, а не украшение: при отказе в доступе к
// микрофону macOS отдаёт поток нулей вместо ошибки, и пользователь должен
// с одного взгляда отличать настоящую тишину от настоящей речи. Прежний
// ЖЁСТКИЙ множитель (v * 100 * 3) был откалиброван под одно устройство: речь
// этого пользователя пикует на 0.0385 (см. лог «пиковая амплитуда»), что
// давало на дорожке ~11%, а после зеркалирования — и вовсе ~5% на сторону,
// то есть не читалось вообще. Чувствительность микрофонов различается на
// порядок, поэтому нужна нормализация от сигнала текущей записи, а не
// константа, подогнанная под одно железо.
//
// REF_MIN — пол делителя нормализации. Без него в записи, где нет ничего,
// кроме шума (например при отказе в доступе — на деле чистые нули, но в
// общем случае это может быть гул тракта), самый громкий ШУМ становится
// эталоном и растягивается на всю дорожку — тишина и сигнал становятся
// неотличимы, а это и есть инвариант, который дорожка обязана сохранять.
// Делитель никогда не опускается ниже REF_MIN — тихий вход НЕ МОЖЕТ быть
// растянут вверх, структурно, а не по соглашению. Не убирать пол ради
// «упрощения»: без него ломается единственная причина существования дорожки.
// Подобрано так, чтобы пик речи этого пользователя (0.0385) читался примерно
// как половина дорожки, а шум микрофона (~0.001) оставался тонкой полоской
// у оси — численную проверку см. в отчёте по фиче.
const REF_MIN = 0.15

// Множитель затухания скользящего максимума на один кадр `rec:level` (кадр —
// раз в 50 мс, см. LEVEL_EMIT_INTERVAL на бэкенде). Растёт мгновенно —
// Math.max(v, ...) — угасает медленно: за ~2 секунды паузы между словами
// (≈40 кадров) максимум оседает лишь до 0.995^40 ≈ 82% пикового значения,
// так что дорожка не «проседает» в паузах и следующее слово не подскакивает
// к максимальной высоте на пустом месте.
const RUNNING_MAX_DECAY = 0.995

const LABEL: Record<Phase, string> = {
  idle: 'Hold the hotkey and speak',
  recording: 'Recording…',
  transcribing: 'Transcribing…',
  ready: 'Done — Paste sends the text back to where you were',
  error: 'Error',
}

type AccessibilityErrorPayload = { message: string; pane: PrivacyPane }
// icon — уже готовый data: URL или null (нет иконки/не удалось сконвертировать).
type SourceAppPayload = { name: string; icon: string | null }

export function Overlay() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [permissionPane, setPermissionPane] = useState<PrivacyPane | null>(null)
  const [copied, setCopied] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  const [hasRecording, setHasRecording] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [sourceApp, setSourceApp] = useState<SourceAppPayload | null>(null)

  // Хоткеи Paste/Copy — окно-локальные (см. shortcut.ts), не глобальные:
  // регистрируются здесь обычным keydown, а не через tauri-plugin-global-shortcut.
  // Состояние — чтобы бейдж на кнопке перерисовался при смене настройки;
  // окно overlay не пересоздаётся между записями (скрывается/показывается),
  // поэтому значения грузятся один раз на mount и дальше обновляются по
  // событию settings:changed, а не только при повторном монтировании.
  const [pasteShortcut, setPasteShortcut] = useState(DEFAULT_PASTE_SHORTCUT)
  const [copyShortcut, setCopyShortcut] = useState(DEFAULT_COPY_SHORTCUT)

  // Как и с textRef ниже: глобальный keydown-обработчик вешается один раз на
  // mount, поэтому ему нужен всегда актуальный снимок хоткеев через ref, а
  // не значение, захваченное в замыкании на момент навешивания.
  const pasteShortcutRef = useRef(pasteShortcut)
  const copyShortcutRef = useRef(copyShortcut)
  useEffect(() => {
    pasteShortcutRef.current = pasteShortcut
  }, [pasteShortcut])
  useEffect(() => {
    copyShortcutRef.current = copyShortcut
  }, [copyShortcut])

  useEffect(() => {
    getSettings().then((s: Settings) => {
      setPasteShortcut(s.pasteShortcut)
      setCopyShortcut(s.copyShortcut)
    })
    const un = listen<Settings>('settings:changed', (e) => {
      setPasteShortcut(e.payload.pasteShortcut)
      setCopyShortcut(e.payload.copyShortcut)
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Скользящий максимум текущей записи — держит только высоту дорожки, не
  // должен сам по себе вызывать ре-рендер (это делает `levels`). Живёт
  // отдельно от React-состояния и обнуляется на rec:start: иначе один
  // громкий выкрик в начале приглушил бы дорожку во всех следующих записях.
  const runningMaxRef = useRef(REF_MIN)

  // Всегда актуальное значение text для обработчиков, которые не должны
  // зависеть от момента, когда был создан их замыкание (глобальный keydown
  // ниже вешается один раз на mount) — иначе Enter вставлял бы вечно пустую
  // строку, захваченную при первом рендере, вместо реально отредактированного
  // текста.
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])

  // Текущий предел массива levels — сколько баров помещается по ширине
  // контейнера прямо сейчас. Не состояние: пересчитывается по измерению
  // DOM (ResizeObserver), а не рендером, и читается только в момент прихода
  // нового отсчёта — сам пересчёт не должен вызывать лишний ре-рендер.
  // Дефолт 1 — консервативная заглушка на время до первого измерения (эффект
  // ниже пересчитывает его синхронно на mount, до первого кадра rec:level).
  const levelsCapRef = useRef(1)
  const levelsContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = levelsContainerRef.current
    if (!el) return
    const recalcCap = () => {
      const cap = Math.max(1, Math.floor(el.clientWidth / BAR_FOOTPRINT_PX))
      levelsCapRef.current = cap
      // Если панель ужалась, подрезаем немедленно — иначе лишние бары ждали
      // бы следующего кадра rec:level, чтобы дорожка снова уложилась в предел
      // (overflow: hidden на контейнере и так не даст им нарисоваться за
      // краем, но лучше не полагаться только на визуальный клип).
      setLevels((prev) => (prev.length > cap ? prev.slice(prev.length - cap) : prev))
    }
    recalcCap()
    const ro = new ResizeObserver(recalcCap)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const subs = [
      listen('rec:start', () => {
        setPhase('recording')
        setText('')
        setError('')
        setPermissionPane(null)
        setLevels([])
        runningMaxRef.current = REF_MIN
        // Шапка приходит отдельным событием с фонового потока чуть позже —
        // старое приложение не должно провисеть над новой записью до тех пор.
        setSourceApp(null)
      }),
      listen('rec:stop', () => {
        setPhase('transcribing')
        // Стоп означает, что запись — пусть даже пустая — уже лежит в
        // состоянии на бэкенде и доступна через get_last_recording.
        setHasRecording(true)
      }),
      listen<number>('rec:level', (e) => {
        const v = e.payload
        // Растёт мгновенно до текущего пика, угасает медленно — см.
        // комментарий у RUNNING_MAX_DECAY.
        runningMaxRef.current = Math.max(v, runningMaxRef.current * RUNNING_MAX_DECAY)
        // Пол REF_MIN — структурная гарантия инварианта: делитель не может
        // провалиться в шум, поэтому v = 0 (и вообще любая тишина) не может
        // быть растянута до заметной высоты.
        const ref = Math.max(REF_MIN, runningMaxRef.current)
        const height = Math.min(100, Math.sqrt(v / ref) * 100)
        setLevels((prev) => {
          const cap = levelsCapRef.current
          const next = prev.length >= cap ? prev.slice(prev.length - cap + 1) : prev
          return [...next, height]
        })
      }),
      listen<SourceAppPayload>('app:source', (e) => {
        setSourceApp(e.payload)
      }),
      listen<string>('transcript', (e) => {
        setText(e.payload)
        setPhase('ready')
      }),
      listen<string>('error', (e) => {
        setError(e.payload)
        setPhase('error')
        // Обычная ошибка может прийти после отказа в правах — флаг из того
        // случая не должен пережить её и оставить лишнюю кнопку в панели.
        setPermissionPane(null)
      }),
      listen<AccessibilityErrorPayload>('error:accessibility', (e) => {
        setError(e.payload.message)
        setPermissionPane(e.payload.pane)
        setPhase('error')
      }),
    ]
    return () => {
      subs.forEach((p) => p.then((un) => un()))
    }
  }, [])

  const toggleMic = () => {
    // Во время расшифровки микрофон неактивен: предыдущая запись ещё
    // обрабатывается, и вторая перетёрла бы её результат.
    if (phase === 'transcribing') return
    if (phase === 'recording') stopRecording()
    else startRecording()
  }

  // I6: провал вставки/копирования раньше не производил вообще ничего —
  // успех и отказ были неотличимы. Отказ идёт в уже существующую
  // поверхность ошибок, успех копирования — во временное подтверждение.
  //
  // Читает textRef, а не state `text` напрямую: вызывается и по клику (где
  // замыкание и так свежее), и из глобального обработчика Enter ниже, чей
  // эффект навешан один раз на mount — без ref он навсегда держал бы пустую
  // строку, захваченную при первом рендере.
  const onPaste = () => {
    const value = textRef.current
    // Часть 4: пустое поле не должно пастить — так же, как кнопка Paste
    // недоступна при пустом text.
    if (!value) return
    pasteText(value).catch((e) => {
      setError(String(e))
      setPhase('error')
      setPermissionPane(null)
    })
  }

  // Читает textRef по той же причине, что и onPaste выше — вызывается и по
  // клику, и из глобального обработчика клавиш ниже. Часть 4 (Change 2):
  // пустой транскрипт не должен копироваться так же, как не должен пастить.
  const onCopy = () => {
    const value = textRef.current
    if (!value) return
    copyText(value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((e) => {
        setError(String(e))
        setPhase('error')
        setPermissionPane(null)
      })
  }

  // Единый глобальный обработчик клавиш — не на textarea, а на window. Оба
  // хоткея (Paste/Copy) обязаны срабатывать одинаково независимо от того, в
  // фокусе сейчас транскрипт, кнопка или вообще ничего (часть 3 сделала
  // транскрипт фокусируемым полем, и обработчик именно на самой textarea
  // сработал бы только когда фокус в ней).
  //
  // matchesShortcut сравнивает нажатие с НАСТРАИВАЕМЫМ хоткеем
  // (pasteShortcutRef/copyShortcutRef), а не с буквальным 'Enter' — Change 2
  // делает оба хоткея переназначаемыми в настройках. Дефолт Paste — голый
  // Enter: matchesShortcut(e, 'Enter') не совпадёт с Shift+Enter (тот
  // разбирается в 'Shift+Enter', см. shortcut.ts), поэтому перенос строки
  // при Shift+Enter по-прежнему работает штатно — тем же способом, каким это
  // раньше делала явная проверка `!e.shiftKey`. Если пользователь
  // переназначит Paste на саму Shift+Enter, поведение симметрично
  // перевернётся, и это осознанно: хоткей стал настраиваемым целиком, а не
  // только его "не-Shift-Enter" половина.
  //
  // preventDefault на совпадении одним движением снимает и штатную вставку
  // текста в textarea (перенос строки на Enter, копирование выделения на
  // Cmd+C), и активацию клика на случайно сфокусированной кнопке — «действие
  // панели побеждает, пока панель открыта» (см. план, «Конфликты»), без
  // исключения даже для Cmd+A/Cmd+C с выделенным текстом: единственный выход
  // пользователя — переназначить хоткей в настройках.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        hideOverlay()
        return
      }
      if (matchesShortcut(e, pasteShortcutRef.current)) {
        e.preventDefault()
        onPaste()
        return
      }
      if (matchesShortcut(e, copyShortcutRef.current)) {
        e.preventDefault()
        onCopy()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Текущее проигрывание — чтобы повторный Play обрывал предыдущее, а не
  // накладывал звук на звук.
  const playbackRef = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode } | null>(null)

  const stopPlayback = () => {
    const prev = playbackRef.current
    if (!prev) return
    playbackRef.current = null
    // Снимаем onended до stop(): иначе прерванный источник сам закроет уже
    // новый контекст, когда его "ended" всё же долетит асинхронно.
    prev.src.onended = null
    try {
      prev.src.stop()
    } catch {
      // Уже остановлен или доиграл сам — не страшно.
    }
    prev.ctx.close()
  }

  // ponytail: играем через WebAudio, не заводя вывод звука в Rust — так в
  // разы меньше кода, и не нужен второй аудио-поток. Если понадобится
  // проигрывание без открытой панели, тогда завести вывод в Rust.
  //
  // Кнопка Play должна быть недоступна, пока звук играет, а не перезапускать
  // проигрывание повторным нажатием. isPlaying взводится сразу по клику —
  // это закрывает окно между кликом и разрешением getLastRecording, в
  // которое иначе могло бы проскочить повторное нажатие. Гасится он на
  // любом пути, где реального проигрывания не случилось (пустой буфер,
  // отказ getLastRecording, исключение из start()), и на естественном
  // завершении в onended — иначе кнопка осталась бы залипшей disabled.
  const onPlay = () => {
    setIsPlaying(true)
    getLastRecording()
      .then((pcm) => {
        stopPlayback()
        if (!pcm || pcm.length === 0) {
          setIsPlaying(false)
          return
        }
        const ctx = new AudioContext()
        const buffer = ctx.createBuffer(1, pcm.length, 16000)
        buffer.getChannelData(0).set(Float32Array.from(pcm))
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.connect(ctx.destination)
        // Закрываем контекст после проигрывания, иначе они копятся при
        // каждом нажатии.
        src.onended = () => {
          if (playbackRef.current?.src === src) playbackRef.current = null
          setIsPlaying(false)
          ctx.close()
        }
        playbackRef.current = { ctx, src }
        src.start()
      })
      .catch((e) => {
        setIsPlaying(false)
        setError(String(e))
        setPhase('error')
        setPermissionPane(null)
      })
  }

  return (
    <div className="overlay">
      {sourceApp && (
        <div className="source-app">
          {sourceApp.icon && <img className="source-app-icon" src={sourceApp.icon} alt="" />}
          <span className="source-app-name">{sourceApp.name}</span>
        </div>
      )}
      <div className="row">
        <div
          className={`mic ${phase === 'recording' ? 'live' : ''} ${phase === 'transcribing' ? 'busy' : ''}`}
          onClick={toggleMic}
        >
          🎤
        </div>
        <div className="status">{phase === 'error' ? error : LABEL[phase]}</div>
      </div>
      <div className="levels" ref={levelsContainerRef}>
        {levels.map((height, i) => (
          <div key={i} className="level" style={{ height: `${height}%` }} />
        ))}
      </div>
      {/* Часть 3: было read-only div, теперь редактируемое поле —
          пользователь правит распознанный текст перед вставкой. Paste/Copy
          читают именно это состояние (`text`), а не исходную транскрипцию,
          так что правка реально на что-то влияет. Хоткеи Paste/Copy (Change 2:
          настраиваемые, по умолчанию Enter и Cmd+C) обрабатываются глобально
          (см. эффект выше), не здесь. */}
      <textarea
        className="transcript"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="—"
        spellCheck={false}
      />
      <div className="actions">
        <button className="primary" disabled={!text} onClick={onPaste}>
          Paste <span className="shortcut-badge">{formatShortcutBadge(pasteShortcut)}</span>
        </button>
        <button disabled={!text} onClick={onCopy}>
          {copied ? 'Copied' : (
            <>
              Copy <span className="shortcut-badge">{formatShortcutBadge(copyShortcut)}</span>
            </>
          )}
        </button>
        <button disabled={!hasRecording || isPlaying} onClick={onPlay}>
          Play
        </button>
        <button onClick={() => hideOverlay()}>Close</button>
        {permissionPane && (
          <button onClick={() => openPrivacyPane(permissionPane)}>Open Settings</button>
        )}
      </div>
    </div>
  )
}
