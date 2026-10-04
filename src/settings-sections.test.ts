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

test('состав разделов — шесть, в порядке брифа', () => {
  assert.deepEqual(
    SECTIONS.map((s) => s.id),
    ['audio', 'models', 'recognition', 'shortcuts', 'ai', 'appearance']
  )
  assert.deepEqual(
    SECTIONS.map((s) => s.title),
    ['Audio', 'Models', 'Recognition', 'Shortcuts', 'AI', 'Appearance']
  )
})

// Прозрачность окон — не звук, не модели, не распознавание, не управление и
// не ИИ. Втиснутая в любой из пяти прежних разделов, она оказалась бы там,
// где её не станут искать; отсюда шестой.
test('прозрачность окон живёт в Appearance, а не втиснута в соседей', () => {
  assert.equal(sectionOf('windowOpacity'), 'appearance')
  assert.deepEqual(SECTIONS.find((s) => s.id === 'appearance')!.settings, ['windowOpacity'])
})

// Appearance стоит последним и не подвинул стартовый раздел: окно настроек
// открывают ради дела, а не ради того, чтобы посмотреть на него же.
test('Appearance стоит последним', () => {
  assert.equal(SECTIONS[SECTIONS.length - 1].id, 'appearance')
  assert.notEqual(FIRST_SECTION, 'appearance')
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
  assert.deepEqual(byId('audio'), ['inputDevice', 'echoCancellation', 'highPassFilter', 'micGain'])
  // Models — что скачивается и занимает диск.
  assert.deepEqual(byId('models'), ['modelPath', 'vadModelPath'])
  // Recognition — как звук превращается в текст.
  assert.deepEqual(byId('recognition'), ['language', 'vadThreshold', 'dictionary'])
  // Shortcuts — управление.
  assert.deepEqual(byId('shortcuts'), [
    'hotkey',
    'pasteShortcut',
    'copyShortcut',
    'followShortcut',
    'translateShortcut',
    'askAiShortcut',
    'generateShortcut',
    'fixShortcut',
    'shortenShortcut',
    'summarizeShortcut',
    'mainPasteShortcut',
    'mainCopyShortcut',
    'acceptShortcut',
  ])
  // AI — обработка уже готового текста: провайдер и то, что у него просят.
  assert.deepEqual(byId('ai'), ['ai', 'translateLanguages'])
})

// Языки перевода — цели ИИ-действия, а язык whisper — вход распознавания.
// Двум разным «языкам» в одном разделе делать нечего: их бы путали.
test('языки перевода лежат в AI, а язык распознавания — в Recognition', () => {
  assert.equal(sectionOf('translateLanguages'), 'ai')
  assert.equal(sectionOf('language'), 'recognition')
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
    followShortcut: 'Ctrl+KeyF',
    translateShortcut: 'Super+KeyL',
    askAiShortcut: 'Super+KeyK',
    generateShortcut: 'Super+KeyG',
    fixShortcut: 'Super+KeyF',
    shortenShortcut: 'Super+KeyS',
    summarizeShortcut: 'Super+KeyU',
    mainPasteShortcut: 'Super+Enter',
    mainCopyShortcut: 'Super+KeyC',
    acceptShortcut: 'Shift+Super+Enter',
    ai: { provider: 'openai', providers: {} },
    translateLanguages: 'English, Spanish, Russian',
    micGain: 1,
    vadThreshold: 0.5,
    inputDevice: null,
    echoCancellation: true,
    highPassFilter: true,
    windowOpacity: 0.9,
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
