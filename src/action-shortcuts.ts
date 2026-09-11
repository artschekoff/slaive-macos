// Хоткеи действий главного окна — чистый слой без DOM и React, по тому же
// принципу, что shortcut.ts/menu-state.ts: MainWindow.tsx только вешает
// keydown и вызывает функции отсюда, а решение «какое нажатие какую кнопку
// запускает» тестируется отдельно (action-shortcuts.test.ts).
//
// Это ОКОННЫЕ хоткеи, не глобальные: как Paste/Copy в оверлее, они ловятся
// обычным window keydown и работают только пока окно в фокусе. Через
// tauri-plugin-global-shortcut они не проходят намеренно — глобальная
// регистрация может не удаться, конфликтует с другими приложениями и
// срабатывала бы, когда окна вообще не видно.
import { matchesShortcut, type KeyEventLike } from './shortcut.ts'
import type { ActionShortcutKey, MenuNode } from './action-tree.ts'

/** Ровно те поля настроек, которые нужны разбору нажатия. Отдельный тип, а
 *  не весь Settings: функции ниже не должны уметь читать что-то ещё. */
export type ActionShortcuts = Record<ActionShortcutKey, string>

// Дефолты дублируют Settings::default() на бэкенде (src-tauri/src/settings.rs)
// — та же роль, что у DEFAULT_PASTE_SHORTCUT в shortcut.ts: заглушка до
// первого ответа get_settings, дальше её перекрывают реальные значения.
//
// Почему все пять с Cmd. Поле текста в главном окне — CodeMirror с Vim.
// В normal-режиме любая голая буква это команда, в insert-режиме голая буква
// это ввод, а Ctrl-комбинации разобраны и там и там (Ctrl-r, Ctrl-o, Ctrl-w,
// Ctrl-v…). Модификатора Cmd в грамматике Vim нет вовсе — поэтому Cmd+буква
// не отбирает у редактирования ничего ни в одном режиме, и обработчик может
// не спрашивать, в фокусе ли редактор. Тот же довод уже записан в Overlay.tsx
// про Cmd+C. Переназначение пользователем требует модификатора (см.
// ShortcutCapture в Settings.tsx) ровно по этой причине.
//
// Буквы — мнемоника действия. Translate получил L («language»), а не T:
// Cmd+T занят глобальным хоткеем записи, и глобальная регистрация съела бы
// его раньше, чем нажатие дошло бы до окна.
// Summarize взял Cmd+U — вторую букву слова: S занят Shorten, а Cmd+M
// (следующая мнемоника) это системный Minimize, который меню приложения
// перехватывает раньше, чем нажатие дойдёт до окна.
export const DEFAULT_ACTION_SHORTCUTS: ActionShortcuts = {
  translateShortcut: 'Super+KeyL',
  askAiShortcut: 'Super+KeyK',
  fixShortcut: 'Super+KeyF',
  shortenShortcut: 'Super+KeyS',
  summarizeShortcut: 'Super+KeyU',
}

/** Сколько пунктов подменю получают позиционный хоткей. Больше девяти в
 *  одном уровне не бывает у клавиатурного ряда цифр; десятому кнопка
 *  остаётся без бейджа, а не получает нечитаемую комбинацию. */
const MAX_POSITIONAL = 9

/**
 * Акселератор кнопки узла на ТЕКУЩЕМ уровне меню.
 *
 * Корневой уровень — настраиваемый хоткей действия из настроек.
 * Подуровень (языки под Translate) — позиционный Cmd+1…Cmd+9, не настройка:
 * пункты подменю приходят из данных дерева и могут меняться составом, а
 * хранимая настройка на каждый язык означала бы миграцию файла настроек и
 * новую строку в окне настроек на каждый добавленный язык. Позиция ничего не
 * хранит и остаётся верной при любой правке дерева. Cmd взят и здесь по той
 * же причине, что у корневых: голая цифра — это ввод в insert-режиме Vim.
 *
 * `null` — у кнопки хоткея нет (узел без `shortcutKey`, либо десятый и
 * дальше пункт подменю).
 */
export function shortcutFor(
  node: MenuNode,
  index: number,
  atRoot: boolean,
  shortcuts: ActionShortcuts
): string | null {
  if (atRoot) return node.shortcutKey ? shortcuts[node.shortcutKey] : null
  return index < MAX_POSITIONAL ? `Super+Digit${index + 1}` : null
}

/**
 * Какой узел текущего уровня запускает это нажатие. `null` — ни один.
 *
 * Берёт ровно тот уровень, который сейчас нарисован кнопками, поэтому хоткей
 * недоступной кнопки не сработает по построению, а не по отдельной проверке:
 * кнопки нет на экране — узла нет и в `level`. Остальные условия
 * недоступности (пустой текст, запрос в полёте, открытая панель
 * Accept/Cancel, форма Ask AI) — состояние окна, их проверяет MainWindow.tsx
 * перед вызовом.
 */
export function nodeForKey(
  e: KeyEventLike,
  level: readonly MenuNode[],
  atRoot: boolean,
  shortcuts: ActionShortcuts
): MenuNode | null {
  for (let i = 0; i < level.length; i++) {
    const accel = shortcutFor(level[i], i, atRoot, shortcuts)
    if (accel && matchesShortcut(e, accel)) return level[i]
  }
  return null
}
