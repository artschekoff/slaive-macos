import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  getSettings,
  saveSettings,
  listModels,
  downloadModel,
  validateHotkey,
  type SettingsResponse as S,
  type ModelInfo,
  type Progress,
} from './api'

// «Запись хоткея нажатием»: клавиши-модификаторы сами по себе не образуют
// комбинацию — ждём, пока к ним добавится обычная клавиша.
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight',
])

function accelerator(e: KeyboardEvent): string | null {
  // Одни модификаторы — не комбинация: ждём обычную клавишу.
  if (MODIFIER_CODES.has(e.code)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  parts.push(e.code)
  return parts.join('+')
}

// Машинный формат (`Ctrl+Space`) хранится как есть; здесь — только то, как
// он показывается пользователю (`Ctrl + Space`, `Super` -> `Cmd` на macOS).
function displayHotkey(accel: string): string {
  return accel
    .split('+')
    .map((part) => (part === 'Super' ? 'Cmd' : part))
    .join(' + ')
}

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

  const [capturingHotkey, setCapturingHotkey] = useState(false)
  const [hotkeyError, setHotkeyError] = useState('')

  useEffect(() => {
    getSettings().then(setS)
  }, [])

  const [models, setModels] = useState<ModelInfo[]>([])
  const [choice, setChoice] = useState('small')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState(false)
  const [downloadError, setDownloadError] = useState('')

  useEffect(() => {
    listModels().then(setModels)
    const un = listen<Progress>('model:progress', (e) => setProgress(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Слушаем нажатие только пока идёт запись хоткея; Escape отменяет её и
  // оставляет прежнюю комбинацию.
  useEffect(() => {
    if (!capturingHotkey) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setCapturingHotkey(false)
        return
      }
      const accel = accelerator(e)
      if (!accel) return // одни модификаторы — продолжаем ждать
      setCapturingHotkey(false)

      if (!(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) {
        setHotkeyError(
          'Global hotkey needs at least one modifier (Ctrl, Alt, Shift, or Cmd) — otherwise it ' +
            'would capture this key in every app. Try a different combination.'
        )
        return
      }

      setHotkeyError('')
      // C1: расхождение с реальным форматом global-hotkey должно всплыть
      // понятным сообщением сразу, а не мёртвым хоткеем после Save.
      validateHotkey(accel)
        .then(() => patch({ hotkey: accel }))
        .catch((e) => setHotkeyError(String(e)))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [capturingHotkey])

  if (!s) return <div className="settings">Loading…</div>

  const patch = (p: Partial<S>) => {
    // Функциональная форма: обработчик записи хоткея держит собственный
    // замкнутый useEffect, и это гарантирует правку поверх свежего
    // состояния, а не устаревшего снимка на момент начала записи.
    setS((prev) => (prev ? { ...prev, ...p } : prev))
    setSaved(false)
  }

  const onSave = async () => {
    setSaveError('')
    try {
      await saveSettings(s)
      setSaved(true)
    } catch (e) {
      // C1.3: раньше отказ уходил в необработанное отклонение промиса — ни
      // сообщения, ни «Сохранено», приложение молча оставалось со старым
      // хоткеем и пользователь не знал почему.
      setSaveError(String(e))
    }
  }

  const onDownload = async () => {
    setBusy(true)
    setDownloadError('')
    setProgress(null)
    try {
      const path = await downloadModel(choice)
      patch({ modelPath: path })
    } catch (e) {
      setDownloadError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings">
      <h1>Settings</h1>

      <label>
        Hotkey
        <button
          type="button"
          className={`hotkey-capture ${capturingHotkey ? 'recording' : ''}`}
          onClick={() => {
            setHotkeyError('')
            setCapturingHotkey(true)
          }}
        >
          {capturingHotkey ? 'Press any key combination…' : displayHotkey(s.hotkey)}
        </button>
      </label>
      {hotkeyError && <span className="err">{hotkeyError}</span>}
      {s.hotkeyOk === false && (
        <span className="err">
          The saved hotkey isn't active right now. Set a new one and save to fix it.
        </span>
      )}
      <p className="hint">
        Hold this combination to record. The default <code>Ctrl + Space</code> may be taken by
        Input Source switching on macOS. Turn that off in
        System Settings → Keyboard → Keyboard Shortcuts → Input Sources, or set a different
        combination above.
      </p>

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
        Whisper model path (ggml-*.bin)
        <input
          value={s.modelPath ?? ''}
          placeholder="/path/to/ggml-small.bin"
          onChange={(e) => patch({ modelPath: e.target.value || null })}
        />
      </label>

      <div className="download">
        <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.sizeMb} MB
            </option>
          ))}
        </select>
        <button onClick={onDownload} disabled={busy}>
          {busy ? 'Downloading…' : 'Download'}
        </button>
      </div>
      {progress &&
        (progress.total > 0 ? (
          <progress value={progress.downloaded} max={progress.total} />
        ) : (
          // I9: без Content-Length нет полосы прогресса — счётчик байт хотя
          // бы показывает, что загрузка не зависла.
          <span className="hint">
            {(progress.downloaded / 1_000_000).toFixed(1)} MB downloaded…
          </span>
        ))}
      {downloadError && <span className="err">{downloadError}</span>}

      <button className="primary" onClick={onSave}>
        Save
      </button>
      {saved && <span className="ok">Saved</span>}
      {saveError && <span className="err">{saveError}</span>}
    </div>
  )
}
