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

/** Область, в которой комбинация перехватывается.
 *
 *  - 'global' — регистрируется системно через tauri-plugin-global-shortcut
 *    (см. src-tauri/src/hotkey.rs): клавиша перехвачена ДО того, как её
 *    увидит хоть одно окно, поэтому сталкивается с чем угодно, в любой
 *    другой области.
 *  - 'panel' — оконный keydown в overlay (Overlay.tsx).
 *  - 'main' — оконный keydown в главном окне (MainWindow.tsx).
 *
 *  В фокусе всегда ровно одно окно, поэтому 'panel' и 'main' — это ДВА
 *  РАЗНЫХ окна, а не два обработчика на одном: одинаковая комбинация в них
 *  никогда не запускает оба сразу, и держать её занятой в обеих было бы
 *  избыточной строгостью, а не запасом надёжности. */
export type ShortcutScope = 'global' | 'panel' | 'main'

/** Поля настроек, хранящие комбинацию, их подписи для сообщения об ошибке и
 *  область перехвата. Порядок — как в интерфейсе настроек, чтобы сообщение
 *  указывало на поле, которое пользователь найдёт глазами.
 *
 *  Список обязан содержать КАЖДОЕ хранимое поле с комбинацией: пропущенное
 *  поле не «проверяется чуть хуже», а не проверяется вовсе — и столкновение с
 *  ним проваливается ровно тем молчанием, ради которого этот файл написан.
 *
 *  Подпись у оконных полей называет окно ("(panel)" / "(main window)") — то,
 *  чем занята комбинация, читается из сообщения об ошибке само по себе,
 *  без похода в этот файл за расшифровкой.
 *
 *  Escape сюда не входит: он не хранится ни в одном поле (Back/Cancel, см.
 *  ESCAPE_SHORTCUT в action-shortcuts.ts) и назначить его на что-то ещё
 *  нельзя — ShortcutCapture трактует Escape как отмену записи комбинации. */
export const SHORTCUT_FIELDS = [
  { key: 'hotkey', label: 'Record hotkey', scope: 'global' },
  { key: 'captureHotkey', label: 'Capture selection', scope: 'global' },
  { key: 'pasteShortcut', label: 'Paste (panel)', scope: 'panel' },
  { key: 'copyShortcut', label: 'Copy (panel)', scope: 'panel' },
  { key: 'followShortcut', label: 'Follow (panel)', scope: 'panel' },
  { key: 'mainPasteShortcut', label: 'Paste (main window)', scope: 'main' },
  { key: 'mainCopyShortcut', label: 'Copy (main window)', scope: 'main' },
  { key: 'acceptShortcut', label: 'Accept (main window)', scope: 'main' },
  { key: 'translateShortcut', label: 'Translate (main window)', scope: 'main' },
  { key: 'askAiShortcut', label: 'Ask AI (main window)', scope: 'main' },
  { key: 'generateShortcut', label: 'Generate (main window)', scope: 'main' },
  { key: 'fixShortcut', label: 'Fix (main window)', scope: 'main' },
  { key: 'shortenShortcut', label: 'Shorten (main window)', scope: 'main' },
  { key: 'summarizeShortcut', label: 'Summarize (main window)', scope: 'main' },
] as const satisfies readonly { key: string; label: string; scope: ShortcutScope }[]

export type ShortcutField = (typeof SHORTCUT_FIELDS)[number]['key']

const SCOPE_BY_FIELD: Record<ShortcutField, ShortcutScope> = Object.fromEntries(
  SHORTCUT_FIELDS.map((f) => [f.key, f.scope])
) as Record<ShortcutField, ShortcutScope>

/** Могут ли две области столкнуться на одной комбинации.
 *
 *  'global' перехватывает клавишу системно, раньше любого окна — оконный
 *  обработчик в любой области попросту не получает событие, поэтому global
 *  конфликтует со всем. Две оконные области конфликтуют, только если это
 *  ОДНА И ТА ЖЕ область: разные окна в фокус попадают по одному, и нажатие
 *  всегда достаётся ровно одному обработчику. */
function scopesCanCollide(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === 'global' || b === 'global') return true
  return a === b
}

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
  const fieldScope = SCOPE_BY_FIELD[field]
  for (const { key, label, scope } of SHORTCUT_FIELDS) {
    if (key === field) continue
    if (settings[key] !== accel) continue
    if (scopesCanCollide(fieldScope, scope)) return label
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
