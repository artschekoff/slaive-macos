import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ShortcutCapture } from './ShortcutCapture'
import {
  getSettings,
  saveSettings,
  listModels,
  downloadModel,
  downloadVadModel,
  validateHotkey,
  type SettingsResponse as S,
  type ModelInfo,
  type Progress,
} from './api'

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')

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

  const [vadProgress, setVadProgress] = useState<Progress | null>(null)
  const [vadBusy, setVadBusy] = useState(false)
  const [vadError, setVadError] = useState('')

  useEffect(() => {
    const un = listen<Progress>('vad:progress', (e) => setVadProgress(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

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
    }
  }

  return (
    <div className="settings">
      <h1>Settings</h1>

      <label>
        Hotkey
        <ShortcutCapture
          value={s.hotkey}
          onChange={(accel) => patch({ hotkey: accel })}
          requireModifier
          validate={validateHotkey}
        />
      </label>
      {s.hotkeyOk === false && (
        <span className="err">
          The saved hotkey isn't active right now. Set a new one and save to fix it.
        </span>
      )}
      <p className="hint">
        Hold this combination to record. The default <code>Cmd + T</code> is "New Tab" in most
        apps — a global hotkey intercepts it system-wide. Set a different combination above if
        that conflicts with how you work.
      </p>

      <label>
        Paste shortcut
        <ShortcutCapture value={s.pasteShortcut} onChange={(accel) => patch({ pasteShortcut: accel })} />
      </label>
      <p className="hint">
        Pressing this while the panel is open and has recognized text pastes it back into the app
        you came from. Shown on the Paste button as a badge.
      </p>

      <label>
        Copy shortcut
        <ShortcutCapture value={s.copyShortcut} onChange={(accel) => patch({ copyShortcut: accel })} />
      </label>
      <p className="hint">
        Pressing this while the panel is open and has recognized text copies it to the clipboard.
        These two only work while the panel is focused — they don't register system-wide like the
        hotkey above.
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

      <label>
        Voice activity detection model (optional)
        <input
          value={s.vadModelPath ?? ''}
          placeholder="Not downloaded"
          onChange={(e) => patch({ vadModelPath: e.target.value || null })}
        />
      </label>
      <p className="hint">
        Skips silent stretches so pauses while you think aren't transcribed or turned into
        hallucinated captions, and transcription runs faster. Optional — everything works without
        it.
      </p>
      <div className="download">
        <button onClick={onDownloadVad} disabled={vadBusy}>
          {vadBusy ? 'Downloading…' : s.vadModelPath ? 'Re-download' : 'Download'}
        </button>
      </div>
      {vadProgress &&
        (vadProgress.total > 0 ? (
          <progress value={vadProgress.downloaded} max={vadProgress.total} />
        ) : (
          <span className="hint">
            {(vadProgress.downloaded / 1_000_000).toFixed(1)} MB downloaded…
          </span>
        ))}
      {vadError && <span className="err">{vadError}</span>}

      <button className="primary" onClick={onSave}>
        Save
      </button>
      {saved && <span className="ok">Saved</span>}
      {saveError && <span className="err">{saveError}</span>}
    </div>
  )
}
