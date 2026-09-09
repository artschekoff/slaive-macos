import { useEffect, useState } from 'react'
import { getSettings, saveSettings, type Settings as S } from './api'

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getSettings().then(setS)
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

      <button className="primary" onClick={onSave}>
        Сохранить
      </button>
      {saved && <span className="ok">Сохранено</span>}
    </div>
  )
}
