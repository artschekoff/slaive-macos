import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  getSettings,
  saveSettings,
  listModels,
  downloadModel,
  type Settings as S,
  type ModelInfo,
  type Progress,
} from './api'

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [saved, setSaved] = useState(false)

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

  if (!s) return <div className="settings">Загрузка…</div>

  const patch = (p: Partial<S>) => {
    setS({ ...s, ...p })
    setSaved(false)
  }

  const onSave = async () => {
    await saveSettings(s)
    setSaved(true)
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
      <h1>Настройки</h1>

      <label>
        Горячая клавиша
        <input value={s.hotkey} onChange={(e) => patch({ hotkey: e.target.value })} />
      </label>
      <p className="hint">
        Держи эту комбинацию, чтобы записывать голос. По умолчанию <code>Ctrl+Space</code> —
        в macOS она может быть занята переключением раскладки. Отключи её в
        «Системные настройки → Клавиатура → Сочетания клавиш → Источники ввода»
        или выбери другую комбинацию.
      </p>

      <label>
        Язык распознавания
        <select
          value={s.language}
          onChange={(e) => patch({ language: e.target.value as S['language'] })}
        >
          <option value="auto">Определять автоматически</option>
          <option value="ru">Русский</option>
          <option value="en">Английский</option>
        </select>
      </label>

      <label>
        Путь к модели whisper (ggml-*.bin)
        <input
          value={s.modelPath ?? ''}
          placeholder="/путь/к/ggml-small.bin"
          onChange={(e) => patch({ modelPath: e.target.value || null })}
        />
      </label>

      <div className="download">
        <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} · {m.sizeMb} МБ
            </option>
          ))}
        </select>
        <button onClick={onDownload} disabled={busy}>
          {busy ? 'Скачиваю…' : 'Скачать'}
        </button>
      </div>
      {progress && progress.total > 0 && (
        <progress value={progress.downloaded} max={progress.total} />
      )}
      {downloadError && <span className="err">{downloadError}</span>}

      <button className="primary" onClick={onSave}>
        Сохранить
      </button>
      {saved && <span className="ok">Сохранено</span>}
    </div>
  )
}
