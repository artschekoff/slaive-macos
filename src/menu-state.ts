// Чистый обход дерева меню главного окна (см. action-tree.ts) — без DOM и
// без Tauri, тот же принцип, что у shortcut.ts/ai.ts: MainWindow.tsx вызывает
// эти функции, но сама в тестах не участвует.
import { ACTION_TREE, type MenuNode, type PromptNode } from './action-tree.ts'

/** Состояние обхода дерева меню.
 *  `stack` — уровни от корня (stack[0] === ACTION_TREE) до текущего.
 *  `prompt` — активный узел свободного запроса (Ask AI), если сейчас
 *  показана его форма ввода вместо списка кнопок текущего уровня. */
export type MenuState = {
  stack: MenuNode[][]
  prompt: PromptNode | null
}

/** Корень обхода. Дерево передаётся аргументом, потому что подменю Translate
 *  строится из настройки и у живого окна дерево своё (см. buildActionTree);
 *  дефолт — дерево с языками по умолчанию, им пользуются тесты и состояние до
 *  первого ответа get_settings. */
export function rootMenuState(tree: MenuNode[] = ACTION_TREE): MenuState {
  return { stack: [tree], prompt: null }
}

/** В корне ли меню — ни на одном подуровне, ни в форме запроса. */
export function isRoot(state: MenuState): boolean {
  return state.stack.length <= 1 && state.prompt === null
}

export function currentLevel(state: MenuState): MenuNode[] {
  return state.stack[state.stack.length - 1]
}

/** Глубина текущего уровня — 1 в корне, +1 за каждый провал в branch, ещё +1
 *  если сейчас открыта форма запроса. Используется только для того, чтобы
 *  решить направление анимации перехода (см. MainWindow.tsx) — сравнение
 *  "стало глубже" / "стало мельче" не завязано на konkretные узлы. */
export function menuDepth(state: MenuState): number {
  return state.stack.length + (state.prompt ? 1 : 0)
}

/**
 * Подпись того, ВНУТРИ ЧЕГО пользователь сейчас находится — «Translate» на
 * уровне языков, «Ask AI» в форме свободного запроса. `null` в корне: там
 * нет объемлющего действия, и полоса возврата не показывается вовсе.
 *
 * Ищем владельца текущего уровня в РОДИТЕЛЬСКОМ уровне, а не обходом всего
 * дерева: `enterNode` кладёт в стек `node.children` тем же массивом, что
 * лежит на узле, поэтому владелец находится сравнением ссылок — точно и без
 * предположения об уникальности подписей. Хранить сам узел в `MenuState`
 * было бы вторым источником правды о том, где мы находимся; стек уже это
 * знает.
 */
export function currentLevelLabel(state: MenuState): string | null {
  if (state.prompt !== null) return state.prompt.label
  if (state.stack.length <= 1) return null
  const owner = ownerOf(state.stack[state.stack.length - 2], currentLevel(state))
  return owner ? owner.label : null
}

/** Ветка родительского уровня, чьи дети и есть `items`. Сравнение по ССЫЛКЕ:
 *  `enterNode` кладёт в стек `node.children` тем же массивом, что лежит на
 *  узле, поэтому владелец находится точно и без предположений об
 *  уникальности подписей или идентификаторов. */
function ownerOf(parent: MenuNode[], items: MenuNode[]): MenuNode | undefined {
  return parent.find((n) => n.kind === 'branch' && n.children === items)
}

/**
 * Идентификаторы ВЕТОК, через которые пользователь провалился от корня до
 * текущего уровня: `[]` в корне, `['translate']` на уровне языков.
 *
 * Сам узел, который сейчас выбирают (и форма запроса, если она открыта), сюда
 * НЕ входит — вызывающая сторона дописывает его id сама. Из этой пары и
 * получается путь действия, который запоминает список недавних: действие это
 * путь плюс параметр, а не один лист (см. recent-actions.ts).
 */
export function branchPathIds(state: MenuState): string[] {
  const out: string[] = []
  for (let i = 1; i < state.stack.length; i++) {
    const owner = ownerOf(state.stack[i - 1], state.stack[i])
    if (owner) out.push(owner.id)
  }
  return out
}

/** Вход в узел: branch — проваливается на уровень его детей; prompt —
 *  показывает форму свободного запроса; leaf ничего не меняет в самом дереве
 *  — вызывающая сторона (MainWindow) запускает действие напрямую, не через
 *  эту функцию (у leaf нет "уровня", в который проваливаться). */
export function enterNode(state: MenuState, node: MenuNode): MenuState {
  if (node.kind === 'branch') return { stack: [...state.stack, node.children], prompt: null }
  if (node.kind === 'prompt') return { ...state, prompt: node }
  return state
}

/** Возврат на уровень выше. Из формы запроса — назад к списку, откуда в неё
 *  вошли (сам стек не трогаем — уровень, на котором висела кнопка Ask AI,
 *  никуда не делся). Из корня — no-op: там некуда возвращаться, а не ошибка
 *  (см. бриф: "возврат из корня" — часть цикла обхода, а не крайний случай,
 *  который можно уронить). */
export function goBack(state: MenuState): MenuState {
  if (state.prompt !== null) return { ...state, prompt: null }
  if (state.stack.length <= 1) return state
  return { stack: state.stack.slice(0, -1), prompt: null }
}

// ===== Выбор стрелками в столбце меню =====
// Индекс выбранного пункта не часть MenuState (он не про то, ГДЕ в дереве
// стоит пользователь, а про то, какая КНОПКА текущего уровня подсвечена под
// стрелками) — живёт как React-состояние в MainWindow.tsx, а его переходы
// вынесены сюда чистыми функциями по тому же принципу, что и весь этот файл:
// без DOM их можно проверить юнит-тестом, а MainWindow.tsx только вызывает.

/** Пункт вниз, с циклом с последнего на первый — то же поведение, что у
 *  системных выпадающих меню macOS: в списке из одного-двух действий
 *  стрелка без цикла упиралась бы в тупик через одно нажатие. `length <= 0`
 *  — вырожденный случай (пустого уровня в этом дереве не бывает, но упасть
 *  функция не должна), возвращает 0. */
export function moveSelectionDown(index: number, length: number): number {
  if (length <= 0) return 0
  return index >= length - 1 ? 0 : index + 1
}

/** Пункт вверх, с тем же циклом в обратную сторону: с первого — на
 *  последний. */
export function moveSelectionUp(index: number, length: number): number {
  if (length <= 0) return 0
  return index <= 0 ? length - 1 : index - 1
}

/** Выбор при входе на новый уровень (провал в branch, возврат назад, смена
 *  дерева) — всегда первый пункт: у свежего уровня нет "с какого пункта я
 *  сюда пришёл", и вставать на начало списка — единственный вариант без
 *  угадывания. */
export function resetSelectionForLevel(): number {
  return 0
}

/** Держит индекс в границах ТЕКУЩЕГО списка. Нужна на случай, когда состав
 *  уровня изменился, а индекс остался от прежнего, более длинного списка —
 *  список языков Translate правится в настройках (см. action-tree.ts) и
 *  может стать короче тем же самым уровнем меню. */
export function clampSelectionIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(index, 0), length - 1)
}
