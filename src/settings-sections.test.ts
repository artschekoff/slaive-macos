import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SECTIONS,
  FIRST_SECTION,
  ALL_SETTING_KEYS,
  sectionOf,
  type SettingKey,
} from './settings-sections.ts'
import type { Settings } from './api.ts'

test('состав разделов — пять, в порядке брифа', () => {
  assert.deepEqual(
    SECTIONS.map((s) => s.id),
    ['audio', 'models', 'recognition', 'shortcuts', 'ai']
  )
  assert.deepEqual(
    SECTIONS.map((s) => s.title),
    ['Audio', 'Models', 'Recognition', 'Shortcuts', 'AI']
  )
})

test('при открытии окна показан первый раздел', () => {
  assert.equal(FIRST_SECTION, 'audio')
  assert.equal(FIRST_SECTION, SECTIONS[0].id)
})

test('пустых разделов нет: в каждом есть что настраивать', () => {
  for (const s of SECTIONS) {
    assert.ok(s.settings.length > 0, `раздел ${s.id} пуст`)
    assert.ok(s.summary.length > 0, `у раздела ${s.id} нет подписи`)
  }
})

test('распределение настроек по разделам — ровно как в брифе', () => {
  const byId = (id: string) => SECTIONS.find((s) => s.id === id)!.settings
  // Audio — что попадает в микрофон.
  assert.deepEqual(byId('audio'), ['inputDevice', 'micGain'])
  // Models — что скачивается и занимает диск.
  assert.deepEqual(byId('models'), ['modelPath', 'vadModelPath'])
  // Recognition — как звук превращается в текст.
  assert.deepEqual(byId('recognition'), ['language', 'vadThreshold', 'dictionary'])
  // Shortcuts — управление.
  assert.deepEqual(byId('shortcuts'), [
    'hotkey',
    'pasteShortcut',
    'copyShortcut',
    'translateShortcut',
    'askAiShortcut',
    'fixShortcut',
    'shortenShortcut',
  ])
  // AI — обработка уже готового текста.
  assert.deepEqual(byId('ai'), ['ai'])
})

test('VAD разнесён намеренно: модель в Models, порог в Recognition', () => {
  // Скачивание живёт рядом с остальными загрузками, а порог крутят из-за
  // качества расшифровки, а не из-за загрузки.
  assert.equal(sectionOf('vadModelPath'), 'models')
  assert.equal(sectionOf('vadThreshold'), 'recognition')
})

test('ни одна настройка не попала в два раздела сразу', () => {
  const seen = new Set<SettingKey>()
  for (const key of ALL_SETTING_KEYS) {
    assert.ok(!seen.has(key), `настройка ${key} встречается дважды`)
    seen.add(key)
  }
  assert.equal(seen.size, ALL_SETTING_KEYS.length)
})

test('каждая хранимая настройка доступна хотя бы из одного раздела', () => {
  // Образец с ВСЕМИ полями Settings: тип обязывает перечислить каждое, и
  // добавленное в будущем поле уронит этот тест, пока ему не найдут раздел.
  // Именно та дыра, которую перекладка интерфейса открывает молча: поле
  // остаётся в settings.json, но до него больше не добраться.
  const sample: Settings = {
    hotkey: 'Super+KeyT',
    modelPath: null,
    language: 'auto',
    vadModelPath: null,
    pasteShortcut: 'Enter',
    copyShortcut: 'Super+KeyC',
    translateShortcut: 'Super+KeyL',
    askAiShortcut: 'Super+KeyK',
    fixShortcut: 'Super+KeyF',
    shortenShortcut: 'Super+KeyS',
    ai: { provider: 'openai', providers: {} },
    micGain: 1,
    vadThreshold: 0.5,
    inputDevice: null,
    dictionary: '',
  }
  const stored = Object.keys(sample).sort()
  const placed = [...ALL_SETTING_KEYS].sort()
  assert.deepEqual(placed, stored)
  for (const key of stored) {
    assert.ok(sectionOf(key as SettingKey), `настройке ${key} не нашлось раздела`)
  }
})

test('sectionOf молчит про то, чего в разделах нет', () => {
  assert.equal(sectionOf('несуществующая' as SettingKey), undefined)
})
