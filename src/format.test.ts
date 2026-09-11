import test from 'node:test'
import assert from 'node:assert/strict'
import { formatBytes } from './format.ts'

test('формат размера: реальные веса каталога', () => {
  // Ровно те числа, что лежат в model.rs — цифра рядом с кнопкой Download
  // решает, хватит ли места на диске.
  assert.equal(formatBytes(77_691_713), '78 MB') // tiny
  assert.equal(formatBytes(147_951_465), '148 MB') // base
  assert.equal(formatBytes(487_601_967), '488 MB') // small
  assert.equal(formatBytes(1_533_763_059), '1.5 GB') // medium
  assert.equal(formatBytes(1_624_555_275), '1.6 GB') // large-v3-turbo
})

test('формат размера: модель VAD меньше мегабайта не превращается в 0 MB', () => {
  assert.equal(formatBytes(885_098), '0.9 MB')
})

test('формат размера: пусто и мусор дают 0 MB, а не NaN', () => {
  assert.equal(formatBytes(0), '0 MB')
  assert.equal(formatBytes(-5), '0 MB')
  assert.equal(formatBytes(Number.NaN), '0 MB')
})

test('формат размера: суммарно занятое место в разделе Models', () => {
  // small + large-v3-turbo + VAD — типичная папка у того, кто пробовал обе.
  assert.equal(formatBytes(487_601_967 + 1_624_555_275 + 885_098), '2.1 GB')
})
