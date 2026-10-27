// Юнит-тесты чистых функций из dictor-roles.ts — тот же приём, что ai.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRoleSystemPrompt, findRole, roleForApp, type DictorRole } from './dictor-roles.ts'

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
  assert.ok(system.includes('only the resulting text'))
  // Профилю разрешено менять стиль и структуру (роли-форматы Email/Note/
  // Concise из сида), но язык и смысл — зона рамки, не профиля.
  assert.ok(system.includes('keep the original language and meaning'))
})

test('roleForApp: подстрока без регистра, первое совпадение побеждает', () => {
  const writer: DictorRole = { id: 'id-2', name: 'Writer', prompt: 'Проза.' }
  const roles = [programmer, writer]
  const appRoles = [
    { id: 'a1', app: 'code', roleId: 'id-1' },
    { id: 'a2', app: 'co', roleId: 'id-2' },
  ]
  assert.deepEqual(roleForApp(appRoles, roles, 'Code - Insiders'), programmer)
  // «co» тоже совпадает, но стоит вторым — порядок списка решает.
  assert.deepEqual(roleForApp(appRoles, roles, 'Comet'), writer)
})

test('roleForApp: нет приложения, нет совпадения или роль удалили — null', () => {
  const appRoles = [
    { id: 'a1', app: 'slack', roleId: 'deleted-id' },
    { id: 'a2', app: '  ', roleId: 'id-1' },
  ]
  assert.equal(roleForApp(appRoles, [programmer], null), null)
  assert.equal(roleForApp(appRoles, [programmer], 'Finder'), null)
  // Привязка на удалённую роль и пустая подстрока молчат, не падают;
  // пустая подстрока не должна совпадать со всем подряд.
  assert.equal(roleForApp(appRoles, [programmer], 'Slack'), null)
})

test('targetLanguage с ролью: правка И перевод одним проходом', () => {
  const system = buildRoleSystemPrompt(programmer, '', 'English')
  // Профиль на месте — роль не теряется из-за перевода.
  assert.ok(system.includes(programmer.prompt))
  // Рамка теперь ВЕЛИТ переводить в язык, а не запрещает перевод.
  assert.ok(system.includes('Write the final result in English'))
  // Запрет «keep the original language» снят — иначе модель не переведёт.
  assert.ok(!system.includes('keep the original language'))
  // Но отвечать на текст по-прежнему нельзя.
  assert.ok(system.includes('Never answer'))
})

test('targetLanguage без роли: чистый перевод, без профиля', () => {
  const system = buildRoleSystemPrompt(null, '', 'Spanish')
  assert.ok(system.includes('Translate it into Spanish'))
  assert.ok(system.includes('only the translated text'))
  // Словарь работает и в режиме перевода-без-роли.
  const withDict = buildRoleSystemPrompt(null, 'Kubernetes', 'Spanish')
  assert.ok(withDict.includes('Preserve these exact spellings'))
})

test('ни роли, ни языка — пустой промпт (звать ИИ незачем)', () => {
  assert.equal(buildRoleSystemPrompt(null, 'React', ''), '')
})

test('словарь терминов попадает в промпт, пустой — не добавляет ничего', () => {
  // Термины пишут и по строкам, и через запятую (оба формата живут в
  // settings.json) — промпт обязан понять оба и склеить в один список.
  const system = buildRoleSystemPrompt(programmer, 'React\nKubernetes, deploy\n\n')
  assert.ok(system.includes('Preserve these exact spellings when they appear: React, Kubernetes, deploy.'))
  // Без словаря строки нет вовсе: пустой список «Preserve:» читался бы
  // моделью как инструкция без содержания.
  assert.ok(!buildRoleSystemPrompt(programmer).includes('Preserve'))
  assert.ok(!buildRoleSystemPrompt(programmer, '  \n , ').includes('Preserve'))
})
