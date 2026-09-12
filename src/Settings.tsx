import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ShortcutCapture } from './ShortcutCapture'
import {
  findShortcutConflict,
  conflictMessage,
  type ShortcutField,
} from './shortcut-conflicts'
import {
  getSettings,
  saveSettings,
  listModels,
  downloadModel,
  downloadVadModel,
  useModel,
  deleteModel,
  listInputDevices,
  validateHotkey,
  listAiProviders,
  setAiKey,
  testAiConnection,
  setWindowOpacity,
  type SettingsResponse as S,
  type ModelCatalog,
  type ModelEntry,
  type InputDevices,
  type Progress,
} from './api'
import { effectiveBaseUrl, isSelectable, emptyProviderConfig, type AiProviderInfo } from './ai'
import { SECTIONS, FIRST_SECTION, type SectionId } from './settings-sections'
import {
  DEFAULT_TRANSLATE_LANGUAGES,
  parseLanguageList,
  type ActionShortcutKey,
} from './action-tree'
import { formatBytes } from './format'

// Границы ползунков. Второй источник правды рядом с Rust (audio.rs:
// MIN_GAIN/MAX_GAIN, settings.rs: MIN/MAX_VAD_THRESHOLD) — та же цена, что у
// OVERLAY_WIDTH_PX в Overlay.tsx: расхождение не ломает приложение, потому
// что Rust всё равно зажимает значение при применении (settings.json правится
// руками), но держим числа равными явно.
const MIN_GAIN = 0.5
const MAX_GAIN = 10
const MIN_VAD_THRESHOLD = 0.1
const MAX_VAD_THRESHOLD = 0.9
const MIN_WINDOW_OPACITY = 0.5
const MAX_WINDOW_OPACITY = 1

// Подписи строк раздела Shortcuts для действий главного окна — один список,
// а не пять скопированных блоков разметки: добавление действия это строка
// здесь, ключ в SettingKey и поле в Settings (см. action-tree.ts).
const ACTION_SHORTCUT_ROWS: readonly { key: ActionShortcutKey; label: string }[] = [
  { key: 'translateShortcut', label: 'Translate' },
  { key: 'askAiShortcut', label: 'Ask AI' },
  { key: 'fixShortcut', label: 'Fix' },
  { key: 'shortenShortcut', label: 'Shorten' },
  { key: 'summarizeShortcut', label: 'Summarize' },
]

const ACTION_MODIFIER_ERROR =
  'An action shortcut needs at least one modifier — a bare key would be swallowed by the Vim ' +
  'editor in the text field. Cmd combinations are the safest.'

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Открытый раздел. Первый при открытии окна, а не запомненный (см.
  // settings-sections.ts): переключение мгновенное, без анимаций — это
  // настройки, а не мастер.
  const [section, setSection] = useState<SectionId>(FIRST_SECTION)

  // Проверка на столкновение комбинаций. Раньше конфликт проваливался молча:
  // назначил действию комбинацию глобального хоткея — и действие переставало
  // срабатывать, потому что клавишу перехватывает система и до окна событие
  // не доходит. ShortcutCapture при отказе validate показывает текст ошибки и
  // НЕ применяет комбинацию, поэтому достаточно отклонить.
  const conflictCheck = useCallback(
    (field: ShortcutField, also?: (accel: string) => Promise<void>) =>
      async (accel: string) => {
        const takenBy = s ? findShortcutConflict(accel, field, s) : null
        if (takenBy) throw new Error(conflictMessage(accel, takenBy))
        if (also) await also(accel)
      },
    [s]
  )

  // Пик последней записи ДО усиления — ориентир для ползунка ниже: без него
  // выбор значения это подбор вслепую. Приходит начальным значением из
  // get_settings и обновляется событием, пока это окно открыто.
  const [peak, setPeak] = useState<number | null>(null)

  useEffect(() => {
    getSettings().then((fresh) => {
      setS(fresh)
      setPeak(fresh.lastPeak)
    })
    const un = listen<number>('rec:peak', (e) => setPeak(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // ===== Раздел Models =====
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null)
  // Какая модель качается прямо сейчас. Одна за раз: событие прогресса одно
  // на все загрузки, и второй параллельной шкале взяться неоткуда.
  const [busyId, setBusyId] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [modelError, setModelError] = useState('')

  const refreshCatalog = useCallback(() => {
    listModels()
      .then(setCatalog)
      .catch((e) => setModelError(String(e)))
  }, [])

  useEffect(() => {
    refreshCatalog()
    const un = listen<Progress>('model:progress', (e) => setProgress(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [refreshCatalog])

  const [vadProgress, setVadProgress] = useState<Progress | null>(null)
  const [vadBusy, setVadBusy] = useState(false)
  const [vadError, setVadError] = useState('')

  useEffect(() => {
    const un = listen<Progress>('vad:progress', (e) => setVadProgress(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // ===== Раздел Audio =====
  const [devices, setDevices] = useState<InputDevices>({ devices: [], defaultDevice: null })
  const [deviceError, setDeviceError] = useState('')

  const refreshDevices = useCallback(() => {
    listInputDevices()
      .then(setDevices)
      .catch((e) => setDeviceError(String(e)))
  }, [])

  useEffect(refreshDevices, [refreshDevices])

  // ===== Раздел AI =====
  const [aiProviders, setAiProviders] = useState<AiProviderInfo[]>([])
  // Черновик ключа — НЕ часть `s`: ключ никогда не приходит с бэкенда (см.
  // aiKeySet — только признак «задан»), поэтому здесь либо пусто (ничего не
  // меняем), либо новое значение, которое уйдёт в Keychain при Save.
  const [aiKeyDraft, setAiKeyDraft] = useState('')
  const [aiTestBusy, setAiTestBusy] = useState(false)
  const [aiTestResult, setAiTestResult] = useState('')
  const [aiTestError, setAiTestError] = useState('')

  useEffect(() => {
    listAiProviders().then(setAiProviders)
  }, [])

  if (!s) return <div className="settings chassis chassis-flush">Loading…</div>

  const patch = (p: Partial<S>) => {
    // Функциональная форма: обработчик записи хоткея держит собственный
    // замкнутый useEffect, и это гарантирует правку поверх свежего
    // состояния, а не устаревшего снимка на момент начала записи.
    setS((prev) => (prev ? { ...prev, ...p } : prev))
    setSaved(false)
  }

  // Правка конфигурации ОДНОГО провайдера в карте — переключение на другого
  // провайдера не трогает эту запись (см. ai.rs / бриф: у каждого своя пара
  // модель+адрес, они не должны затирать друг друга).
  const patchAiProvider = (providerId: string, p: Partial<S['ai']['providers'][string]>) => {
    patch({
      ai: {
        ...s.ai,
        providers: {
          ...s.ai.providers,
          [providerId]: { ...(s.ai.providers[providerId] ?? emptyProviderConfig()), ...p },
        },
      },
    })
  }

  const onSave = async () => {
    setSaveError('')
    try {
      // Ключ уходит в Keychain отдельной командой, ДО settings.json — он не
      // часть Settings и не должен уйти вместе с остальными полями. Пусто —
      // пользователь ничего не менял, прежний ключ (если был) остаётся как есть.
      if (aiKeyDraft.trim()) {
        await setAiKey(s.ai.provider, aiKeyDraft.trim())
        setAiKeyDraft('')
      }
      await saveSettings(s)
      setSaved(true)
      // Признак «ключ сохранён» мог поменяться — перечитываем с бэкенда,
      // а не угадываем на фронте (ключ сюда всё равно никогда не возвращается).
      const fresh = await getSettings()
      setS(fresh)
    } catch (e) {
      // C1.3: раньше отказ уходил в необработанное отклонение промиса — ни
      // сообщения, ни «Сохранено», приложение молча оставалось со старым
      // хоткеем и пользователь не знал почему.
      setSaveError(String(e))
    }
  }

  const onTestAiConnection = async () => {
    setAiTestBusy(true)
    setAiTestResult('')
    setAiTestError('')
    try {
      const result = await testAiConnection()
      setAiTestResult(result)
    } catch (e) {
      setAiTestError(String(e))
    } finally {
      setAiTestBusy(false)
    }
  }

  // Подсказка к ползунку усиления: что пришло с микрофона и во что оно
  // превращается при текущем значении. Верхняя граница усиленного пика —
  // единица: за неё сэмплы не выпускает apply_gain (иначе клиппинг).
  const gainHint =
    peak === null
      ? 'Record once and the peak level of that recording shows up here as a reference.'
      : `Last recording peaked at ${peak.toFixed(3)} → ${Math.min(1, peak * s.micGain).toFixed(
          3
        )} at current gain.`

  // Что реально окажется в подменю Translate при текущем содержимом поля —
  // через ту же функцию, что строит меню, а не через отдельный разбор рядом:
  // иначе подсказка и меню разъехались бы на первом же краевом случае
  // (пустое поле, повторы, лишние запятые).
  const parsedLanguages = parseLanguageList(s.translateLanguages)
  const translateMenuPreview =
    parsedLanguages.length > 0
      ? parsedLanguages.join(', ')
      : `${DEFAULT_TRANSLATE_LANGUAGES} (default)`

  const aiProviderInfo = aiProviders.find((p) => p.id === s.ai.provider)
  const aiConfig = s.ai.providers[s.ai.provider] ?? emptyProviderConfig()
  const aiHost = aiProviderInfo ? effectiveBaseUrl(aiProviderInfo, aiConfig.baseUrl) : ''

  const onDownload = async (id: string) => {
    setBusyId(id)
    setModelError('')
    setProgress(null)
    try {
      const path = await downloadModel(id)
      // Скачанная модель сразу становится активной — так делал и прежний
      // экран. Бэкенд уже записал путь в settings.json, здесь только
      // подтягиваем его в состояние формы.
      patch({ modelPath: path })
    } catch (e) {
      setModelError(String(e))
    } finally {
      setBusyId('')
      setProgress(null)
      refreshCatalog()
    }
  }

  const onUseModel = async (entry: ModelEntry) => {
    if (entry.state !== 'downloaded') return
    setModelError('')
    try {
      const path = await useModel(entry.id)
      patch({ modelPath: path })
    } catch (e) {
      setModelError(String(e))
    } finally {
      refreshCatalog()
    }
  }

  const onDeleteModel = async (entry: ModelEntry) => {
    setModelError('')
    try {
      await deleteModel(entry.id)
    } catch (e) {
      setModelError(String(e))
    } finally {
      refreshCatalog()
    }
  }

  const onDownloadVad = async () => {
    setVadBusy(true)
    setVadError('')
    setVadProgress(null)
    try {
      const path = await downloadVadModel()
      patch({ vadModelPath: path })
    } catch (e) {
      setVadError(String(e))
    } finally {
      setVadBusy(false)
      refreshCatalog()
    }
  }

  // Полоса прогресса или счётчик байт — общая для моделей и VAD.
  // I9: без Content-Length нет полосы прогресса, но счётчик байт хотя бы
  // показывает, что загрузка не зависла.
  const progressBar = (p: Progress) =>
    p.total > 0 ? (
      <progress value={p.downloaded} max={p.total} />
    ) : (
      <span className="hint">{(p.downloaded / 1_000_000).toFixed(1)} MB downloaded…</span>
    )

  // Сохранённое устройство, которого сейчас нет в системе. Из списка его не
  // выбрасываем — иначе выбор «сбросится сам» и это будет выглядеть багом.
  const savedDeviceMissing =
    s.inputDevice !== null && !devices.devices.includes(s.inputDevice) ? s.inputDevice : null

  const audioSection = (
    <>
      <label>
        Input device
        <div className="row-with-button">
          <select
            value={s.inputDevice ?? ''}
            onChange={(e) => patch({ inputDevice: e.target.value || null })}
          >
            <option value="">
              System default{devices.defaultDevice ? ` — ${devices.defaultDevice}` : ''}
            </option>
            {devices.devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            {savedDeviceMissing && (
              <option value={savedDeviceMissing}>{savedDeviceMissing} — not connected</option>
            )}
          </select>
          <button type="button" onClick={refreshDevices}>
            Refresh
          </button>
        </div>
      </label>
      <p className="hint">
        "System default" follows the system: change the input in macOS and Slaive follows along.
        Picking a device by name pins recording to that one — an iPhone shows up here as an
        ordinary microphone once macOS sees it. A device you plug in while this window is open
        appears after Refresh; the choice applies to the next recording, never to one in progress.
      </p>
      {savedDeviceMissing && (
        <span className="err">
          "{savedDeviceMissing}" isn't connected right now. Recordings use the system default
          microphone until it comes back.
        </span>
      )}
      {deviceError && <span className="err">{deviceError}</span>}

      <label>
        Microphone gain
        <div className="slider-row">
          <input
            type="range"
            min={MIN_GAIN}
            max={MAX_GAIN}
            step={0.1}
            value={s.micGain}
            onChange={(e) => patch({ micGain: Number(e.target.value) })}
          />
          <span className="slider-value">{s.micGain.toFixed(1)}×</span>
        </div>
      </label>
      <p className="hint">
        Multiplies the audio before speech detection and transcription. A quiet microphone hurts
        twice: whisper recognizes worse, and the voice activity detector may not see speech at all
        and cut the whole recording. The level track in the panel keeps showing the raw signal, so
        it still tells a quiet microphone apart from a dead one.
      </p>
      <p className="hint">{gainHint}</p>
    </>
  )

  const modelRow = (entry: ModelEntry) => {
    const downloading = busyId === entry.id
    const size = formatBytes(entry.diskBytes ?? entry.sizeBytes)
    return (
      <div
        key={entry.id}
        className={`model-row ${entry.state === 'active' ? 'active' : ''} ${
          entry.state === 'downloaded' ? 'clickable' : ''
        }`}
        // Нажатие на скачанную модель делает её активной — ручного
        // редактирования пути больше нет. Кнопка Use рядом дублирует это
        // намеренно: строку-кнопку не видно, пока по ней не попробуешь нажать.
        onClick={() => onUseModel(entry)}
      >
        <div className="model-main">
          <div className="model-title">
            <span className="model-label">{entry.label}</span>
            {entry.state === 'active' && <span className="model-badge">In use</span>}
            <span className="model-size">{size}</span>
          </div>
          <p className="hint">{entry.note}</p>
          {downloading && progress && progressBar(progress)}
        </div>
        <div className="model-actions" onClick={(e) => e.stopPropagation()}>
          {entry.state === 'missing' && (
            <button type="button" disabled={busyId !== ''} onClick={() => onDownload(entry.id)}>
              {downloading ? 'Downloading…' : 'Download'}
            </button>
          )}
          {entry.state === 'downloaded' && (
            <>
              <button type="button" onClick={() => onUseModel(entry)}>
                Use
              </button>
              <button type="button" onClick={() => onDeleteModel(entry)}>
                Delete
              </button>
            </>
          )}
          {entry.state === 'active' && (
            <button type="button" disabled title="Switch to another model first">
              Delete
            </button>
          )}
        </div>
      </div>
    )
  }

  const modelsSection = (
    <>
      <p className="hint">
        Multilingual weights from huggingface.co. Bigger is more accurate and slower; a model shows
        as downloaded only when its file is actually on disk, so deleting one in Finder shows up
        here too.
      </p>
      <div className="model-list">{catalog?.models.map(modelRow)}</div>
      {modelError && <span className="err">{modelError}</span>}

      <h2>Voice activity detection</h2>
      <div className="model-row">
        <div className="model-main">
          <div className="model-title">
            <span className="model-label">{catalog?.vad.label ?? 'Silero'}</span>
            {catalog?.vad.downloaded && <span className="model-badge">Installed</span>}
            <span className="model-size">
              {formatBytes(catalog?.vad.diskBytes ?? catalog?.vad.sizeBytes ?? 0)}
            </span>
          </div>
          <p className="hint">{catalog?.vad.note}</p>
          {vadProgress && progressBar(vadProgress)}
        </div>
        <div className="model-actions">
          <button type="button" onClick={onDownloadVad} disabled={vadBusy}>
            {vadBusy ? 'Downloading…' : catalog?.vad.downloaded ? 'Re-download' : 'Download'}
          </button>
        </div>
      </div>
      {vadError && <span className="err">{vadError}</span>}

      <p className="hint disk-usage">
        Models take up <strong>{formatBytes(catalog?.diskBytes ?? 0)}</strong> in{' '}
        <code>{catalog?.modelsDir ?? ''}</code>
      </p>
    </>
  )

  const recognitionSection = (
    <>
      <label>
        Transcription language
        <select
          value={s.language}
          onChange={(e) => patch({ language: e.target.value as S['language'] })}
        >
          <option value="auto">Detect automatically</option>
          <option value="ru">Russian</option>
          <option value="en">English</option>
        </select>
      </label>

      <label>
        Speech detection threshold
        <div className="slider-row">
          <input
            type="range"
            min={MIN_VAD_THRESHOLD}
            max={MAX_VAD_THRESHOLD}
            step={0.05}
            value={s.vadThreshold}
            // Порог без модели VAD ни на что не влияет — ползунок неактивен,
            // пока модель не скачана, а не молча бесполезен.
            disabled={!s.vadModelPath}
            onChange={(e) => patch({ vadThreshold: Number(e.target.value) })}
          />
          <span className="slider-value">{s.vadThreshold.toFixed(2)}</span>
        </div>
      </label>
      <p className="hint">
        How confident the detector has to be before it calls a stretch of audio speech. Lower means
        it treats more sound as speech and cuts less; higher means stricter. Not the same thing as
        microphone gain — that one changes the audio, this one only decides what counts as speech.{' '}
        {!s.vadModelPath && 'Download the detector in Models to use it.'}
      </p>

      <label>
        Dictionary
        <textarea
          className="dictionary"
          rows={5}
          value={s.dictionary}
          placeholder={'React\nKubernetes\nDocker Compose'}
          onChange={(e) => patch({ dictionary: e.target.value })}
        />
      </label>
      <p className="hint">
        Say "задеплоим на Kubernetes" and whisper writes "Кубернетес". Put the words you say in
        English here — one per line, or separated by commas — and they come back spelled the way
        you typed them. An empty field passes nothing to whisper at all.
      </p>
    </>
  )

  const shortcutsSection = (
    <>
      <label>
        Hotkey
        <ShortcutCapture
          value={s.hotkey}
          onChange={(accel) => patch({ hotkey: accel })}
          requireModifier
          modifierError={
            'A global hotkey needs at least one modifier (Ctrl, Alt, Shift, or Cmd) — otherwise ' +
            'it would capture this key in every app. Try a different combination.'
          }
          validate={conflictCheck('hotkey', validateHotkey)}
        />
      </label>
      {s.hotkeyOk === false && (
        <span className="err">
          The saved hotkey isn't active right now. Set a new one and save to fix it.
        </span>
      )}
      <p className="hint">
        Hold this combination to record. The default <code>Cmd + T</code> is "New Tab" in most apps
        — a global hotkey intercepts it system-wide. Set a different combination above if that
        conflicts with how you work.
      </p>

      <label>
        Paste shortcut
        <ShortcutCapture
          value={s.pasteShortcut}
          onChange={(accel) => patch({ pasteShortcut: accel })}
          validate={conflictCheck('pasteShortcut')}
        />
      </label>
      <p className="hint">
        Pressing this while the panel is open and has recognized text pastes it back into the app
        you came from. Shown on the Paste button as a badge.
      </p>

      <label>
        Copy shortcut
        <ShortcutCapture
          value={s.copyShortcut}
          onChange={(accel) => patch({ copyShortcut: accel })}
          validate={conflictCheck('copyShortcut')}
        />
      </label>
      <p className="hint">
        Pressing this while the panel is open and has recognized text copies it to the clipboard.
        These two only work while the panel is focused — they don't register system-wide like the
        hotkey above.
      </p>

      <h2>Main window actions</h2>
      <p className="hint">
        Each action in the main window's menu has a shortcut, shown on its button. Like Paste and
        Copy these are window-level: they fire only while the main window is focused. A modifier is
        required — the text field there is a Vim editor, and a bare key would be taken away from
        editing. Cmd combinations are the safe ones: Vim has no Cmd in its grammar. Inside a
        submenu (the languages under Translate) the entries answer to <code>Cmd + 1</code>,{' '}
        <code>Cmd + 2</code> and so on by position — those aren't stored and can't be reassigned.
      </p>

      {/* Paste главного окна — своя строка, а не пункт ACTION_SHORTCUT_ROWS:
          тот список построен по узлам дерева действий (ActionShortcutKey), а
          Paste не действие меню и в дерево не входит — он отправляет готовый
          текст обратно в приложение-источник. */}
      <label>
        Paste
        <ShortcutCapture
          value={s.mainPasteShortcut}
          onChange={(accel) => patch({ mainPasteShortcut: accel })}
          requireModifier
          modifierError={ACTION_MODIFIER_ERROR}
          validate={conflictCheck('mainPasteShortcut')}
        />
      </label>
      <p className="hint">
        Sends the text in the main window back to the app you dictated from — the same place the
        panel's Paste sends it. It has its own combination because the panel's default is a bare{' '}
        <code>Enter</code>, and in the main window Enter belongs to the editor.
      </p>

      {ACTION_SHORTCUT_ROWS.map(({ key, label }) => (
        <label key={key}>
          {label}
          <ShortcutCapture
            value={s[key]}
            // Приведение нужно только потому, что TS выводит у объекта с
            // вычисляемым ключом тип { [x: string]: string }; сам `key`
            // ограничен ActionShortcutKey, а значение — строкой, так что
            // приведение ничего не прячет.
            onChange={(accel) => patch({ [key]: accel } as Partial<S>)}
            validate={conflictCheck(key)}
            requireModifier
            modifierError={ACTION_MODIFIER_ERROR}
          />
        </label>
      ))}
    </>
  )

  const aiSection = (
    <>
      <p className="hint">
        Dictated text is sent to a third-party provider only when you press an action button —
        never in the background, never just for opening this panel.
      </p>

      <label>
        Provider
        <select
          value={s.ai.provider}
          onChange={(e) => {
            const id = e.target.value
            // Защита и на фронте: попытка выбрать нереализованного
            // провайдера не проходит — `save_settings` всё равно бы её
            // отклонила, но лучше не давать зайти в это состояние вовсе.
            if (!isSelectable(aiProviders.find((p) => p.id === id))) return
            patch({ ai: { ...s.ai, provider: id } })
            setAiKeyDraft('')
            setAiTestResult('')
            setAiTestError('')
          }}
        >
          {aiProviders.map((p) => (
            <option key={p.id} value={p.id} disabled={!p.implemented}>
              {p.label}
              {!p.implemented ? ' — not implemented yet' : ''}
            </option>
          ))}
        </select>
      </label>

      <label>
        Model
        <input
          value={aiConfig.model}
          placeholder={aiProviderInfo ? `e.g. ${aiProviderInfo.exampleModel}` : ''}
          onChange={(e) => patchAiProvider(s.ai.provider, { model: e.target.value })}
        />
      </label>

      <label>
        API key
        <input
          type="password"
          value={aiKeyDraft}
          placeholder={
            s.aiKeySet[s.ai.provider] ? 'Key saved — enter a new one to replace it' : 'Not set'
          }
          onChange={(e) => setAiKeyDraft(e.target.value)}
        />
      </label>
      {s.aiKeySet[s.ai.provider] ? (
        <span className="ok">Key saved</span>
      ) : (
        <span className="hint">No key saved for this provider yet.</span>
      )}

      <label>
        Base URL (optional)
        <input
          value={aiConfig.baseUrl ?? ''}
          placeholder={aiProviderInfo ? `Default: ${aiProviderInfo.defaultBaseUrl}` : ''}
          onChange={(e) => patchAiProvider(s.ai.provider, { baseUrl: e.target.value || null })}
        />
      </label>
      <p className="hint">
        Point this at anything that speaks the OpenAI chat completions protocol — OpenRouter,
        Ollama, a local proxy. Leave empty to use the provider's default address.
      </p>
      <p className="ai-host">Requests go to: {aiHost}</p>

      <div className="download">
        <button
          type="button"
          onClick={onTestAiConnection}
          disabled={aiTestBusy || !aiProviderInfo?.implemented}
        >
          {aiTestBusy ? 'Testing…' : 'Test connection'}
        </button>
      </div>
      {aiTestResult && <span className="ok">{aiTestResult}</span>}
      {aiTestError && <span className="err">{aiTestError}</span>}

      {/* Языки перевода — в разделе AI, а не в Recognition: там язык ВХОДА
          для whisper, и две разные настройки с одинаковым словом «язык» в
          одном разделе читались бы как одна. Здесь это «что делают с уже
          распознанным текстом» — ровно подпись этого раздела. */}
      <h2>Translation languages</h2>
      <label>
        Languages
        <textarea
          className="dictionary"
          rows={3}
          value={s.translateLanguages}
          placeholder={DEFAULT_TRANSLATE_LANGUAGES}
          onChange={(e) => patch({ translateLanguages: e.target.value })}
        />
      </label>
      <p className="hint">
        The Translate menu in the main window is built from this list — one language per line, or
        separated by commas. Plain names, the way you'd say them: the model understands "Spanish"
        as well as any code. The first nine get <code>Cmd + 1</code> … <code>Cmd + 9</code> in the
        order written here; a tenth and beyond still work, just without a number on the button.
        Leaving the field empty means "not chosen", not "no languages": the menu falls back to{' '}
        {DEFAULT_TRANSLATE_LANGUAGES}.
      </p>
      <p className="hint">Translate will offer: {translateMenuPreview}</p>
    </>
  )

  const appearanceSection = (
    <>
      <label>
        Window opacity
        <div className="slider-row">
          <input
            type="range"
            min={MIN_WINDOW_OPACITY}
            max={MAX_WINDOW_OPACITY}
            step={0.05}
            value={s.windowOpacity}
            onChange={(e) => {
              const windowOpacity = Number(e.target.value)
              patch({ windowOpacity })
              // Применяем на лету, отдельной командой, ДО Save: настройку
              // судят глазом, и цикл «выставил вслепую → сохранил →
              // посмотрел» для неё бессмысленен. Отказ глотаем — он означает
              // только «окно не отозвалось», и превращать его в красную
              // строку посреди перетаскивания ползунка не за что;
              // сохранение идёт обычным путём и об ошибке сообщит само.
              setWindowOpacity(windowOpacity).catch(() => {})
            }}
          />
          <span className="slider-value">{Math.round(s.windowOpacity * 100)}%</span>
        </div>
      </label>
      <p className="hint">
        How much of what's behind Slaive shows through. This is the window's own opacity, so it
        covers everything — the panel, the main window, the settings window, title bars and all —
        and it takes effect as you drag, before you save.
      </p>
      <p className="hint">
        It stops at 50% on purpose. Below that, text stops reading against a busy wallpaper and the
        level track in the panel stops telling a denied microphone apart from a quiet room — which
        is the one thing that track is there for. At 100% the panel still shows a little of what's
        behind it: its case is translucent by design, and that isn't this setting's doing.
      </p>
    </>
  )

  const BODY: Record<SectionId, JSX.Element> = {
    audio: audioSection,
    models: modelsSection,
    recognition: recognitionSection,
    shortcuts: shortcutsSection,
    ai: aiSection,
    appearance: appearanceSection,
  }

  const current = SECTIONS.find((sec) => sec.id === section) ?? SECTIONS[0]

  return (
    <div className="settings chassis chassis-flush">
      <nav className="settings-nav">
        {SECTIONS.map((sec) => (
          <button
            key={sec.id}
            type="button"
            className={`settings-nav-item ${sec.id === section ? 'selected' : ''}`}
            onClick={() => setSection(sec.id)}
          >
            {sec.title}
          </button>
        ))}
      </nav>

      <div className="settings-pane">
        <header className="settings-pane-head">
          <h1>{current.title}</h1>
          <p className="hint">{current.summary}</p>
        </header>
        <div className="settings-body">{BODY[current.id]}</div>
        <footer className="settings-foot">
          <button className="primary" type="button" onClick={onSave}>
            Save
          </button>
          {saved && <span className="ok">Saved</span>}
          {saveError && <span className="err">{saveError}</span>}
        </footer>
      </div>
    </div>
  )
}
