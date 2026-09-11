import { useEffect, useState } from 'react'
import { displayShortcut, hasModifier, parseKeyEvent } from './shortcut'

// «Запись хоткея нажатием» — общий компонент для трёх полей настроек:
// глобального хоткея записи и (новых) хоткеев Paste/Copy панели. Раньше эта
// логика жила только внутри Settings.tsx и работала на один хоткей;
// вынесена сюда, чтобы Paste/Copy переиспользовали тот же UI и тот же код
// захвата, а не заводили вторую копию.
type ShortcutCaptureProps = {
  value: string
  onChange: (accel: string) => void
  // Голая клавиша без модификатора допустима не везде. У глобального хоткея
  // записи она перехватила бы клавишу во всех приложениях системы; у хоткеев
  // действий главного окна — отобрала бы её у Vim в поле текста. У Paste/Copy
  // ни того, ни другого нет, и их дефолты как раз "Enter" и "Cmd+C".
  requireModifier?: boolean
  // Почему именно здесь нужен модификатор — причина у глобального хоткея и у
  // оконных действий разная, и текст ошибки обязан её называть, иначе
  // пользователь читает неправду. Имеет смысл только вместе с requireModifier.
  modifierError?: string
  // Только у глобального хоткея: разбор через реальный парсер
  // tauri-plugin-global-shortcut ДО сохранения (см. commands::validate_hotkey).
  // Paste/Copy — обычные window-level keydown в Overlay, они этот парсер не
  // проходят и не должны — им передавать не нужно.
  validate?: (accel: string) => Promise<void>
}

const DEFAULT_MODIFIER_ERROR =
  'This shortcut needs at least one modifier (Ctrl, Alt, Shift, or Cmd). Try a different combination.'

export function ShortcutCapture({
  value,
  onChange,
  requireModifier,
  modifierError,
  validate,
}: ShortcutCaptureProps) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState('')

  // Слушаем нажатие только пока идёт запись; Escape отменяет её и оставляет
  // прежнюю комбинацию.
  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }
      const accel = parseKeyEvent(e)
      if (!accel) return // один модификатор — продолжаем ждать
      setCapturing(false)

      if (requireModifier && !hasModifier(accel)) {
        setError(modifierError ?? DEFAULT_MODIFIER_ERROR)
        return
      }

      setError('')
      if (validate) {
        validate(accel)
          .then(() => onChange(accel))
          .catch((e) => setError(String(e)))
      } else {
        onChange(accel)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [capturing, requireModifier, modifierError, validate, onChange])

  return (
    <>
      <button
        type="button"
        className={`hotkey-capture ${capturing ? 'recording' : ''}`}
        onClick={() => {
          setError('')
          setCapturing(true)
        }}
      >
        {capturing ? 'Press any key combination…' : displayShortcut(value)}
      </button>
      {error && <span className="err">{error}</span>}
    </>
  )
}
