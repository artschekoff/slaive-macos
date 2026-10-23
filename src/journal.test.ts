// Юнит-тесты формата записи журнала — тот же приём, что smart-replace.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatJournalEntry } from './journal.ts'

// Месяц 0-индексный: 9 — октябрь. Однозначные час и минута проверяют нули.
const date = new Date(2026, 9, 20, 9, 5)

test('запись — пункт списка с локальным таймстампом, нули на месте', () => {
  assert.equal(formatJournalEntry('куплен хлеб', date), '- **2026-10-20 09:05** куплен хлеб')
})

test('многострочный текст остаётся ОДНИМ пунктом списка — продолжение с отступом', () => {
  assert.equal(
    formatJournalEntry('план:\n- хлеб\n- молоко', date),
    '- **2026-10-20 09:05** план:\n  - хлеб\n  - молоко',
  )
})

test('края текста обрезаются — пустые строки диктовки не тянутся в чужой файл', () => {
  assert.equal(formatJournalEntry('\n  текст  \n', date), '- **2026-10-20 09:05** текст')
})
