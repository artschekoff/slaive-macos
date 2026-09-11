// Юнит-тесты чистых функций из ai.ts. Сеть и Tauri здесь не участвуют —
// см. shortcut.test.ts для того же приёма с другим модулем.
import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveBaseUrl, isSelectable, type AiProviderInfo } from './ai.ts'

const openai: AiProviderInfo = {
  id: 'openai',
  label: 'OpenAI',
  implemented: true,
  defaultBaseUrl: 'https://api.openai.com',
  exampleModel: 'gpt-4o-mini',
}

test('effectiveBaseUrl falls back to the provider default when unset', () => {
  assert.equal(effectiveBaseUrl(openai, null), 'https://api.openai.com')
  assert.equal(effectiveBaseUrl(openai, undefined), 'https://api.openai.com')
  assert.equal(effectiveBaseUrl(openai, ''), 'https://api.openai.com')
  assert.equal(effectiveBaseUrl(openai, '   '), 'https://api.openai.com')
})

test('effectiveBaseUrl uses the override and trims trailing slashes', () => {
  assert.equal(effectiveBaseUrl(openai, 'https://proxy.example.com/'), 'https://proxy.example.com')
  assert.equal(effectiveBaseUrl(openai, '  https://proxy.example.com  '), 'https://proxy.example.com')
  assert.equal(effectiveBaseUrl(openai, 'https://proxy.example.com///'), 'https://proxy.example.com')
})

test('isSelectable reflects the implemented flag', () => {
  assert.equal(isSelectable(openai), true)
  assert.equal(isSelectable({ implemented: false }), false)
  assert.equal(isSelectable(undefined), false)
})
