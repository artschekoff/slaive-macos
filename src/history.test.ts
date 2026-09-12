// Подпись плитки истории. Проверяется то, что на плитке видно: обрезка
// длинного текста, нетронутый короткий и дата в человеческом виде.
import test from 'node:test'
import assert from 'node:assert/strict'
import { previewText, formatEntryDate, formatDuration, PREVIEW_LIMIT } from './history.ts'

test('превью: текст короче лимита возвращается как есть, без многоточия', () => {
  assert.equal(previewText('Короткая заметка'), 'Короткая заметка')
  // Ровно лимит — всё ещё «дальше ничего нет».
  const exact = 'x'.repeat(PREVIEW_LIMIT)
  assert.equal(previewText(exact), exact)
})

test('превью: пустой текст даёт пустую строку, а не многоточие', () => {
  assert.equal(previewText(''), '')
  assert.equal(previewText('   \n  '), '')
})

test('превью: переносы и двойные пробелы схлопываются в один пробел', () => {
  // В документе редактора перенос — обычный символ; на плитке в две строки
  // он оставлял бы дыры.
  assert.equal(previewText('первая строка\nвторая  строка'), 'первая строка вторая строка')
  assert.equal(previewText('  с краёв  '), 'с краёв')
})

test('превью: длинный текст режется по границе слова и получает многоточие', () => {
  const text = Array(60).fill('слово').join(' ')
  const out = previewText(text, 20)
  assert.ok(out.endsWith('…'), `нет многоточия: ${out}`)
  assert.ok(out.length <= 21, `длиннее лимита: ${out.length}`)
  // По границе слова — обрезанного «сло» на конце быть не должно.
  assert.equal(out, 'слово слово слово…')
})

test('превью: текст без пробелов режется по лимиту, а не превращается в пустую плитку', () => {
  const out = previewText('a'.repeat(100), 10)
  assert.equal(out, `${'a'.repeat(10)}…`)
})

test('дата: сегодня и вчера считаются по календарным суткам', () => {
  // Вчера в 23:50, смотрим сегодня в 01:00 — «меньше 24 часов назад», но
  // человек всё равно называет эту запись вчерашней.
  const now = new Date(2026, 8, 12, 1, 0)
  assert.equal(formatEntryDate(new Date(2026, 8, 11, 23, 50).getTime(), now), 'Yesterday, 23:50')
  assert.equal(formatEntryDate(new Date(2026, 8, 12, 0, 5).getTime(), now), 'Today, 00:05')
})

test('дата: в этом году без года, в прошлом — с годом', () => {
  const now = new Date(2026, 8, 12, 12, 0)
  assert.equal(formatEntryDate(new Date(2026, 8, 3, 18, 40).getTime(), now), 'Sep 3, 18:40')
  assert.equal(formatEntryDate(new Date(2025, 11, 31, 9, 5).getTime(), now), 'Dec 31, 2025, 09:05')
})

test('дата: формат английский и не зависит от системной локали', () => {
  const now = new Date(2026, 8, 12, 12, 0)
  const out = formatEntryDate(new Date(2026, 0, 7, 7, 7).getTime(), now)
  assert.equal(out, 'Jan 7, 07:07')
})

test('длительность: минуты и секунды с ведущим нулём', () => {
  assert.equal(formatDuration(7), '0:07')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(723), '12:03')
})

test('длительность: час и больше не превращается в 73:05', () => {
  assert.equal(formatDuration(3600 + 2 * 60 + 3), '1:02:03')
})

test('длительность: мусор показывается как 0:00, а не NaN', () => {
  assert.equal(formatDuration(Number.NaN), '0:00')
  assert.equal(formatDuration(-3), '0:00')
})
