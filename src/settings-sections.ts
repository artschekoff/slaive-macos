// Состав разделов настроек — чистые данные, отдельно от отображения
// (Settings.tsx), по тому же принципу, что shortcut.ts и ai.ts: разложение
// настроек по разделам можно проверить тестом, а раскладку двух панелей —
// нельзя, и смешивать их незачем.

/** Ключ настройки в том виде, в каком он лежит в settings.json (camelCase). */
export type SettingKey =
  | 'inputDevice'
  | 'muteSystemAudio'
  | 'micGain'
  | 'highPassFilter'
  | 'modelPath'
  | 'vadModelPath'
  | 'language'
  | 'vadThreshold'
  | 'dictionary'
  | 'smartReplaces'
  | 'hotkey'
  | 'pasteShortcut'
  | 'copyShortcut'
  | 'followShortcut'
  | 'translateShortcut'
  | 'askAiShortcut'
  | 'generateShortcut'
  | 'fixShortcut'
  | 'shortenShortcut'
  | 'summarizeShortcut'
  | 'mainPasteShortcut'
  | 'mainCopyShortcut'
  | 'acceptShortcut'
  | 'ai'
  | 'translateLanguages'
  | 'dictorRoles'
  | 'dictorRole'
  | 'appRoles'
  | 'journalPath'
  | 'windowOpacity'

export type SectionId =
  | 'audio'
  | 'models'
  | 'recognition'
  | 'shortcuts'
  | 'ai'
  | 'appearance'
  | 'license'

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
 * управление; AI — обработка уже готового текста; Appearance — как окна
 * выглядят на экране.
 *
 * Appearance заведён под прозрачность окон, потому что втискивать её было
 * некуда: она не про звук, не про модели, не про распознавание, не про
 * управление и не про ИИ. Раздел из одной настройки выглядит худым, но
 * альтернатива — настройка, лежащая не по адресу, и её не найдут глазами
 * там, где будут искать. Стоит последним: это единственный раздел, в который
 * не заходят по делу, а заходят посмотреть.
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
    settings: ['inputDevice', 'muteSystemAudio', 'highPassFilter', 'micGain'],
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
    // smartReplaces — здесь, а не в AI: замены локальные, без единого
    // сетевого запроса, и правят они то, как произнесённое становится
    // текстом, — ровно тема раздела.
    settings: ['language', 'vadThreshold', 'dictionary', 'smartReplaces'],
  },
  {
    id: 'shortcuts',
    title: 'Shortcuts',
    summary: 'How you drive it.',
    settings: [
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
    ],
  },
  {
    id: 'ai',
    title: 'AI',
    summary: 'What happens to the text after it is recognized.',
    // dictorRole (активная роль) правится селектором в панели, но живёт
    // в том же разделе, что и список ролей: это тоже «что происходит с
    // текстом после распознавания», и раздел — место, где её ищут глазами.
    // journalPath — тоже здесь: сеть журналу не нужна, но подпись раздела —
    // «что происходит с текстом после распознавания» — ровно про него, и
    // отдельный раздел из одного поля был бы хуже (ср. довод про Appearance).
    settings: ['ai', 'translateLanguages', 'dictorRoles', 'dictorRole', 'appRoles', 'journalPath'],
  },
  {
    id: 'appearance',
    title: 'Appearance',
    summary: 'How the windows look on screen.',
    settings: ['windowOpacity'],
  },
  {
    // Лицензия хранится не в settings.json (license.json + Paddle), поэтому
    // список settings пуст: раздел — интерфейс к license.rs, а не к полям
    // настроек. Последний в столбце: сюда заходят один раз.
    id: 'license',
    title: 'License',
    summary: 'Trial, license key and purchase.',
    settings: [],
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
