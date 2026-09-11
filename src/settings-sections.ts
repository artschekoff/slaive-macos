// Состав разделов настроек — чистые данные, отдельно от отображения
// (Settings.tsx), по тому же принципу, что shortcut.ts и ai.ts: разложение
// настроек по разделам можно проверить тестом, а раскладку двух панелей —
// нельзя, и смешивать их незачем.

/** Ключ настройки в том виде, в каком он лежит в settings.json (camelCase). */
export type SettingKey =
  | 'inputDevice'
  | 'micGain'
  | 'modelPath'
  | 'vadModelPath'
  | 'language'
  | 'vadThreshold'
  | 'dictionary'
  | 'hotkey'
  | 'pasteShortcut'
  | 'copyShortcut'
  | 'translateShortcut'
  | 'askAiShortcut'
  | 'fixShortcut'
  | 'shortenShortcut'
  | 'summarizeShortcut'
  | 'mainPasteShortcut'
  | 'ai'
  | 'translateLanguages'

export type SectionId = 'audio' | 'models' | 'recognition' | 'shortcuts' | 'ai'

export type Section = {
  id: SectionId
  /** Подпись в левом столбце. Английский, как весь интерфейс. */
  title: string
  /** Одна строка под заголовком правой панели — зачем сюда заходят. */
  summary: string
  /** Какие хранимые настройки живут в этом разделе. */
  settings: readonly SettingKey[]
}

/**
 * Хоткеи действий главного окна (Translate/Ask AI/Fix/Shorten/Summarize) живут
 * здесь же, а не в разделе AI: они управление, как и остальные комбинации, —
 * какую клавишу нажать, а не что произойдёт с текстом.
 *
 * Языки перевода (`translateLanguages`), наоборот, лежат в AI: это ровно
 * «обработка уже готового текста» — из них строится подменю Translate, то есть
 * какие запросы к модели вообще можно попросить. В Recognition их класть
 * нельзя: там язык ВХОДА для whisper, и два разных «языка» в одном разделе
 * читались бы как одна настройка.
 *
 * Логика деления: Audio — что попадает в микрофон; Models — что скачивается и
 * занимает диск; Recognition — как звук превращается в текст; Shortcuts —
 * управление; AI — обработка уже готового текста.
 *
 * VAD разнесён намеренно: скачивание его модели живёт рядом с остальными
 * загрузками, а порог — в распознавании, потому что крутят его из-за качества
 * расшифровки, а не из-за загрузки.
 *
 * Порядок массива — порядок столбца слева; первый элемент открывается при
 * открытии окна.
 */
export const SECTIONS: readonly Section[] = [
  {
    id: 'audio',
    title: 'Audio',
    summary: 'What goes into the microphone.',
    settings: ['inputDevice', 'micGain'],
  },
  {
    id: 'models',
    title: 'Models',
    summary: 'What gets downloaded and takes up disk space.',
    settings: ['modelPath', 'vadModelPath'],
  },
  {
    id: 'recognition',
    title: 'Recognition',
    summary: 'How the sound turns into text.',
    settings: ['language', 'vadThreshold', 'dictionary'],
  },
  {
    id: 'shortcuts',
    title: 'Shortcuts',
    summary: 'How you drive it.',
    settings: [
      'hotkey',
      'pasteShortcut',
      'copyShortcut',
      'translateShortcut',
      'askAiShortcut',
      'fixShortcut',
      'shortenShortcut',
      'summarizeShortcut',
      'mainPasteShortcut',
    ],
  },
  {
    id: 'ai',
    title: 'AI',
    summary: 'What happens to the text after it is recognized.',
    settings: ['ai', 'translateLanguages'],
  },
]

/** Раздел, открытый при открытии окна — первый, а не запомненный: настройки
 *  открывают ради конкретного дела, и «где я был в прошлый раз» этому не
 *  помогает, зато делает окно непредсказуемым. */
export const FIRST_SECTION: SectionId = SECTIONS[0].id

/** Все настройки, которые вообще разложены по разделам. */
export const ALL_SETTING_KEYS: readonly SettingKey[] = SECTIONS.flatMap((s) => s.settings)

/** В каком разделе живёт настройка. `undefined` — нигде, то есть настройка
 *  выпала из интерфейса и до неё не добраться. */
export function sectionOf(key: SettingKey): SectionId | undefined {
  return SECTIONS.find((s) => s.settings.includes(key))?.id
}
