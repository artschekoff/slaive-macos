// Дерево действий — данные, и проверять здесь надо именно данные: состав
// корня, разбор списка языков и то, что промпты Shorten и Summarize не
// сползлись в одну работу. Сеть, DOM и Tauri не участвуют: buildRequest —
// чистая функция, её результат никуда не уходит.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ACTION_TREE,
  DEFAULT_TRANSLATE_LANGUAGES,
  buildActionTree,
  parseLanguageList,
  type BranchNode,
  type LeafNode,
  type MenuNode,
  type PromptNode,
} from './action-tree.ts'

const translateOf = (tree: MenuNode[]) => tree.find((n) => n.id === 'translate') as BranchNode
const leafOf = (tree: MenuNode[], id: string) => tree.find((n) => n.id === id) as LeafNode

test('корень — шесть действий, настраиваемые хоткеи не делятся на двоих', () => {
  assert.deepEqual(
    ACTION_TREE.map((n) => n.label),
    ['Translate', 'Ask AI', 'Generate', 'Fix', 'Shorten', 'Summarize']
  )
  const keys = ACTION_TREE.map((n) => n.shortcutKey).filter(Boolean)
  assert.equal(new Set(keys).size, keys.length, 'два действия делят одну настройку хоткея')
})

test('Generate шлёт текст поля как инструкцию, а не как объект правки', () => {
  const generate = ACTION_TREE.find((n) => n.id === 'generate') as PromptNode
  const { system, user } = generate.buildRequest('напиши Дэну, что я опаздываю', '')
  assert.match(system, /request/, 'системный промпт должен трактовать текст как запрос')
  assert.equal(user, 'напиши Дэну, что я опаздываю')
})

test('Generate доступен на пустом тексте, сид опционален с обеих сторон', () => {
  const generate = ACTION_TREE.find((n) => n.id === 'generate') as PromptNode
  assert.equal(generate.worksOnEmpty, true)
  // Только сид — генерация с нуля по подсказке.
  assert.equal(generate.buildRequest('', 'тема: отпуск').user, 'тема: отпуск')
  // Сид + текст — сид первым, разделены пустой строкой.
  assert.equal(generate.buildRequest('текст', 'сид').user, 'сид\n\nтекст')
  // Совсем пусто — пустой запрос, empty-случай закрывает системный промпт.
  const empty = generate.buildRequest('', '')
  assert.equal(empty.user, '')
  assert.match(empty.system, /If the request is empty/)
})

test('по умолчанию переводим на три языка из брифа', () => {
  assert.deepEqual(
    translateOf(ACTION_TREE).children.map((n) => n.label),
    ['English', 'Spanish', 'Russian']
  )
})

test('подменю строится из настройки, порядок — как написано', () => {
  const tree = buildActionTree('German\nJapanese, Português')
  assert.deepEqual(
    translateOf(tree).children.map((n) => n.label),
    ['German', 'Japanese', 'Português']
  )
})

test('название языка попадает в промпт как есть — код языка не требуется', () => {
  const tree = buildActionTree('Brazilian Portuguese')
  const node = translateOf(tree).children[0] as LeafNode
  const { system, user } = node.buildRequest('текст')
  assert.match(system, /translate the given text to Brazilian Portuguese/)
  assert.equal(user, 'текст')
})

test('запятые, переводы строк и лишние пробелы разбираются одинаково', () => {
  assert.deepEqual(parseLanguageList(' English , Spanish \n Russian '), [
    'English',
    'Spanish',
    'Russian',
  ])
  assert.deepEqual(parseLanguageList('English,,\n\n,Spanish'), ['English', 'Spanish'])
})

test('повторы не плодят кнопок: id и номер ⌘N обязаны быть уникальны', () => {
  assert.deepEqual(parseLanguageList('English, english, ENGLISH, Spanish'), ['English', 'Spanish'])
  const ids = translateOf(buildActionTree('English, english')).children.map((n) => n.id)
  assert.deepEqual(ids, ['translate-english'])
})

test('пустой список не даёт мёртвого подменю — берётся дефолт', () => {
  for (const raw of ['', '   ', ',,\n , ']) {
    assert.deepEqual(parseLanguageList(raw), [], `«${raw}» разобралось не в пустой список`)
    assert.deepEqual(
      translateOf(buildActionTree(raw)).children.map((n) => n.label),
      ['English', 'Spanish', 'Russian'],
      `«${raw}» оставило подменю без пунктов`
    )
  }
})

test('дефолт языков совпадает с тем, что лежит в Settings::default() на бэкенде', () => {
  // Строка дублируется в src-tauri/src/settings.rs (DEFAULT_TRANSLATE_LANGUAGES)
  // — как и остальные дефолты фронтенда. Здесь фиксируем её значение, чтобы
  // расхождение было видно, а не всплывало на первом пустом поле.
  assert.equal(DEFAULT_TRANSLATE_LANGUAGES, 'English, Spanish, Russian')
})

// Главное, ради чего Summarize вообще отдельная кнопка: две работы не должны
// сойтись к одной. Shorten обязан требовать сохранения формулировок автора,
// Summarize — прямо разрешать переписывать. Если эти слова уйдут из промптов,
// кнопки начнут выдавать одно и то же, и тест об этом скажет.
test('Shorten бережёт формулировки автора, Summarize — нет', () => {
  const shorten = leafOf(ACTION_TREE, 'shorten').buildRequest('x').system
  const summarize = leafOf(ACTION_TREE, 'summarize').buildRequest('x').system

  assert.notEqual(shorten, summarize)
  // Shorten: не переписывать, сохранить слова автора, не превращать в список.
  assert.match(shorten, /without rewriting/i)
  assert.match(shorten, /author’s own words/i)
  assert.match(shorten, /not restructure it into a list/i)
  // Summarize: переписывать можно и нужно, форма — короткие пункты.
  assert.match(summarize, /in your own words/i)
  assert.match(summarize, /do not try to preserve/i)
  assert.match(summarize, /bullet points/i)
  // И ни один из них не должен разрешать модели болтать вокруг ответа.
  for (const system of [shorten, summarize]) {
    assert.match(system, /no explanations/i)
  }
})

test('текст пользователя уходит в запрос как есть, без обёрток', () => {
  for (const id of ['fix', 'shorten', 'summarize']) {
    assert.equal(leafOf(ACTION_TREE, id).buildRequest('раз два три').user, 'раз два три')
  }
})
