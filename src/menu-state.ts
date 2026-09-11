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

export function rootMenuState(): MenuState {
  return { stack: [ACTION_TREE], prompt: null }
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
