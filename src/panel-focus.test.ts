// Стопка панелей главного окна (.mw-panel-stack в MainWindow.tsx) и её
// фокус-цикл. Три дефекта одной семьи — путаницы между ЖИВОЙ панелью уровня
// и СНИМКОМ уезжающей, который держится 200мс ради анимации:
//
// 1. Снимок уносил с собой ref живого списка. React отвязывает ref вместе с
//    удалением снимка — то есть через 200мс после ЛЮБОЙ смены уровня — и
//    обнуляет gridRef.current, хотя живой список стоит на экране. Дальше
//    gridRef.current?.focus() молчаливый no-op: подсветку стрелки двигают
//    (она из состояния, не из фокуса), а DOM-фокус в список не попадает,
//    поэтому Enter уходит в редактор, где голый <CR> в normal занят no-op'ом
//    slaivePaste (см. Overlay.tsx). Состояние липкое: держалось до
//    следующей смены уровня.
// 2. Снимок оставался интерактивным: 200мс после каждой смены уровня клик
//    попадал по кнопке, которая уезжает за край.
// 3. Фокус оставался в <body> после действия, запущенного из КОРНЯ: панель
//    Accept/Cancel снимает список, а по возврату уровень тот же самый,
//    и эффект переноса фокуса не перезапускался.
//
// Решения 2 и 3 — чистые функции в panel-focus.ts, и проверяются они здесь
// прямо. Решение 1 — условие в разметке, его проверить нечем, кроме самого
// исходника: `node --test` гоняет ЧИСТЫЕ модули, JSX не компилирует, а jsdom
// в зависимостях нет — тащить его ради одного теста дороже, чем польза.
// Сам перенос фокуса в WKWebView и Enter поверх него остаются ручной
// проверкой (см. отчёт).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { panelGuard, panelTabStop, livePanelKey, nextFocusTarget } from './panel-focus.ts'

const source = readFileSync(new URL('./MainWindow.tsx', import.meta.url), 'utf8')

test('the action list ref belongs to the live level panel, never to the outgoing snapshot', () => {
  assert.match(source, /ref=\{live \? gridRef : null\}/)
  assert.doesNotMatch(source, /ref=\{gridRef\}/)
})

test('the Ask AI prompt ref belongs to the live level panel too', () => {
  // Та же беда и тот же исход: без флага снимок формы Ask AI уносил бы с
  // собой привязку поля ввода, и после возврата из формы фокус в неё уже не
  // вернулся бы.
  assert.match(source, /ref=\{live \? promptInputRef : null\}/)
  assert.doesNotMatch(source, /ref=\{promptInputRef\}/)
})

test('the outgoing panel is rendered from the ref-less snapshot', () => {
  assert.match(source, /const idlePanelSnapshot[^\n]*renderIdlePanel\(false\)/)
  assert.match(source, /node: idlePanelSnapshot/)
  // Прежняя, сломанная проводка: снимком служил тот же узел, что рисует живая
  // панель.
  assert.doesNotMatch(source, /node: idlePanelNode/)
})

test('tab stops inside a level panel go through the same live flag as its refs', () => {
  // Один флаг на всё, что делает панель «настоящей»: ref'ы и tab-стопы. Жёсткий
  // tabIndex={0} вернул бы снимку второй, невидимый listbox на пути Tab.
  assert.match(source, /tabIndex=\{panelTabStop\(live\)\}/)
  assert.doesNotMatch(source, /tabIndex=\{0\}/)
})

test('the outgoing panel is the only one in the stack that is not reachable', () => {
  // Достижимость объявляет каждая панель стопки, и ровно одна из них —
  // уезжающий снимок — объявляет её отсутствие.
  assert.equal(source.match(/\{\.\.\.panelGuard\(false\)\}/g)?.length, 1)
  assert.match(source, /\{\.\.\.panelGuard\(true\)\}/)
})

test('the focus effect follows the live panel, not the menu level', () => {
  // Прежняя зависимость от idlePanelKey и была дефектом 3: при действии из
  // корня уровень не меняется, а живая панель меняется трижды.
  assert.match(source, /\}, \[liveKey\]\)/)
  assert.doesNotMatch(source, /\[idlePanelKey, showingPrompt\]/)
})

test('the outgoing snapshot is inert, out of the accessibility tree and out of Tab', () => {
  // Не «только для мыши»: снимок, невидимый для мыши, но оставшийся в дереве
  // доступности, — тот же самый дефект для того, кто слушает читалку.
  assert.deepEqual(panelGuard(false), { inert: '', 'aria-hidden': 'true' })
  assert.equal(panelTabStop(false), -1)
  // Пустая строка, а не true/false: атрибут булев по HTML, и inert="false"
  // сделал бы панель inert точно так же — значение здесь ни при чём.
  assert.equal(panelGuard(false).inert, '')
})

test('the live panel declares nothing — it is an ordinary interface', () => {
  assert.deepEqual(panelGuard(true), {})
  assert.equal(panelTabStop(true), 0)
})

test('each guard call returns its own object', () => {
  // Общий изменяемый объект в props двух панелей — ровно тот род связи между
  // живой панелью и снимком, из которого растут оба дефекта.
  assert.notEqual(panelGuard(false), panelGuard(false))
})

test('the live panel key changes on every swap of an action launched from the root', () => {
  // Сам дефект 3, в одну строку: уровень всё время корень, а панель
  // сменилась трижды — список, Working, предложение, снова список.
  const root = 'level:0:translate,ask'
  const keys = (['idle', 'pending', 'proposed', 'idle'] as const).map((phase) =>
    livePanelKey(phase, root)
  )
  assert.deepEqual(keys, [root, 'apply:pending', 'apply:proposed', root])
  // Прежний ключ (один idlePanelKey) не менялся ни разу — поэтому эффект и
  // не перезапускался, а фокус оставался в <body>.
  assert.equal(new Set(keys).size, 3)
})

test('pending and proposed are different live panels', () => {
  // React пересоздаёт панель по ключу, фокус при этом теряется, и перенести
  // его надо заново — ключ обязан различать эти две фазы.
  assert.notEqual(livePanelKey('pending', 'level:0:x'), livePanelKey('proposed', 'level:0:x'))
})

test('the level under the apply panel does not leak into its key', () => {
  // Иначе Accept/Cancel, запущенные из подменю, считались бы другой панелью,
  // чем те же самые из корня, без всякой разницы на экране.
  assert.equal(livePanelKey('pending', 'level:0:a'), livePanelKey('pending', 'level:1:b'))
})

test('focus follows the live panel: list, prompt field, apply panel', () => {
  assert.equal(
    nextFocusTarget({ menuHadFocus: true, phase: 'idle', showingPrompt: false }),
    'list'
  )
  assert.equal(
    nextFocusTarget({ menuHadFocus: true, phase: 'idle', showingPrompt: true }),
    'prompt'
  )
  assert.equal(
    nextFocusTarget({ menuHadFocus: true, phase: 'pending', showingPrompt: false }),
    'apply'
  )
  assert.equal(
    nextFocusTarget({ menuHadFocus: true, phase: 'proposed', showingPrompt: false }),
    'apply'
  )
})

test('the apply panel wins over the prompt field it replaced', () => {
  // Ask AI отправлен — формы на экране больше нет, фокусировать её поле
  // некуда, хотя menuState.prompt ещё открыт.
  assert.equal(
    nextFocusTarget({ menuHadFocus: true, phase: 'pending', showingPrompt: true }),
    'apply'
  )
})

test('focus is never taken from someone who did not give it', () => {
  // Человек печатает в редакторе и запускает действие хоткеем: фокус его, и
  // отбирать его панелью применения нечем.
  for (const phase of ['idle', 'pending', 'proposed'] as const) {
    for (const showingPrompt of [false, true]) {
      assert.equal(nextFocusTarget({ menuHadFocus: false, phase, showingPrompt }), 'none')
    }
  }
})
