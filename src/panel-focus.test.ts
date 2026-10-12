// Регрессия на баг «стрелки листают, а Enter не срабатывает» в главном окне.
//
// Причина была не в разборе клавиш, а во ВРЕМЕНИ ЖИЗНИ ref'а. Снимок
// уезжающей панели уровня (outgoingPanel в MainWindow.tsx) рисовался тем же
// JSX, что и живая панель, и нёс тот же самый ref={gridRef}. React отвязывает
// ref вместе с удалением снимка — то есть через 200мс после ЛЮБОЙ смены
// уровня, включая автоматический возврат в корень на новый текст, — и
// обнуляет gridRef.current, хотя живой список стоит на экране. Дальше
// gridRef.current?.focus() в оконном обработчике стрелок молчаливый no-op:
// подсветку стрелки двигают (она из состояния, не из фокуса), а настоящий
// DOM-фокус в список не попадает, поэтому Enter уходит в редактор, где голый
// <CR> в normal занят no-op'ом slaivePaste (см. Overlay.tsx). Состояние
// липкое: держалось до следующей смены уровня.
//
// Проверить это на живом DOM здесь нечем: `node --test` гоняет ЧИСТЫЕ модули,
// JSX не компилирует, а jsdom в зависимостях нет — тащить его ради одного
// теста дороже, чем польза. Поэтому тест стережёт само УСЛОВИЕ, на котором
// держится перенос фокуса: ref'ы главного окна обязаны проходить через флаг
// `live`, а снимок — строиться без них. Сам перенос фокуса и Enter поверх
// него остаются ручной проверкой (см. отчёт).
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
