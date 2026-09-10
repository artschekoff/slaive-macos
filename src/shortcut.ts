// Единый машинный формат акселератора — "Ctrl+Alt+Shift+Super+Code", тот же,
// что понимает tauri-plugin-global-shortcut для глобального хоткея записи.
// Хоткеи Paste/Copy НЕ регистрируются через global-shortcut — это обычные
// window-level keydown в Overlay.tsx, — но хранятся и разбираются в том же
// формате: это позволяет один и тот же компонент "нажми комбинацию"
// (ShortcutCapture) переиспользовать для всех трёх полей настроек, а не
// писать второй.
//
// Все функции здесь чистые (без DOM/React) — по требованию плана именно они
// покрыты юнит-тестами (см. shortcut.test.ts), а не обработчики клавиш в
// Overlay/Settings, которые уже UI и тестируются вручную.

// Модификатор сам по себе (без обычной клавиши) не образует комбинацию —
// код клавиши для самих клавиш-модификаторов, чтобы отличить "зажат Cmd" от
// "нажата обычная клавиша с зажатым Cmd".
const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight',
])

// Минимальная структурная форма KeyboardEvent, которая нужна разбору —
// удобно передавать сюда как настоящее событие браузера, так и тестовый
// объект-заглушку без импорта DOM-типов.
export type KeyEventLike = {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * Разбирает событие клавиатуры в акселератор вида "Ctrl+Super+KeyC".
 * `null`, если нажат один модификатор без обычной клавиши — ждём, пока к
 * нему добавится настоящая клавиша.
 */
export function parseKeyEvent(e: KeyEventLike): string | null {
  if (MODIFIER_CODES.has(e.code)) return null
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Super')
  parts.push(e.code)
  return parts.join('+')
}

/** Есть ли у акселератора хотя бы один модификатор. */
export function hasModifier(accel: string): boolean {
  return accel.includes('+')
}

/**
 * Совпадает ли нажатие с сохранённым акселератором — используется в Overlay
 * вместо буквальной проверки `e.key === 'Enter'`, чтобы Paste/Copy можно
 * было переназначить.
 */
export function matchesShortcut(e: KeyEventLike, shortcut: string): boolean {
  return parseKeyEvent(e) === shortcut
}

// Порядок модификаторов в бейдже — как принято в macOS: Control, Option,
// Shift, Command.
const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'] as const
const MODIFIER_SYMBOLS: Record<(typeof MODIFIER_ORDER)[number], string> = {
  Ctrl: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Super: '⌘',
}

const KEY_SYMBOLS: Record<string, string> = {
  Enter: '⏎',
  Escape: '⎋',
}

function keyLabel(code: string): string {
  if (code in KEY_SYMBOLS) return KEY_SYMBOLS[code]
  if (code.startsWith('Key')) return code.slice(3) // "KeyC" -> "C"
  if (code.startsWith('Digit')) return code.slice(5) // "Digit1" -> "1"
  return code
}

/** Компактная запись для бейджа на кнопке: "Super+KeyC" -> "⌘C". */
export function formatShortcutBadge(accel: string): string {
  const parts = accel.split('+')
  const code = parts[parts.length - 1]
  const mods = new Set(parts.slice(0, -1))
  const modSymbols = MODIFIER_ORDER.filter((m) => mods.has(m)).map((m) => MODIFIER_SYMBOLS[m])
  return [...modSymbols, keyLabel(code)].join('')
}

// Дефолты — дублируют Settings::default() на бэкенде (src-tauri/src/settings.rs).
// Используются во фронтенде только как заглушка ДО первого ответа
// get_settings, пока overlay ещё не знает реальных значений; после первого
// ответа (и на каждое settings:changed) реальные значения из настроек их
// перекрывают.
export const DEFAULT_PASTE_SHORTCUT = 'Enter'
export const DEFAULT_COPY_SHORTCUT = 'Super+KeyC'

/** Человекочитаемая форма для текста кнопки захвата в настройках:
 * "Super+KeyC" -> "Cmd + C". Машинный формат хранится как есть. */
export function displayShortcut(accel: string): string {
  return accel
    .split('+')
    .map((part) => (part === 'Super' ? 'Cmd' : part))
    .join(' + ')
}
