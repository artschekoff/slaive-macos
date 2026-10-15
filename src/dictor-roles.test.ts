// Юнит-тесты чистых функций из dictor-roles.ts — тот же приём, что ai.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoleSystemPrompt, findRole, type DictorRole } from './dictor-roles.ts'

const programmer: DictorRole = {
  id: 'id-1',
  name: 'Программист',
  prompt: 'Я программист: правь компьютерные термины (git, Kubernetes, deploy).',
}

test('findRole находит роль по id', () => {
  assert.deepEqual(findRole([programmer], 'id-1'), programmer)
})

test('findRole: выключенная или удалённая роль — null, не падение', () => {
  // null — правка выключена; несуществующий id — роль удалили в настройках,
  // панель в обоих случаях показывает текст как есть.
  assert.equal(findRole([programmer], null), null)
  assert.equal(findRole([programmer], 'deleted-id'), null)
  assert.equal(findRole([], 'id-1'), null)
})

test('системный промпт несёт профиль роли внутри фиксированной рамки', () => {
  const system = buildRoleSystemPrompt(programmer)
  // Вкладыш пользователя доехал целиком.
  assert.ok(system.includes(programmer.prompt))
  // Рамка запрещает модели отвечать на текст вместо его правки — главный
  // провал этой фичи, если промпт её потеряет: «почему падает тест?»
  // вернулся бы ответом, а не починенной фразой.
  assert.ok(system.includes('Never answer'))
  assert.ok(system.includes('only the corrected text'))
})
