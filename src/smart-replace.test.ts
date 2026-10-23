// Юнит-тесты Smart Replace — тот же приём, что dictor-roles.test.ts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applySmartReplaces, type SmartReplace } from './smart-replace.ts'

const pair = (from: string, to: string, id = 'p'): SmartReplace => ({ id, from, to })

test('заменяет фразу без учёта регистра — заглавные расставляет whisper', () => {
  assert.equal(
    applySmartReplaces('Meeting link отправлю позже', [pair('meeting link', 'cal.com/art')]),
    'cal.com/art отправлю позже',
  )
})

test('только целая фраза: не срабатывает внутри слова, и кириллица — тоже слово', () => {
  // \b здесь не годится: он знает только ASCII, и на «кот» внутри
  // «который» граница нашлась бы. Проверяем оба алфавита.
  assert.equal(applySmartReplaces('который час', [pair('кот', 'Барсик')]), 'который час')
  assert.equal(applySmartReplaces('scattered', [pair('cat', 'dog')]), 'scattered')
  assert.equal(applySmartReplaces('мой кот спит', [pair('кот', 'Барсик')]), 'мой Барсик спит')
})

test('пары применяются по порядку, все вхождения сразу', () => {
  const out = applySmartReplaces('ссылка и ещё раз ссылка', [pair('ссылка', 'url')])
  assert.equal(out, 'url и ещё раз url')
})

test('спецсимволы: «from» — буквальный текст, «$&» в «to» — тоже буквальный', () => {
  assert.equal(
    applySmartReplaces('цена c++ выросла', [pair('c++', 'C++ (язык)')]),
    'цена C++ (язык) выросла',
  )
  assert.equal(applySmartReplaces('итог', [pair('итог', 'сумма $& готово')]), 'сумма $& готово')
})

test('пустая или пробельная «from» пропускается, текст не трогается', () => {
  assert.equal(applySmartReplaces('текст', [pair('', 'x'), pair('  ', 'y')]), 'текст')
})
