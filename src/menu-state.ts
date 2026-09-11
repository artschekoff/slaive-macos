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
  const items = currentLevel(state)
  const parent = state.stack[state.stack.length - 2]
  const owner = parent.find((n) => n.kind === 'branch' && n.children === items)
  return owner ? owner.label : null
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
