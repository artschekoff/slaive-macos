import test from 'node:test'
import assert from 'node:assert/strict'
import { resampleLevels } from './levels.ts'

test('resampleLevels: короткая запись растягивается на всю ширину', () => {
  // 3 замера на 6 столбиков — рисунок занимает всю дорожку, а не её половину.
  assert.deepEqual(resampleLevels([10, 20, 30], 6), [10, 10, 20, 20, 30, 30])
})

test('resampleLevels: длинная запись сжимается максимумом по окну', () => {
  // Максимум, а не среднее: каждый замер сам по себе уже пик своего чанка,
  // усреднение приглушало бы короткие громкие места.
  assert.deepEqual(resampleLevels([0, 40, 0, 80], 2), [40, 80])
})

test('resampleLevels: длина результата всегда равна ширине', () => {
  for (const n of [1, 2, 7, 150, 4000]) {
    const levels = Array.from({ length: n }, (_, i) => i % 100)
    assert.equal(resampleLevels(levels, 146).length, 146)
  }
})

test('resampleLevels: тишина остаётся тишиной при любом масштабе', () => {
  // Главный инвариант дорожки: она отличает мёртвый микрофон (поток нулей от
  // macOS при отказе в доступе) от настоящего сигнала. Раскладка по ширине
  // не имеет права поднять ноль хоть на пиксель — ни растяжением, ни сжатием.
  assert.ok(resampleLevels([0, 0, 0], 12).every((v) => v === 0))
  assert.ok(resampleLevels(new Array(500).fill(0), 12).every((v) => v === 0))
})

test('resampleLevels: растяжение не интерполирует между соседями', () => {
  // Между 0 и 100 не должно появиться промежуточных значений — иначе тихий
  // участок рядом с громким выглядел бы как сигнал, которого не было.
  const out = resampleLevels([0, 100], 8)
  assert.ok(out.every((v) => v === 0 || v === 100))
})

test('resampleLevels: пустой вход и нулевая ширина не падают', () => {
  assert.deepEqual(resampleLevels([], 100), [])
  assert.deepEqual(resampleLevels([1, 2, 3], 0), [])
})

test('resampleLevels: совпадающий масштаб возвращает данные как есть', () => {
  const levels = [1, 2, 3, 4]
  assert.deepEqual(resampleLevels(levels, 4), levels)
})
