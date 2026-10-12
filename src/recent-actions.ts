// Недавно выполненные действия — чистый слой: разрешение запомненного пути в
// живом дереве меню, подпись пункта и состав столбца. Без DOM и без Tauri, по
// тому же принципу, что menu-state.ts и action-shortcuts.ts: MainWindow.tsx
// только вызывает, а «что именно запомнено и как это назвать» проверяется
// юнит-тестом (recent-actions.test.ts).
//
// Приватность: запрос Ask AI — текст пользователя. Ни одна функция ниже
// ничего не пишет в консоль, то же правило, что у history.ts и на стороне
// Rust.
import type { LeafNode, MenuNode, PromptNode } from './action-tree.ts'
import { previewText } from './history.ts'

/**
 * Одно запомненное действие: ПУТЬ по дереву плюс ПАРАМЕТР.
 *
 * Действие — не лист. Узлов три вида (см. action-tree.ts): `leaf` срабатывает
 * сразу и его одного достаточно (`['fix']`); `branch` → `leaf` это Translate и
 * язык, нужны оба звена (`['translate', 'translate-russian']`); `prompt` это
 * Ask AI со свободным запросом, и без текста запроса половина пользы исчезает
 * — перенабирать запрос дороже, чем дойти до кнопки.
 *
 * Хранится на диске ровно в этом виде (см. src-tauri/src/recent_actions.rs).
 * Подписи там нет намеренно: состав дерева — настройка (список языков
 * Translate), и хранимая подпись называла бы язык, которого в дереве больше
 * нет. Подпись собирается здесь, по живому дереву.
 */
export type RecentAction = { path: string[]; query: string }

/** Сколько символов запроса влезает в подпись пункта. Пункт — для УЗНАВАНИЯ
 *  запроса, а не для его чтения: подпись стоит в одной строке кнопки столбца
 *  и дальше обрезается многоточием самим CSS, а это значило бы обрыв посреди
 *  слова без всякого знака, что текст продолжается. Сорок — примерно столько,
 *  сколько видно рядом с названием действия и бейджем хоткея на 720px. */
export const QUERY_PREVIEW_LIMIT = 40

/** Запомненное действие, разрешённое в ЖИВОМ дереве: что выполнять и как это
 *  назвать. `null` вместо такой записи означает, что путь в дереве больше не
 *  находится (из настроек убрали язык) — пункт просто не показывается. */
export type ResolvedRecentAction = {
  action: RecentAction
  /** Узел, который и выполняется — тот же самый, что нажали бы, пройдя меню
   *  руками. Второго пути исполнения у быстрого действия нет. */
  target: LeafNode | PromptNode
  /** Подпись, называющая действие ЦЕЛИКОМ: «Translate → Russian», а не
   *  «Translate». Пункт, по которому нельзя понять, что он сделает,
   *  бесполезен. */
  label: string
}

/**
 * Подпись: путь через « → », а для `prompt`-узла — ещё и начало запроса.
 *
 * Запрос обрезается тем же `previewText`, что подписи плиток истории: там та
 * же задача (схлопнуть переносы, обрезать по границе слова, поставить
 * многоточие только когда дальше действительно есть текст) и уже проверенное
 * решение. Пустой запрос (Generate без сида) не даёт ни двоеточия, ни
 * пустого хвоста — обещать нечего.
 */
function labelFor(pathLabels: string[], target: MenuNode, query: string): string {
  const head = pathLabels.join(' → ')
  if (target.kind !== 'prompt') return head
  const preview = previewText(query, QUERY_PREVIEW_LIMIT)
  return preview ? `${head}: ${preview}` : head
}

/**
 * Разрешает запомненный путь в живом дереве.
 *
 * `null`, если путь не находится целиком или кончается веткой: Translate без
 * языка выполнить нечем, а пункт, который ничего не делает, хуже отсутствия
 * пункта. Это же и весь механизм устаревания: убрали язык из настроек —
 * запись о нём перестала показываться, вычищать файл отдельно не нужно.
 *
 * ponytail: нерабочая запись остаётся лежать в файле и занимает одно из трёх
 * мест до следующего выполненного действия — усложнять (чистить файл при
 * разборе), если потолок списка когда-нибудь вырастет настолько, что одно
 * потерянное место станет заметно.
 */
export function resolveRecentAction(
  tree: MenuNode[],
  action: RecentAction
): ResolvedRecentAction | null {
  let items = tree
  const labels: string[] = []
  let node: MenuNode | null = null
  for (const id of action.path) {
    const found = items.find((n) => n.id === id)
    if (!found) return null
    labels.push(found.label)
    node = found
    // Дальше идти можно только внутрь ветки; у leaf/prompt детей нет, и
    // лишнее звено пути (дерево поменялось) не найдётся в пустом уровне.
    items = found.kind === 'branch' ? found.children : []
  }
  if (node === null || node.kind === 'branch') return null
  return { action, target: node, label: labelFor(labels, node, action.query) }
}

/** Разрешает список, выбрасывая записи, которых в дереве больше нет. Порядок
 *  сохраняется: он и есть «от самого недавнего к старым». */
export function resolveRecentActions(
  tree: MenuNode[],
  actions: readonly RecentAction[]
): ResolvedRecentAction[] {
  const out: ResolvedRecentAction[] = []
  for (const action of actions) {
    const resolved = resolveRecentAction(tree, action)
    if (resolved) out.push(resolved)
  }
  return out
}

/**
 * Пункт столбца меню: быстрое действие или узел дерева.
 *
 * Быстрые действия живут в ТОЙ ЖЕ колонке, что остальные пункты, а не
 * отдельным виджетом рядом — значит и стрелочная навигация обязана их
 * проходить. Поэтому столбец — ОДИН массив: индекс подсветки считается по
 * нему, и «стрелки проходят быстрые действия» получается по построению, а не
 * вторым механизмом выбора, который пришлось бы согласовывать с первым.
 */
export type ColumnItem =
  | { kind: 'recent'; key: string; recent: ResolvedRecentAction }
  | {
      kind: 'node'
      key: string
      node: MenuNode
      /** Индекс в `level`, а НЕ в столбце: из него считаются позиционные
       *  ⌘1…⌘9 пунктов подменю (см. shortcutFor). Быстрые действия стоят
       *  только в корне, где позиционных хоткеев у узлов нет, но связь
       *  «номер кнопки = её место в уровне» не должна зависеть от того,
       *  сколько строк приехало выше. */
      index: number
    }

/**
 * Состав столбца: сначала недавние действия, потом пункты текущего уровня.
 *
 * Недавние — только в корне: в подменю они были бы вторым смыслом у того же
 * места на экране. Пустой список не даёт ни заголовка, ни разделителя —
 * пустой раздел хуже отсутствия раздела (отделение рисуется классом на первой
 * кнопке уровня, см. MainWindow.tsx).
 */
export function buildColumnItems(
  level: readonly MenuNode[],
  recent: readonly ResolvedRecentAction[],
  atRoot: boolean
): ColumnItem[] {
  const nodes: ColumnItem[] = level.map((node, index) => ({
    kind: 'node',
    key: `node-${node.id}`,
    node,
    index,
  }))
  if (!atRoot) return nodes
  // Ключ быстрого пункта — его ПОЗИЦИЯ: список целиком перерисовывается при
  // любом изменении (он и есть порядок по недавности), а своего состояния у
  // кнопки нет, поэтому позиция — достаточное тождество строки для React и
  // для aria-activedescendant. Запрос в ключ не идёт намеренно: он уехал бы в
  // атрибут id в разметке.
  const quick: ColumnItem[] = recent.map((r, i) => ({
    kind: 'recent',
    key: `recent-${i}`,
    recent: r,
  }))
  return [...quick, ...nodes]
}

/** Путь действия: ветки, через которые провалились, плюс сам узел. Собран
 *  одной функцией, чтобы все три точки запуска (клик, Enter в столбце,
 *  хоткей) запоминали ОДИН и тот же путь. */
export function actionPath(branchIds: readonly string[], nodeId: string): string[] {
  return [...branchIds, nodeId]
}

/** Запомненное действие из узла и запроса. `query` только у prompt-узлов: у
 *  leaf его не бывает, и пустая строка здесь — не «забыли запрос», а «запроса
 *  у этого действия нет». */
export function toRecentAction(
  branchIds: readonly string[],
  target: LeafNode | PromptNode,
  query: string
): RecentAction {
  return {
    path: actionPath(branchIds, target.id),
    query: target.kind === 'prompt' ? query : '',
  }
}
