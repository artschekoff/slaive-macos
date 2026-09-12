// Проверка на столкновение назначенных комбинаций.
//
// Без неё конфликт проваливался МОЛЧА: назначил действию ту же комбинацию, что
// у глобального хоткея записи, — и действие просто переставало срабатывать.
// Глобальный хоткей перехватывает клавишу системно, до окна событие не
// доходит, и внешне это неотличимо от «кнопка сломалась». Столкновение двух
// оконных комбинаций между собой не лучше: срабатывает та, чей обработчик
// оказался первым, а какая именно — зависит от порядка навешивания.
//
// Проверка синхронная и чистая, поэтому лежит отдельно от React и покрыта
// тестами: логика «какая комбинация с какой конфликтует» дороже в отладке,
// чем в написании теста.

/** Поля настроек, хранящие комбинацию, и их подписи для сообщения об ошибке.
 *  Порядок — как в интерфейсе настроек, чтобы сообщение указывало на поле,
 *  которое пользователь найдёт глазами. */
export const SHORTCUT_FIELDS = [
  { key: 'hotkey', label: 'Record hotkey' },
  { key: 'pasteShortcut', label: 'Paste (panel)' },
  { key: 'copyShortcut', label: 'Copy (panel)' },
  { key: 'mainPasteShortcut', label: 'Paste (main window)' },
  { key: 'translateShortcut', label: 'Translate' },
  { key: 'askAiShortcut', label: 'Ask AI' },
  { key: 'fixShortcut', label: 'Fix' },
  { key: 'shortenShortcut', label: 'Shorten' },
  { key: 'summarizeShortcut', label: 'Summarize' },
] as const

export type ShortcutField = (typeof SHORTCUT_FIELDS)[number]['key']

/** Комбинации сравниваются как есть: их порождает один и тот же сериализатор
 *  (`shortcut.ts`), поэтому «Super+KeyS» приходит в одном и том же написании
 *  из любого поля. Нормализовать нечего, а попытка нормализовать здесь
 *  разошлась бы с тем, как комбинации сравниваются при самом нажатии. */
export function findShortcutConflict(
  accel: string,
  field: ShortcutField,
  settings: Partial<Record<ShortcutField, string>>
): string | null {
  if (!accel) return null
  for (const { key, label } of SHORTCUT_FIELDS) {
    if (key === field) continue
    if (settings[key] === accel) return label
  }
  return null
}

/** Сообщение объясняет не только «занято», но и ЧЕМ именно кончится
 *  столкновение — иначе человек решит, что проверка придирается. */
export function conflictMessage(accel: string, takenBy: string): string {
  return (
    `${accel} is already assigned to "${takenBy}". ` +
    `Two actions on one combination means one of them silently never fires. ` +
    `Change that one first, or pick a different combination here.`
  )
}
