import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  clearHistory,
  deleteHistoryEntry,
  listHistory,
  type HistoryEntry,
} from './api'
import { formatDuration, formatEntryDate, previewText } from './history'
import { clampSelectionIndex } from './menu-state'
import { moveGridDown, moveGridLeft, moveGridRight, moveGridUp } from './history-grid-nav'

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
export function HistoryView({
  onPick,
  arrowsAvailable,
}: {
  onPick: (entry: HistoryEntry) => void
  // Достаются ли сейчас стрелки/Home/End сетке БЕЗ настоящего DOM-фокуса на
  // ней — та же проверка (режим Vim + отложенный оператор), что и у столбца
  // действий, вычисленная в MainWindow.tsx (см. arrow-routing.ts и отчёт).
  // Функция, а не готовое булево значение: пересчитывается на каждое
  // нажатие, потому что "ждёт ли vim аргумент оператора" меняется без
  // ре-рендера React — замороженный на момент рендера ответ мог бы соврать.
  arrowsAvailable: () => boolean
}) {
  // null — ещё грузим; [] — история пуста. Разные вещи: у пустой истории
  // своё объяснение, а мигать им, пока читается файл, незачем.
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  // Подсветка стрелками в сетке — тот же принцип, что и selectedIndex в
  // MainWindow.tsx (см. отчёт): не часть данных истории, а то, какая плитка
  // сейчас выбрана клавиатурой.
  const [selectedIndex, setSelectedIndex] = useState(0)
  const count = entries?.length ?? 0
  // Индекс всегда в границах ТЕКУЩЕГО списка — та же подстраховка, что у
  // clampSelectionIndex в MainWindow: удаление плитки (см. onDelete ниже)
  // может оставить selectedIndex указывающим за конец укоротившегося списка
  // ДО того, как следующий рендер успеет его поправить.
  const selectedGridIndex = clampSelectionIndex(selectedIndex, count)
  // Контейнер сетки — единственный tab-стоп (тот же паттерн listbox, что у
  // столбца действий в MainWindow.tsx): плитки открытия получают
  // tabIndex={-1}, крестик удаления — тоже (см. ниже), чтобы Tab уводил из
  // истории целиком, а не блуждал по 2×N кнопкам внутри неё.
  const gridRef = useRef<HTMLDivElement | null>(null)
  // DOM-узел ВЫБРАННОЙ клавиатурой плитки — чтобы подтягивать её в видимую
  // область (сетка прокручивается на двухстах записях, см. её собственный
  // комментарий ниже про потолок истории). Ставится в JSX через тернарник
  // (см. рендер), а не на каждой плитке безусловно — только одна плитка за
  // раз бывает выбрана.
  const selectedTileRef = useRef<HTMLDivElement | null>(null)

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

  // Индекс подстраивается под РЕАЛЬНЫЙ размер списка каждый раз, когда тот
  // меняется (первая загрузка, удаление одной записи, полная очистка) — тем
  // же clampSelectionIndex, что и подстраховка выше, но здесь он не просто
  // страхует рендер, а фиксирует новое значение в состоянии: иначе после
  // удаления последней в списке плитки selectedIndex остался бы указывать
  // на несуществующий хвост до следующего нажатия стрелки.
  useEffect(() => {
    setSelectedIndex((i) => clampSelectionIndex(i, count))
  }, [count])

  // Выбранная плитка подтягивается в видимую область сетки при каждом
  // переходе — без этого стрелочная навигация молча уходила бы за пределы
  // прокрученной области на длинной истории, и подсветка становилась бы
  // невидимой (тот же дефект, от которого предостерегает отчёт про сам факт
  // видимости выбора).
  useEffect(() => {
    selectedTileRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedGridIndex])

  // Число колонок сетки — читается из реального computed-стиля, а не
  // зашито константой: .history-grid использует auto-fill (см. styles.css),
  // число колонок зависит от ширины окна и может отличаться от "трёх при
  // 720px" из её собственного комментария, если окно когда-нибудь станет
  // resizable. Читается заново на каждое нажатие Вверх/Вниз, а не кэшируется
  // — дешевле и честнее, чем следить за resize отдельным слушателем.
  const currentColumns = (): number => {
    const el = gridRef.current
    if (!el) return 1
    const cols = getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length
    return cols > 0 ? cols : 1
  }

  // Общая логика клавиш сетки — используется и собственным onKeyDown
  // контейнера (когда на нём уже настоящий DOM-фокус, путь Tab), и оконным
  // слушателем ниже (путь без Tab, см. его комментарий). Enter внутри неё —
  // намеренно: этой веткой пользуется ТОЛЬКО фокусный путь, оконный
  // слушатель Enter к ней не пропускает (см. его собственный комментарий,
  // причина та же, что и в MainWindow.tsx про slaivePaste).
  const handleGridKey = (e: KeyboardEvent | ReactKeyboardEvent<HTMLDivElement>): boolean => {
    if (count === 0) return false
    const cols = currentColumns()
    switch (e.key) {
      case 'ArrowDown':
        setSelectedIndex((i) => moveGridDown(clampSelectionIndex(i, count), count, cols))
        return true
      case 'ArrowUp':
        setSelectedIndex((i) => moveGridUp(clampSelectionIndex(i, count), count, cols))
        return true
      case 'ArrowRight':
        setSelectedIndex((i) => moveGridRight(clampSelectionIndex(i, count), count))
        return true
      case 'ArrowLeft':
        setSelectedIndex((i) => moveGridLeft(clampSelectionIndex(i, count), count))
        return true
      case 'Home':
        setSelectedIndex(0)
        return true
      case 'End':
        setSelectedIndex(count - 1)
        return true
      case 'Enter': {
        const entry = entries?.[selectedGridIndex]
        if (entry) onPick(entry)
        return true
      }
      default:
        return false
    }
  }

  // Стрелки/Home/End без предварительного Tab — тот же механизм и та же
  // причина, что у столбца действий в MainWindow.tsx (см. arrow-routing.ts и
  // отчёт): пока сетка ещё не получила настоящий DOM-фокус, эти клавиши
  // достаются ей только когда Vim в NORMAL и не ждёт моушен оператора.
  // Guard по document.activeElement — чтобы не удваивать шаг, когда фокус
  // УЖЕ на сетке (тогда клавишу и так поймает её собственный onKeyDown ниже
  // через обычный bubble). Enter сюда не пропускается тем же самым guard'ом
  // (`e.key === 'Enter'` в самом начале) — по той же причине, что и в
  // MainWindow.tsx: первое же Вверх/Вниз/Home/End переводит фокус на сетку
  // по-настоящему, и дальше Enter достаётся её НЕИЗМЕНЁННОМУ обработчику.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') return
      if (document.activeElement === gridRef.current) return
      if (!arrowsAvailable()) return
      if (handleGridKey(e)) {
        e.preventDefault()
        gridRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

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
          глазами; добавить, если потолок истории когда-нибудь поднимут.

          role="listbox"/"option" + aria-activedescendant — тот же
          управляемый фокус одного составного виджета, что у столбца
          действий в MainWindow.tsx (см. её комментарий и отчёт): контейнер
          — единственный tab-стоп, кнопки открытия исключены из обхода Tab
          (tabIndex={-1}), крестик удаления — тоже (см. отчёт: он не должен
          становиться отдельной остановкой в обходе стрелками — только
          мышь/клик). Клавиатурного удаления в этой версии нет: цена ошибки
          у необратимого действия слишком высока, чтобы вешать его на
          клавишу рядом со стрелками навигации без явного запроса на это. */}
      {count > 0 && (
        <div
          ref={gridRef}
          className="history-grid"
          role="listbox"
          aria-label="Transcript history"
          tabIndex={0}
          aria-activedescendant={`history-option-${entries![selectedGridIndex].id}`}
          onKeyDown={(e) => {
            // Vim-навигация hjkl — только на фокусном пути (этот обработчик):
            // пока фокус в редакторе, hjkl остаются vim-моушенами текста, и
            // оконный слушатель выше их намеренно не трогает. Голые клавиши,
            // без модификаторов — ⌘-хоткеи окна не должны двигать выбор.
            if (!e.metaKey && !e.ctrlKey && !e.altKey) {
              const arrow = { h: 'ArrowLeft', j: 'ArrowDown', k: 'ArrowUp', l: 'ArrowRight' }[
                e.key
              ]
              if (arrow) {
                if (handleGridKey({ key: arrow } as ReactKeyboardEvent<HTMLDivElement>))
                  e.preventDefault()
                return
              }
            }
            if (handleGridKey(e)) e.preventDefault()
          }}
        >
          {entries!.map((entry, i) => {
            const selected = i === selectedGridIndex
            return (
              <div
                className={`history-tile${selected ? ' is-selected' : ''}`}
                key={entry.id}
                ref={selected ? selectedTileRef : undefined}
              >
                <button
                  id={`history-option-${entry.id}`}
                  role="option"
                  aria-selected={selected}
                  tabIndex={-1}
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
                  tabIndex={-1}
                  onClick={() => onDelete(entry)}
                  title="Delete this transcript"
                  aria-label="Delete this transcript"
                >
                  ×
                </button>
              </div>
            )
          })}
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
