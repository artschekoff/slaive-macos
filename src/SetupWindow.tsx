// Окно Setup: чек-лист готовности при первом запуске и по пункту трея.
// Показывает, чего не хватает (модель, права macOS, хоткей, лицензия), и у
// каждой непройденной строки — кнопку, ведущую туда, где это чинится.
// Все решения «что проверять и как» живут на бэкенде (commands::setup_report)
// — окно только рисует список и перечитывает его.
//
// Два режима одного окна: пока онбординг не завершён (report.initial),
// позеленевший чек-лист сменяется поздравлением с кнопкой OK — она пишет
// маркер на диск, и с этого момента окно навсегда становится обычной
// диагностикой без поздравлений (см. setup_mark_complete в commands.rs).
import { useEffect, useRef, useState } from 'react'
import { hideSetupWindow, resolveSetup, setupMarkComplete, setupReport, type SetupReport } from './api'

export function SetupWindow() {
  // null — первый отчёт ещё не пришёл (Automation-проба может ждать ответа
  // на системный диалог; см. setup_report) — показываем «Checking…».
  const [report, setReport] = useState<SetupReport | null>(null)
  // Защита от наложения: Automation-проба может висеть на системном
  // диалоге дольше интервала, и без флага опросы бы громоздились в очередь.
  const inFlightRef = useRef(false)

  const refresh = () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setupReport()
      .then(setReport, () => {})
      .finally(() => {
        inFlightRef.current = false
      })
  }

  useEffect(() => {
    refresh()
    // Статусы обновляются сами: пользователь выдаёт право в System
    // Settings и просто видит, как строка зеленеет, — никакого Re-check.
    // Опрос только пока окно видимо: спрятанное (крестик прячет, не
    // закрывает — см. main.rs) не должно дёргать osascript-пробу вечно.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, 2000)
    return () => clearInterval(id)
  }, [])

  const checks = report?.checks ?? null
  const allRequiredOk = checks?.every((c) => c.ok || !c.required) ?? false

  // Окно открыла автоматика старта (что-то было красным), онбординг давно
  // пройден, и всё дозеленело — держать окно больше незачем, прячемся
  // сами. Окно из трея (autoOpened=false) не прячется: человек пришёл
  // смотреть. Первичная настройка (initial) вместо этого показывает
  // поздравление ниже.
  useEffect(() => {
    if (report && report.autoOpened && !report.initial && allRequiredOk) {
      void hideSetupWindow()
    }
  }, [report, allRequiredOk])

  // Онбординг дозрел: всё обязательное зелёное и маркер ещё не записан.
  if (report && report.initial && allRequiredOk) {
    return (
      <div className="settings chassis chassis-flush setup setup-done">
        <h1>You're set up</h1>
        <p className="hint">
          Everything Slaive needs is in place. Press the global hotkey in any app, speak, release
          — the text appears where you were typing. This window won't bother you again.
        </p>
        <div className="download">
          <button type="button" className="primary" onClick={() => void setupMarkComplete()}>
            OK
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="settings chassis chassis-flush setup">
      <h1>Setup check</h1>
      <p className="hint">
        {checks === null
          ? 'Checking… macOS may show a permission dialog — that is part of the check.'
          : allRequiredOk
            ? 'Everything Slaive needs is in place. You can close this window.'
            : 'A few things need attention before dictation works end to end.'}
      </p>
      {checks?.map((c) => (
        <div key={c.id} className={`setup-row${c.ok ? ' ok' : c.required ? ' fail' : ''}`}>
          <span className="setup-mark" aria-hidden="true">
            {c.ok ? '✓' : c.required ? '✕' : '—'}
          </span>
          <div className="setup-text">
            <div className="setup-title">{c.title}</div>
            <div className="hint">{c.detail}</div>
          </div>
          {c.action && (
            <button type="button" onClick={() => void resolveSetup(c.id).then(refresh)}>
              {c.action}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
