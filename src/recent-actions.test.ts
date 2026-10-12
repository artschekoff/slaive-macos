// Быстрый вызов недавних действий: разрешение запомненного пути в живом
// дереве, подпись для каждого из трёх видов узлов и состав столбца. Порядок,
// вытеснение и дедупликация живут на стороне Rust (см.
// src-tauri/src/recent_actions.rs и его тесты) — здесь ровно то, что считает
// фронтенд. Сеть, DOM и Tauri не участвуют.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTION_TREE, buildActionTree } from './action-tree.ts'
import {
  QUERY_PREVIEW_LIMIT,
  actionPath,
  buildColumnItems,
  resolveRecentAction,
  resolveRecentActions,
  toRecentAction,
  type RecentAction,
} from './recent-actions.ts'
import { branchPathIds, enterNode, rootMenuState } from './menu-state.ts'
import type { BranchNode, LeafNode, PromptNode } from './action-tree.ts'

const leafAction = (id: string): RecentAction => ({ path: [id], query: '' })

test('подпись листа — название самого действия', () => {
  const resolved = resolveRecentAction(ACTION_TREE, leafAction('fix'))
  assert.ok(resolved)
  assert.equal(resolved.label, 'Fix')
  assert.equal(resolved.target.id, 'fix')
})

test('подпись ветки с листом называет действие ЦЕЛИКОМ, а не только Translate', () => {
  // Ровно то, ради чего запоминается весь путь: по пункту «Translate» нельзя
  // понять, на какой язык он переведёт.
  const resolved = resolveRecentAction(ACTION_TREE, {
    path: ['translate', 'translate-russian'],
    query: '',
  })
  assert.ok(resolved)
  assert.equal(resolved.label, 'Translate → Russian')
  assert.equal(resolved.target.kind, 'leaf')
})

test('подпись prompt-узла несёт сам запрос — иначе теряется половина пользы', () => {
  const resolved = resolveRecentAction(ACTION_TREE, {
    path: ['ask-ai'],
    query: 'make this more formal',
  })
  assert.ok(resolved)
  assert.equal(resolved.label, 'Ask AI: make this more formal')
  // И запрос едет вместе с действием, а не только в подписи: именно его
  // перенабирать и дорого.
  assert.equal(resolved.action.query, 'make this more formal')
})

test('длинный запрос в подписи обрезается по слову и с многоточием', () => {
  const query =
    'rewrite this paragraph so that it sounds like a formal letter from a lawyer'
  const resolved = resolveRecentAction(ACTION_TREE, { path: ['ask-ai'], query })
  assert.ok(resolved)
  assert.ok(resolved.label.endsWith('…'), `подпись не обрезана: ${resolved.label}`)
  assert.ok(resolved.label.length < `Ask AI: ${query}`.length)
  // Обрезка по границе слова: обрывка слова перед многоточием нет.
  const shown = resolved.label.slice('Ask AI: '.length, -1)
  assert.ok(query.startsWith(shown), 'показанное начало не совпадает с запросом')
  assert.ok(shown.length <= QUERY_PREVIEW_LIMIT)
  assert.ok(query[shown.length] === ' ', 'обрезано посреди слова')
})

test('перенос строки в запросе не ломает подпись на две строки', () => {
  const resolved = resolveRecentAction(ACTION_TREE, {
    path: ['ask-ai'],
    query: 'make it\nformal',
  })
  assert.ok(resolved)
  assert.equal(resolved.label, 'Ask AI: make it formal')
})

test('prompt-узел без запроса — просто название действия, без пустого хвоста', () => {
  // Generate запускается и вовсе без сида (worksOnEmpty), и обещать в подписи
  // запрос, которого нет, незачем.
  const resolved = resolveRecentAction(ACTION_TREE, { path: ['generate'], query: '' })
  assert.ok(resolved)
  assert.equal(resolved.label, 'Generate')
})

test('запись, которой в дереве больше нет, не показывается', () => {
  // Язык убрали из настроек — подменю Translate другое. Хранимая подпись
  // осталась бы врать; хранимый путь просто не разрешается.
  const tree = buildActionTree('English, Spanish')
  assert.equal(
    resolveRecentAction(tree, { path: ['translate', 'translate-russian'], query: '' }),
    null
  )
  // А язык, который в списке есть, разрешается как обычно.
  const kept = resolveRecentAction(tree, { path: ['translate', 'translate-english'], query: '' })
  assert.ok(kept)
  assert.equal(kept.label, 'Translate → English')
})

test('путь, кончающийся веткой, не пункт: выполнять нечего', () => {
  assert.equal(resolveRecentAction(ACTION_TREE, { path: ['translate'], query: '' }), null)
  assert.equal(resolveRecentAction(ACTION_TREE, { path: [], query: '' }), null)
  // Лишнее звено после листа тоже не находится.
  assert.equal(resolveRecentAction(ACTION_TREE, { path: ['fix', 'fix'], query: '' }), null)
})

test('список разрешается с сохранением порядка, нерабочие записи выпадают', () => {
  const tree = buildActionTree('English')
  const resolved = resolveRecentActions(tree, [
    { path: ['translate', 'translate-russian'], query: '' },
    leafAction('shorten'),
    leafAction('fix'),
  ])
  assert.deepEqual(
    resolved.map((r) => r.label),
    ['Shorten', 'Fix']
  )
})

test('столбец: быстрые действия стоят выше пунктов уровня и только в корне', () => {
  const recent = resolveRecentActions(ACTION_TREE, [leafAction('fix')])
  const items = buildColumnItems(ACTION_TREE, recent, true)
  assert.equal(items.length, ACTION_TREE.length + 1)
  assert.equal(items[0].kind, 'recent')
  assert.equal(items[1].kind, 'node')

  // В подменю их нет: там те же строки значили бы второе на том же месте.
  const languages = (ACTION_TREE.find((n) => n.id === 'translate') as BranchNode).children
  const inSubmenu = buildColumnItems(languages, recent, false)
  assert.equal(inSubmenu.length, languages.length)
  assert.ok(inSubmenu.every((i) => i.kind === 'node'))
})

test('пустой список быстрых действий не добавляет в столбец ничего', () => {
  const items = buildColumnItems(ACTION_TREE, [], true)
  assert.equal(items.length, ACTION_TREE.length)
  assert.ok(items.every((i) => i.kind === 'node'))
})

test('номер пункта уровня считается по уровню, а не по месту в столбце', () => {
  // На этом держится нумерация ⌘1…⌘9 в подменю: сколько бы строк ни приехало
  // сверху, «первый язык» остаётся первым.
  const recent = resolveRecentActions(ACTION_TREE, [leafAction('fix'), leafAction('shorten')])
  const items = buildColumnItems(ACTION_TREE, recent, true)
  const nodes = items.filter((i) => i.kind === 'node')
  assert.deepEqual(
    nodes.map((i) => (i.kind === 'node' ? i.index : -1)),
    ACTION_TREE.map((_, i) => i)
  )
})

test('ключи пунктов столбца уникальны и не несут текста запроса', () => {
  const recent = resolveRecentActions(ACTION_TREE, [
    { path: ['ask-ai'], query: 'личный запрос' },
    leafAction('fix'),
  ])
  const items = buildColumnItems(ACTION_TREE, recent, true)
  const keys = items.map((i) => i.key)
  assert.equal(new Set(keys).size, keys.length, 'ключи повторяются')
  // Ключ уезжает в атрибут id разметки — личному тексту там не место.
  assert.ok(keys.every((k) => !k.includes('личный')))
})

test('путь действия собирается из пройденных веток и самого узла', () => {
  // Та же пара, что запоминается при запуске: где стоял + что нажал.
  const state = rootMenuState()
  const translate = ACTION_TREE.find((n) => n.id === 'translate') as BranchNode
  const inside = enterNode(state, translate)
  const russian = inside.stack[1].find((n) => n.id === 'translate-russian') as LeafNode
  assert.deepEqual(actionPath(branchPathIds(inside), russian.id), [
    'translate',
    'translate-russian',
  ])
  // И обратно: по такому пути действие разрешается в тот же самый узел.
  const resolved = resolveRecentAction(ACTION_TREE, {
    path: actionPath(branchPathIds(inside), russian.id),
    query: '',
  })
  assert.ok(resolved)
  assert.equal(resolved.target.id, 'translate-russian')
})

test('у листа запрос не запоминается, у prompt-узла запоминается', () => {
  const fix = ACTION_TREE.find((n) => n.id === 'fix') as LeafNode
  const askAi = ACTION_TREE.find((n) => n.id === 'ask-ai') as PromptNode
  // Запрос приходит в runNode одним и тем же аргументом, и «пустая строка у
  // листа» — это свойство листа, а не случайность вызова.
  assert.deepEqual(toRecentAction([], fix, 'мусор'), { path: ['fix'], query: '' })
  assert.deepEqual(toRecentAction([], askAi, 'make it short'), {
    path: ['ask-ai'],
    query: 'make it short',
  })
})
