import { useEffect, useState } from 'react'
import {
  clearHistory,
  deleteHistoryEntry,
  listHistory,
  type HistoryEntry,
} from './api'
import { formatDuration, formatEntryDate, previewText } from './history'

/** История расшифровок — сетка плиток внутри главного окна, на месте дерева
 *  действий (см. MainWindow.tsx). Отдельный файл, а не ещё двести строк в
 *  MainWindow: у неё своё состояние (список с диска, подтверждение очистки) и
 *  ни одна её строка не нужна окну, пока история закрыта.
 *
 *  Текст расшифровок сюда приезжает ЦЕЛИКОМ, а не обрезанным на бэкенде:
 *  нажатие на плитку должно положить в редактор полный текст, и второй
 *  ходки за ним («дай запись по id») ради этого не нужно. Двести записей —
 *  это сотни килобайт, не мегабайты.
 *
 *  Приватность: ни одна строка ниже ничего не пишет в консоль — то же
 *  правило, что и на стороне Rust. В `console.error` уходит только причина
 *  отказа от бэкенда, без содержимого записей. */
export function HistoryView({ onPick }: { onPick: (entry: HistoryEntry) => void }) {
  // null — ещё грузим; [] — история пуста. Разные вещи: у пустой истории
  // своё объяснение, а мигать им, пока читается файл, незачем.
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)

  // Читаем на монтировании — то есть каждый раз, когда историю открывают
  // заново: за время, что она была закрыта, в неё успели дописаться новые
  // расшифровки.
  useEffect(() => {
    listHistory()
      .then(setEntries)
      .catch((e) => {
        setEntries([])
        setError(String(e))
      })
  }, [])

  // Подтверждение очистки не должно быть ловушкой — Escape закрывает его, как
  // и слой «нет права на вставку» в обоих окнах.
  //
  // Слушатель на перехвате и с stopImmediatePropagation, потому что окно
  // держит свой обработчик Escape (закрывает историю). Порядок двух
  // window-слушателей на одной фазе зависит от порядка навешивания, а тот у
  // главного окна меняется на каждый рендер, — поэтому важно, что ОБА исхода
  // безопасны: либо закрывается диалог, либо закрывается вся история вместе с
  // ним. Ни один из них ничего не удаляет.
  useEffect(() => {
    if (!confirmingClear) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setConfirmingClear(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [confirmingClear])

  // Удаление ОДНОЙ записи — без подтверждения, в отличие от очистки всей
  // истории. Это не недосмотр: убрать сказанное должно быть быстро. Кнопка
  // удаления — приватный инструмент, и ставить на пути к нему диалог значит
  // делать приватность неудобнее, чем всё остальное в приложении. Цена
  // ошибки — одна запись, цена очистки — весь журнал.
  const onDelete = (entry: HistoryEntry) => {
    deleteHistoryEntry(entry.id)
      .then(() => {
        setEntries((prev) => (prev ? prev.filter((e) => e.id !== entry.id) : prev))
        setError(null)
      })
      .catch((e) => {
        // Не убираем плитку из списка: она на диске осталась, и показывать
        // её удалённой значило бы соврать ровно в том месте, где пользователь
        // рассчитывает на обратное.
        console.error('история: запись не удалена:', String(e))
        setError(String(e))
      })
  }

  const onClearConfirmed = () => {
    setConfirmingClear(false)
    clearHistory()
      .then(() => {
        setEntries([])
        setError(null)
      })
      .catch((e) => {
        console.error('история: не очищена:', String(e))
        setError(String(e))
      })
  }

  const count = entries?.length ?? 0

  return (
    <div className="mw-history">
      {error && (
        <div className="mw-error">
          <span>{error}</span>
          <div className="mw-error-actions">
            <button onClick={() => setError(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Шапка есть всегда, когда в истории что-то есть: счётчик слева,
          очистка справа. Пока история грузится или пуста — шапки нет,
          очищать нечего. */}
      {count > 0 && (
        <div className="mw-history-head">
          <span className="mw-history-count">
            {count} {count === 1 ? 'transcript' : 'transcripts'}
          </span>
          <button className="mw-history-clear" onClick={() => setConfirmingClear(true)}>
            Clear all
          </button>
        </div>
      )}

      {entries !== null && count === 0 && (
        // Пустая сетка ничего не объясняет — короткий текст объясняет.
        <p className="mw-history-empty">
          Nothing here yet. Every transcript you dictate lands in this list, and opening one puts
          its full text back into the editor above.
        </p>
      )}

      {/* Плитка — для УЗНАВАНИЯ, а не для чтения: дата, длительность и начало
          текста. Полный текст кладётся в редактор по нажатию.
          ponytail: поиска по тексту нет — двести записей просматриваются
          глазами; добавить, если потолок истории когда-нибудь поднимут. */}
      {count > 0 && (
        <div className="history-grid">
          {entries!.map((entry) => (
            <div className="history-tile" key={entry.id}>
              <button
                className="history-tile-open"
                onClick={() => onPick(entry)}
                title="Put this transcript back into the editor"
              >
                <span className="history-tile-head">
                  {/* id — это и есть время создания в UTC-миллисекундах (см.
                      history.rs); показываем его в местном времени. */}
                  <span className="history-tile-date">{formatEntryDate(entry.id)}</span>
                  <span className="shortcut-badge">{formatDuration(entry.durationSecs)}</span>
                </span>
                <span className="history-tile-text">{previewText(entry.text)}</span>
              </button>
              <button
                className="history-tile-delete"
                onClick={() => onDelete(entry)}
                title="Delete this transcript"
                aria-label="Delete this transcript"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Очистка спрашивает подтверждение: она безвозвратна и, в отличие от
          модели, заново не скачивается. Тот же модальный слой, что у «нет
          права на вставку» (.modal-* в styles.css) — материал общий, свой
          здесь только текст. */}
      {confirmingClear && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Clear history">
            <p className="modal-text">
              Delete all {count} {count === 1 ? 'transcript' : 'transcripts'}? They are only stored
              on this Mac and there is no way to get them back.
            </p>
            <div className="modal-actions">
              <button className="primary" onClick={onClearConfirmed}>
                Delete everything
              </button>
              <button onClick={() => setConfirmingClear(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
