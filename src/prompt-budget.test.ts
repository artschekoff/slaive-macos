// Счётчик бюджета подсказки whisper. Проверяется прежде всего одно: оценка
// считается по СКЛЕЕННОЙ подсказке, а не по тексту поля. Разница между ними —
// ровно то место, где счётчик мог бы молча врать в успокаивающую сторону.
import test from 'node:test'
import assert from 'node:assert/strict'
import { estimatePromptTokens, promptFromDictionary, MAX_PROMPT_TOKENS } from './prompt-budget.ts'

test('promptFromDictionary: строки и запятые — одно и то же для whisper', () => {
  // Ровно тот же разбор, что у whisper::initial_prompt в Rust: пользователь
  // пишет как удобнее, до модели доезжает одна строка через ", ".
  assert.equal(promptFromDictionary('React\nDocker'), 'React, Docker')
  assert.equal(promptFromDictionary('React, Docker'), 'React, Docker')
  assert.equal(promptFromDictionary('React,\nDocker'), 'React, Docker')
})

test('promptFromDictionary: пустые куски и пробелы выбрасываются', () => {
  assert.equal(promptFromDictionary('\n\nReact ,,  \n  Docker \n'), 'React, Docker')
  assert.equal(promptFromDictionary(''), '')
  assert.equal(promptFromDictionary('  ,\n, '), '')
})

test('promptFromDictionary: термин из нескольких слов остаётся одним термином', () => {
  // Пробел внутри термина — не разделитель: "pull request" и "load balancer"
  // в сиде именно такие.
  assert.equal(promptFromDictionary('pull request\nload balancer'), 'pull request, load balancer')
})

test('estimatePromptTokens: пустой словарь — ноль токенов', () => {
  assert.equal(estimatePromptTokens(''), 0)
  assert.equal(estimatePromptTokens('  \n , '), 0)
})

test('estimatePromptTokens: считает по склейке, а не по длине поля', () => {
  // Главный инвариант модуля. Тот же словарь, записанный построчно и через
  // запятую, даёт РАЗНУЮ длину текста в поле (перенос — один символ, ", " —
  // два), но одинаковую подсказку. Счётчик, считающий по сырому полю,
  // показал бы построчному словарю запас, которого нет.
  const lines = 'commit\nmerge\nrebase\npull request'
  const commas = 'commit, merge, rebase, pull request'
  assert.notEqual(lines.length, commas.length)
  assert.equal(estimatePromptTokens(lines), estimatePromptTokens(commas))
})

test('estimatePromptTokens: растёт вместе со словарём и переходит потолок', () => {
  const short = estimatePromptTokens('React\nDocker')
  assert.ok(short > 0 && short < MAX_PROMPT_TOKENS)
  // Заведомо длинный словарь обязан быть распознан как перебор — иначе
  // предупреждение в настройках не покажется никогда.
  const huge = Array.from({ length: 400 }, (_, i) => `term${i}`).join('\n')
  assert.ok(estimatePromptTokens(huge) > MAX_PROMPT_TOKENS)
})

test('estimatePromptTokens: оценка консервативна (не меньше символов/4)', () => {
  // Направление запаса: BPE whisper на английском — порядка 4 символов на
  // токен, оценка обязана быть НЕ НИЖЕ этого, иначе счётчик успокаивает
  // раньше времени. Проверяется на произвольном словаре, а не на константе.
  const dict = 'commit\nmerge\nKubernetes\nSecret Manager\npull request'
  const prompt = promptFromDictionary(dict)
  assert.ok(estimatePromptTokens(dict) >= prompt.length / 4)
})
