import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { EditorView } from '@codemirror/view'
import { Vim } from '@replit/codemirror-vim'
import {
  addHistoryEntry,
  updateHistoryEntry,
  checkAccessibilityPermission,
  copyText,
  appendJournal,
  followToMainWindow,
  getLastRecording,
  getSettings,
  hideOverlay,
  openPrivacyPane,
  openSettingsWindow,
  pasteText,
  retranscribe,
  runAiAction,
  setDictorRole,
  setTargetLanguage,
  setOverlayHasText,
  startRecording,
  stopRecording,
  type ForcedLanguage,
  type PrivacyPane,
  type Settings,
} from './api'
import {
  DEFAULT_COPY_SHORTCUT,
  DEFAULT_FOLLOW_SHORTCUT,
  DEFAULT_PASTE_SHORTCUT,
  formatShortcutBadge,
  matchesShortcut,
} from './shortcut'
import {
  appendTranscript,
  createTranscriptEditor,
  resetEditorContent,
  watchVimMode,
  type VimMode,
} from './transcript-editor'
import { resampleLevels } from './levels'
import {
  buildRoleSystemPrompt,
  findRole,
  roleForApp,
  type AppRole,
  type DictorRole,
} from './dictor-roles'
import { parseLanguageList } from './action-tree'
import { applySmartReplaces, type SmartReplace } from './smart-replace'
import { formatJournalEntry } from './journal'
import micIcon from './assets/mic.png'

type Phase = 'idle' | 'recording' | 'transcribing' | 'ready' | 'error'

// Cкудный API defineAction/mapCommand регистрируется ОДИН раз при загрузке
// модуля — Vim это синглтон на весь процесс (общий keymap на все инстансы
// редактора), а не что-то per-компонент; перерегистрация на каждый mount
// копила бы дубликаты в начале keymap. Сами колбэки не могут быть замкнуты
// на пропсы/состояние компонента на момент регистрации модуля, поэтому
// экшены читают их из этого объекта, который компонент держит свежим на
// каждый рендер (см. useEffect с vimActionTargets ниже) — тот же приём, что
// pasteShortcutRef/copyShortcutRef, только не React-ref, а модульный object,
// потому что его обязаны видеть функции, объявленные вне компонента.
const vimActionTargets = {
  onPaste: () => {},
  onClose: () => {},
}

// <CR> в normal режиме по умолчанию — это "j^" (вниз на строку): осмысленно
// для многострочного файла, бессмысленно для короткой надиктованной фразы.
// Переопределяем его на действие Paste. unshift кладёт наш маппинг ПЕРЕД
// дефолтным в keymap — команда находится первой при поиске совпадения (см.
// vim.js/_mapCommand), т.е. это полноценная замена, а не дополнение.
Vim.defineAction('slaivePaste', () => vimActionTargets.onPaste())
Vim.mapCommand('<CR>', 'action', 'slaivePaste', {}, { context: 'normal' })

// <Esc> в normal режиме по умолчанию ничего не делает (курсор уже в normal —
// vim.js буквально пишет "let it be handled normally" и ничего не находит).
// Свободный слот — занимаем его закрытием панели. Escape в insert режиме не
// затронут: тот уходит другим путём (handleEsc→exitInsertMode) ДО того, как
// keymap вообще консультируется, см. отчёт.
Vim.defineAction('slaiveClose', () => vimActionTargets.onClose())
Vim.mapCommand('<Esc>', 'action', 'slaiveClose', {}, { context: 'normal' })

// Ширина одного бара дорожки и зазор между ними — должны совпадать с
// `.overlay .level` (flex: 0 0 2px) и `.overlay .levels` (gap: 1px) в
// styles.css. Раньше здесь была фиксированная константа (200 баров),
// подобранная не от ширины контейнера, а "на глаз" — из-за этого дорожка
// либо вылезала за правый край панели (баров помещалось больше, чем
// хватало ширины), либо начинала сдвигаться слишком поздно (баров
// помещалось меньше, чем задавал жёсткий предел). Предел теперь считается
// от реальной ширины контейнера, поэтому оба симптома пропадают вместе.
const BAR_WIDTH_PX = 2
const BAR_GAP_PX = 1
const BAR_FOOTPRINT_PX = BAR_WIDTH_PX + BAR_GAP_PX

// Дорожка уровня — диагностика, а не украшение: при отказе в доступе к
// микрофону macOS отдаёт поток нулей вместо ошибки, и пользователь должен
// с одного взгляда отличать настоящую тишину от настоящей речи. Прежний
// ЖЁСТКИЙ множитель (v * 100 * 3) был откалиброван под одно устройство: речь
// этого пользователя пикует на 0.0385 (см. лог «пиковая амплитуда»), что
// давало на дорожке ~11%, а после зеркалирования — и вовсе ~5% на сторону,
// то есть не читалось вообще. Чувствительность микрофонов различается на
// порядок, поэтому нужна нормализация от сигнала текущей записи, а не
// константа, подогнанная под одно железо.
//
// REF_MIN — пол делителя нормализации. Без него в записи, где нет ничего,
// кроме шума (например при отказе в доступе — на деле чистые нули, но в
// общем случае это может быть гул тракта), самый громкий ШУМ становится
// эталоном и растягивается на всю дорожку — тишина и сигнал становятся
// неотличимы, а это и есть инвариант, который дорожка обязана сохранять.
// Делитель никогда не опускается ниже REF_MIN — тихий вход НЕ МОЖЕТ быть
// растянут вверх, структурно, а не по соглашению. Не убирать пол ради
// «упрощения»: без него ломается единственная причина существования дорожки.
// Подобрано так, чтобы пик речи этого пользователя (0.0385) читался примерно
// как половина дорожки, а шум микрофона (~0.001) оставался тонкой полоской
// у оси — численную проверку см. в отчёте по фиче.
const REF_MIN = 0.15

// Множитель затухания скользящего максимума на один кадр `rec:level` (кадр —
// раз в 50 мс, см. LEVEL_EMIT_INTERVAL на бэкенде). Растёт мгновенно —
// Math.max(v, ...) — угасает медленно: за ~2 секунды паузы между словами
// (≈40 кадров) максимум оседает лишь до 0.995^40 ≈ 82% пикового значения,
// так что дорожка не «проседает» в паузах и следующее слово не подскакивает
// к максимальной высоте на пустом месте.
const RUNNING_MAX_DECAY = 0.995

// Ширина окна оверлея — фиксирована (часть 2 брифа: меняется только
// высота), совпадает с width в tauri.conf.json. Второй источник правды —
// та же цена, что и у BAR_WIDTH_PX/BAR_GAP_PX выше: рассинхронизация не
// ломает панель (просто станет чуть уже/шире окна), но держим числа
// равными явно, а не полагаемся на совпадение.
const OVERLAY_WIDTH_PX = 440

// Пол и потолок высоты окна — см. отчёт за арифметику компактного (~252px)
// и полного (~504px) состояний. Сама высота считается измерением DOM (см.
// эффект ResizeObserver ниже), эти два числа — только защитная граница:
// пол не даёт окну схлопнуться до пары пикселей на случайном промежуточном
// кадре измерения (напр. до применения шрифта), потолок — жёсткая крыша
// на случай контента длиннее, чем предполагает max-height транскрипта.
const OVERLAY_MIN_HEIGHT_PX = 240
// ponytail: фиксированный потолок, а не запрос реальной высоты экрана через
// Tauri monitor API (currentMonitor/availableMonitors) — 640px комфортно
// помещается на любом реальном маке. Усложнять до экранно-зависимого
// предела, если панель когда-нибудь должна будет расти ближе к границе
// экрана, чем сейчас, или понадобится корректная работа на нестандартно
// маленьких внешних мониторах.
const OVERLAY_MAX_HEIGHT_PX = 640

const LABEL: Record<Phase, string> = {
  idle: 'Hold the hotkey and speak',
  recording: 'Recording…',
  transcribing: 'Transcribing…',
  ready: 'Done — Paste sends the text back to where you were',
  error: 'Error',
}

type AccessibilityErrorPayload = { message: string; pane: PrivacyPane }
// Режим записи приезжает с бэкенда обоими событиями — и стартом, и готовой
// расшифровкой (см. RecStartPayload/TranscriptPayload в commands.rs): панели
// не приходится помнить режим между ними.
type RecStartPayload = { append: boolean }
// durationSecs — длительность записи в секундах, единственное, что панель
// пересылает дальше в журнал расшифровок (см. addHistoryEntry ниже). При
// дозаписи это длительность ВСЕГО накопленного звука, а не последнего
// фрагмента.
// language — имя языка этого прохода, или null, когда показывать нечего (язык
// приколот в настройках, см. language_report в whisper.rs).
type TranscriptPayload = {
  text: string
  append: boolean
  durationSecs: number
  language: string | null
}
// icon — уже готовый data: URL или null (нет иконки/не удалось сконвертировать).
type SourceAppPayload = { name: string; icon: string | null }

// Что предлагает принудительный выбор языка. whisper знает около сотни
// языков, но список из сотни в этой панели нечитаем, а главное — не нужен:
// Recognition settings УЖЕ решили, какие языки у этого пользователя бывают
// ('auto' | 'ru' | 'en', см. Settings.tsx), и второй, более широкий список
// здесь был бы вторым источником правды о том же. Подписи повторяют подписи
// настроек, кроме первой: там это предпочтение («Detect automatically»),
// здесь — разовое действие над уже записанным звуком.
const FORCED_LANGUAGES: { value: ForcedLanguage; label: string }[] = [
  { value: 'auto', label: 'Detect again' },
  { value: 'ru', label: 'Russian' },
  { value: 'en', label: 'English' },
]

// Хоткей, раскрывающий селектор «Redo as» с клавиатуры: дальше стрелки ходят
// по языкам, Enter запускает повторную расшифровку, Escape закрывает без неё
// — всё это штатное поведение ОТКРЫТОГО нативного списка, панели здесь
// делать нечего. Захардкожен, как Cmd+1..9 у подменю главного окна, а не
// хранится в настройках: это навигация по уже видимому элементу, а не
// действие. Cmd+R безопасен по той же причине, что Cmd+C у Copy: в
// грамматике Vim модификатора Cmd не бывает, у редактора ничего не отбирается.
const REDO_AS_SHORTCUT = 'Super+KeyR'

// То же самое для селектора роли диктора: Cmd+D (Dictor) раскрывает список,
// дальше стрелки/Enter/Escape — штатное поведение открытого нативного
// списка. Захардкожен по тем же причинам, что REDO_AS_SHORTCUT выше. D —
// потому что R занят «Redo as», а в этом окне Cmd+D больше ничем не занят.
const ROLE_SHORTCUT = 'Super+KeyD'

// Хоткей кнопки Journal. Захардкожен в отличие от Paste/Copy/Follow:
// пока фича молодая, настройка хоткея — преждевременная роскошь, а Cmd+J
// в этом окне ничем не занят (в грамматике Vim модификатора Cmd нет).
// ponytail: вынести в настройки рядом с followShortcut, когда попросят.
const JOURNAL_SHORTCUT = 'Super+KeyJ'

// Подпись строки с Undo — та же роль и тот же приём, что у HISTORY_NOTICE/
// NEW_TEXT_NOTICE в главном окне (см. MainWindow.tsx): замена задумана, но
// «задумано» не оправдывает молчаливую потерю правок, которые человек внёс
// руками. Объясняем ровно одно — откуда взялся текст, который теперь в поле.
const RETRANSCRIBE_NOTICE = 'Re-transcribed. The text that was here has been replaced.'

// Та же плашка для второй причины замены — ИИ-правки под роль диктора. Undo
// возвращает сырой whisper-текст: правки руками за время запроса сюда попасть
// не могут, при изменившемся документе правка не применяется вовсе (см.
// проверку «документ не менялся» в refine).
const ROLE_EDIT_NOTICE = 'Polished by the dictor role. The raw transcript has been replaced.'
// Перевод мог идти и с ролью, и без неё; салиентная перемена — язык, поэтому
// одна подпись на оба случая (см. refine ниже).
const TRANSLATE_NOTICE = 'Translated by the AI. The original text has been replaced.'

export function Overlay() {
  const [phase, setPhase] = useState<Phase>('idle')
  // Само содержимое транскрипта больше не React state — редактор (CodeMirror)
  // уже владеет им как единственным источником истины (несёт свой doc и
  // курсор, controlled-value через React только мешал бы Vim-режимам).
  // hasText — узкий кусочек этого состояния, нужный ТОЛЬКО чтобы включать/
  // выключать кнопки Paste/Copy, держится в синхроне через updateListener
  // редактора (см. эффект создания EditorView ниже).
  const [hasText, setHasText] = useState(false)
  // Бэкенду нужно то же самое булево, и только оно: вместе с видимостью окна
  // это и есть правило дозаписи (панель открыта и в ней есть текст —
  // дописываем; см. is_append_session в commands.rs). Решение принимается
  // там, а не здесь, потому что оно должно быть ОДНО на текст, звук и
  // дорожку. Отправляем на переключении признака, а не на каждое нажатие
  // клавиши: hasText меняется только когда поле становится пустым или
  // перестаёт быть пустым.
  useEffect(() => {
    setOverlayHasText(hasText).catch(() => {
      // Панель не должна падать из-за не доехавшего служебного флага: худшее
      // следствие — следующая запись начнётся с чистого листа вместо
      // дозаписи, а не потеря текста.
    })
  }, [hasText])
  // Текущий Vim-режим — только для бейджа NORMAL/INSERT рядом со статусом;
  // решения "что делает Enter/Escape" принимает сам vim через
  // Vim.mapCommand(..., {context: 'normal'}) выше, а не эта переменная —
  // синхронно читать её в обработчике клавиш было бы гонкой (см. отчёт).
  const [vimMode, setVimMode] = useState<VimMode>('normal')
  const [error, setError] = useState('')
  // Сохранённое устройство записи не нашлось, пишем с умолчания. Отдельно от
  // `error`: запись идёт нормально, и фаза ошибки тут была бы враньём — но
  // молча подменять микрофон нельзя, человек будет думать, что диктует в
  // iPhone. Держится до следующей записи, а не гаснет по таймеру.
  const [deviceNotice, setDeviceNotice] = useState('')
  // Потолок накопленного звука выбран (см. audio::MAX_SESSION_SAMPLES): запись
  // остановлена на десятой минуте или дозапись вообще не началась. Тоже
  // уведомление, а не ошибка — текст на месте, расшифровка идёт своим чередом,
  // и фаза ошибки тут врала бы. Держится до начала СЛЕДУЮЩЕЙ сессии: пока
  // сессия та же, причина никуда не делась, и гасить её было бы возвращением к
  // молчаливому потолку.
  const [limitNotice, setLimitNotice] = useState('')
  // Запись журнала, в которую растёт эта сессия. Одна сессия — одна плитка:
  // без этого диктовка с двумя дозаписями оставляла три почти одинаковые
  // записи, каждая префикс следующей.
  //
  // Хранится ПРОМИС последней записи в журнал, а не голый id: следующая
  // расшифровка пристраивается к нему через .then, поэтому она не может
  // увидеть ещё не проставленный id и завести вторую плитку. `null` внутри —
  // «записи пока нет» (сессия только началась или прошлая запись сорвалась).
  // Ref, а не state: значение нужно только внутри обработчика и не рисуется.
  const historyWriteRef = useRef<Promise<number | null>>(Promise.resolve(null))
  // Язык этой расшифровки: имя для показа и признак «назначен принудительно,
  // а не определён». null — показывать нечего: язык приколот в настройках
  // (whisper его не определял, ему его назвали — см. language_report в
  // whisper.rs) или расшифровки ещё не было.
  const [language, setLanguage] = useState<{ name: string; forced: boolean } | null>(null)
  // Идёт повторная расшифровка. Второй отказывает сам бэкенд (занятая
  // блокировка транскрибера, см. retranscribe), но ждать круга до отказа,
  // чтобы выключить селектор, незачем — он выключается сразу.
  const [retranscribing, setRetranscribing] = useState(false)
  // Что лежало в редакторе ДО повторной расшифровки — ровно тот же приём и та
  // же гарантия, что у `replaced` в главном окне (см. MainWindow.tsx):
  // замена происходит сразу, а рядом остаётся строка с кнопкой Undo, которая
  // кладёт прежний текст обратно побайтово. Спрашивать подтверждение ПЕРЕД
  // заменой нельзя: человек нажал «Redo as», замена и есть то, что он
  // попросил, и диалог поверх неё был бы вопросом «ты уверен?» на явное
  // действие. Но в Vim-режиме правка надиктованного руками — основной
  // сценарий, и терять её молча недопустимо.
  //
  // Не полагаемся на undo самого редактора (vim `u`): про него надо знать, он
  // требует normal-режима и фокуса в поле. Собственный снимок работает по
  // построению.
  const [replaced, setReplaced] = useState<string | null>(null)
  // Повторная расшифровка не удалась. ОТДЕЛЬНО от `error`/phase: текст в поле
  // цел, Paste и Copy работают, и фаза ошибки тут соврала бы — а главное,
  // увела бы селектор с экрана вместе со строкой языка, и повторить попытку
  // стало бы нечем. Потеря транскрипта из-за неудачной повторной попытки
  // хуже, чем неверный язык.
  const [retranscribeError, setRetranscribeError] = useState('')
  // Чем объяснять плашку Undo: повторной расшифровкой или ИИ-правкой под
  // роль. Отдельное состояние рядом с `replaced`, а не второй механизм Undo:
  // снимок один и тот же, различается только подпись.
  const [replacedNotice, setReplacedNotice] = useState(RETRANSCRIBE_NOTICE)
  // Роли диктора и активная роль — из настроек; те же два пути обновления,
  // что у хоткеев панели (getSettings на mount + settings:changed).
  const [roles, setRoles] = useState<DictorRole[]>([])
  const [activeRoleId, setActiveRoleId] = useState<string | null>(null)
  // Идёт ИИ-правка под роль. Не фаза: текст уже на экране и работает
  // (Paste/Copy живые), правка — улучшение поверх, как у retranscribing.
  const [refining, setRefining] = useState(false)
  // ИИ-правка не удалась. Отдельно от error/phase по той же причине, что
  // retranscribeError: сырой текст цел, и фаза ошибки тут соврала бы.
  const [refineError, setRefineError] = useState('')
  // Снимки для обработчика transcript, навешенного один раз на mount — тот
  // же приём, что pasteShortcutRef/copyShortcutRef ниже.
  const rolesRef = useRef<DictorRole[]>([])
  const activeRoleIdRef = useRef<string | null>(null)
  // Язык автоперевода — постоянное предпочтение, как роль: state для селектора,
  // ref для обработчика transcript, навешенного один раз на mount. Список
  // доступных языков берётся из translate_languages (тот же, что у Translate в
  // главном окне) — хранится отдельным state ради селектора.
  const [targetLanguage, setTargetLanguageState] = useState('')
  const targetLanguageRef = useRef('')
  const [translateLanguages, setTranslateLanguages] = useState<string[]>([])
  // Язык последней расшифровки — для правила «переводить, только если он
  // отличается от целевого». Ref, а не state: обработчик transcript навешен
  // раз на mount и читает его свежим; обновляется везде, где меняется
  // `language` (расшифровка, повтор, сброс на rec:start).
  const detectedLangRef = useRef<string | null>(null)
  // Пары Smart Replace — только ref, без state: списком панель ничего не
  // рендерит, он нужен лишь обработчикам transcript/retranscribe.
  const smartReplacesRef = useRef<SmartReplace[]>([])
  // Словарь терминов — в промпт ИИ-правки (см. buildRoleSystemPrompt):
  // тоже только ref, панель его не показывает.
  const dictionaryRef = useRef('')
  // Авто-роль по приложению: привязки из настроек, имя исходного
  // приложения (зеркало sourceApp — state читать из once-mounted
  // обработчика transcript нельзя) и ПОСТОЯННЫЙ выбор роли из настроек.
  // Последний нужен отдельно от activeRoleIdRef: тот на время записи
  // поверх привязанного приложения подменяется авто-ролью, и следующей
  // записи без привязки надо откуда-то вернуть выбор пользователя.
  const appRolesRef = useRef<AppRole[]>([])
  const sourceAppNameRef = useRef<string | null>(null)
  const savedRoleIdRef = useRef<string | null>(null)
  // Длительность последней расшифровки — нужна ИИ-правке, чтобы обновить ту
  // же плитку журнала (updateHistoryEntry требует duration, а правка
  // случается позже события, которое её принесло).
  const lastDurationRef = useRef(0)
  const [permissionPane, setPermissionPane] = useState<PrivacyPane | null>(null)
  // Модальный слой "нет права на вставку" — показывается СРАЗУ по нажатию
  // Paste, если право уже отсутствует (см. onPaste), а не после круга
  // скрытия/показа панели и фиксированной паузы, которым заканчивается
  // настоящая попытка вставки без права. Отдельно от permissionPane/error:
  // тот путь остаётся как есть для случая, когда право отозвали МЕЖДУ этой
  // проверкой и реальной попыткой (см. paste_text), и для отказа Automation
  // (у него своя причина и не связан с Paste вовсе).
  const [showAccessModal, setShowAccessModal] = useState(false)
  const [copied, setCopied] = useState(false)
  // Путь к журналу — state, а не ref: от него зависит, рендерится ли
  // кнопка Journal вовсе. `journaled` — та же вспышка, что `copied`.
  const [journalPath, setJournalPath] = useState('')
  const [journaled, setJournaled] = useState(false)
  const [levels, setLevels] = useState<number[]>([])
  const [hasRecording, setHasRecording] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [sourceApp, setSourceApp] = useState<SourceAppPayload | null>(null)
  // Длительность последней записи в секундах — 0, пока не загружена (ещё не
  // фетчили PCM для этой записи). Нужна плееру, чтобы переводить долю
  // ширины дорожки (клик/перетаскивание) и долю прошедшего времени (голова
  // воспроизведения) в реальные секунды.
  const [duration, setDuration] = useState(0)
  // Позиция головки воспроизведения как доля ширины дорожки (0..1) — null,
  // когда проигрывание не идёт: часть 1 требует, чтобы линия исчезала и не
  // возникала до начала проигрывания. Единственный элемент дорожки, который
  // зависит от данных (позиции), а не от уровня сигнала, — см. ограничение
  // части 3 и комментарий у JSX дорожки ниже.
  const [playheadPct, setPlayheadPct] = useState<number | null>(null)

  // Хоткеи Paste/Copy — окно-локальные (см. shortcut.ts), не глобальные:
  // регистрируются здесь обычным keydown, а не через tauri-plugin-global-shortcut.
  // Состояние — чтобы бейдж на кнопке перерисовался при смене настройки;
  // окно overlay не пересоздаётся между записями (скрывается/показывается),
  // поэтому значения грузятся один раз на mount и дальше обновляются по
  // событию settings:changed, а не только при повторном монтировании.
  const [pasteShortcut, setPasteShortcut] = useState(DEFAULT_PASTE_SHORTCUT)
  const [copyShortcut, setCopyShortcut] = useState(DEFAULT_COPY_SHORTCUT)
  // Follow — третий хоткей панели, живёт по тем же правилам; отличается
  // только тем, КАК ловится (фаза перехвата, см. отдельный эффект ниже).
  const [followShortcut, setFollowShortcut] = useState(DEFAULT_FOLLOW_SHORTCUT)

  // Глобальный keydown-обработчик вешается один раз на mount (см. ниже),
  // поэтому ему нужен всегда актуальный снимок хоткеев через ref, а не
  // значение, захваченное в замыкании на момент навешивания.
  const pasteShortcutRef = useRef(pasteShortcut)
  const copyShortcutRef = useRef(copyShortcut)
  useEffect(() => {
    pasteShortcutRef.current = pasteShortcut
  }, [pasteShortcut])
  useEffect(() => {
    copyShortcutRef.current = copyShortcut
  }, [copyShortcut])

  useEffect(() => {
    const apply = (s: Settings) => {
      setPasteShortcut(s.pasteShortcut)
      setCopyShortcut(s.copyShortcut)
      setFollowShortcut(s.followShortcut)
      setRoles(s.dictorRoles)
      rolesRef.current = s.dictorRoles
      setActiveRoleId(s.dictorRole)
      activeRoleIdRef.current = s.dictorRole
      savedRoleIdRef.current = s.dictorRole
      setTargetLanguageState(s.targetLanguage)
      targetLanguageRef.current = s.targetLanguage
      setTranslateLanguages(parseLanguageList(s.translateLanguages))
      appRolesRef.current = s.appRoles
      smartReplacesRef.current = s.smartReplaces
      dictionaryRef.current = s.dictionary
      setJournalPath(s.journalPath.trim())
    }
    getSettings().then(apply)
    const un = listen<Settings>('settings:changed', (e) => apply(e.payload))
    return () => {
      un.then((f) => f())
    }
  }, [])

  // ИИ-правка транскрипта под активную роль диктора: whisper уже отработал,
  // текст на экране — поверх него один запрос к провайдеру (тот же
  // run_ai_action, что у действий главного окна), и результат заменяет сырой
  // текст с Undo-плашкой. Роли нет — ни одного сетевого вызова, функция
  // выходит сразу: правка строго opt-in.
  //
  // Сырой текст показывается СРАЗУ, а не держится до ответа провайдера:
  // правка — секунды сети поверх уже готового результата, и прятать готовый
  // текст за спиннером значило бы сделать каждую диктовку медленнее на эти
  // секунды даже там, где правка ничего не изменит.
  //
  // Читает роли через ref-ы: вызывается и из обработчика transcript,
  // навешенного один раз на mount. roleOverride — для смены роли селектором
  // на уже готовом тексте, когда ref мог ещё не обновиться.
  const refine = (roleOverride?: DictorRole | null, langOverride?: string) => {
    // roleOverride/langOverride переданы явно (смена селектора, авто-роль) —
    // берём их; не переданы (undefined) — читаем ref. null у роли — это
    // осознанное «без роли» (перевод-только), не «читай ref».
    const role =
      roleOverride !== undefined ? roleOverride : findRole(rolesRef.current, activeRoleIdRef.current)
    const lang = (langOverride !== undefined ? langOverride : targetLanguageRef.current).trim()
    // Переводим, только если целевой язык отличается от языка расшифровки:
    // текст уже на нужном языке переводить незачем. Названия сравниваем без
    // регистра; не совпали (whisper отдал код вместо имени) — переводим, это
    // безопасный дефолт. Роль при совпадении языков всё равно отрабатывает.
    const source = detectedLangRef.current
    const effLang = lang && source && lang.toLowerCase() === source.toLowerCase() ? '' : lang
    // Ни роли, ни (нужного) перевода — улучшать нечем, ни одного сетевого вызова.
    if (!role && !effLang) return
    const view = viewRef.current
    if (!view) return
    const raw = view.state.doc.toString()
    if (!raw.trim()) return
    setRefining(true)
    setRefineError('')
    runAiAction(buildRoleSystemPrompt(role, dictionaryRef.current, effLang), raw)
      .then((fixed) => {
        const v = viewRef.current
        // Пока ждали ответ, документ сменился — новая запись, правка руками,
        // другая правка. Класть поверх него устаревший результат нельзя:
        // проверка по содержимому, а не по фазе, закрывает все пути сразу.
        if (!v || v.state.doc.toString() !== raw) return
        if (fixed === raw) return // модель ничего не поменяла — и плашка Undo соврала бы
        resetEditorContent(v, fixed)
        setReplaced(raw)
        setReplacedNotice(effLang ? TRANSLATE_NOTICE : ROLE_EDIT_NOTICE)
        v.focus()
        // Журнал: плитка сессии держит правленый текст — иначе починка
        // терминов жила бы только до закрытия панели (тот же довод, что у
        // повторной расшифровки).
        historyWriteRef.current = historyWriteRef.current
          .then((entryId) =>
            entryId !== null
              ? updateHistoryEntry(entryId, fixed, lastDurationRef.current)
              : addHistoryEntry(fixed, lastDurationRef.current)
          )
          .catch((err) => {
            console.error('история: ИИ-правка не сохранена:', String(err))
            return null
          })
      })
      .catch((e) => {
        // Текст в поле не тронут: его заменяет только ветка успеха выше.
        setRefineError(String(e))
      })
      .finally(() => setRefining(false))
  }

  // Смена активной роли — постоянное предпочтение (в отличие от разового
  // «Redo as» у языка), уходит на диск узкой командой. Выбор применяется к
  // уже готовому тексту сразу: человек смотрит на расшифровку с перевранными
  // терминами и выбирает роль именно ради неё, ждать следующей записи — не то.
  const onRoleChange = (id: string) => {
    const roleId = id || null
    const prev = activeRoleIdRef.current
    setActiveRoleId(roleId)
    activeRoleIdRef.current = roleId
    setDictorRole(roleId).catch((e) => {
      // Бэкенд отказал (роль только что удалили в настройках) — откат к
      // прежнему значению, не молчаливое расхождение селектора с диском.
      setActiveRoleId(prev)
      activeRoleIdRef.current = prev
      setRefineError(String(e))
    })
    if (roleId && phase === 'ready' && !refining) {
      const role = findRole(rolesRef.current, roleId)
      if (role) refine(role)
    }
  }

  // Смена языка автоперевода — постоянное предпочтение, как роль: узкой
  // командой на диск и сразу применяется к уже готовому тексту (выбрал язык,
  // глядя на русскую расшифровку — хочешь её по-английски сейчас, не со
  // следующей записи). Пустое значение выключает перевод и ничего не
  // пересчитывает: обратно текст всё равно не вернуть, а сырой уже заменён.
  const onTargetLanguageChange = (lang: string) => {
    const prev = targetLanguageRef.current
    setTargetLanguageState(lang)
    targetLanguageRef.current = lang
    setTargetLanguage(lang).catch((e) => {
      setTargetLanguageState(prev)
      targetLanguageRef.current = prev
      setRefineError(String(e))
    })
    if (lang && phase === 'ready' && !refining) refine(undefined, lang)
  }

  // Скользящий максимум текущей записи — держит только высоту дорожки, не
  // должен сам по себе вызывать ре-рендер (это делает `levels`). Живёт
  // отдельно от React-состояния и обнуляется на rec:start: иначе один
  // громкий выкрик в начале приглушил бы дорожку во всех следующих записях.
  const runningMaxRef = useRef(REF_MIN)

  // Контейнер и сам инстанс редактора. CodeMirror не React-компонент — он
  // владеет своим DOM императивно, поэтому создаётся один раз на mount (ниже)
  // и живёт в ref, а не в состоянии. Создание, сброс содержимого и подписка
  // на смену Vim-режима — общий путь с главным окном, см. transcript-editor.ts.
  const editorContainerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  // Селекторы «Redo as» и роли — чтобы Cmd+R/Cmd+D могли раскрыть их из
  // глобального обработчика клавиш. Ref, а не состояние: элементы нужны
  // только там.
  const langForceRef = useRef<HTMLSelectElement>(null)
  const roleSelectRef = useRef<HTMLSelectElement>(null)

  // Корень панели — источник измерения для авто-высоты окна (часть 2, см.
  // эффект ResizeObserver ниже).
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const parent = editorContainerRef.current
    if (!parent) return

    const view = createTranscriptEditor(parent, {
      onDocChanged: setHasText,
      placeholderText: '—',
    })
    viewRef.current = view
    const unwatch = watchVimMode(view, setVimMode)

    return () => {
      unwatch()
      view.destroy()
      viewRef.current = null
    }
  }, [])

  // Сколько баров помещается по ширине контейнера прямо сейчас — то есть
  // «вся ширина дорожки» в единицах баров. Состояние, а не ref: от него
  // зависит то, что рисуется (см. displayLevels ниже), а меняется оно редко
  // — только при изменении ширины панели. Дефолт 1 — заглушка на время до
  // первого измерения (эффект ниже считает его синхронно на mount, до
  // первого кадра rec:level).
  const [barCap, setBarCap] = useState(1)
  const levelsContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = levelsContainerRef.current
    if (!el) return
    // N баров занимают N*BAR_WIDTH + (N-1)*BAR_GAP пикселей — последний зазор
    // не рисуется, поэтому в числителе +BAR_GAP_PX. Раньше его не было, и
    // дорожка недобирала до правого края пару пикселей; с тех пор как по этой
    // же ширине считается положение головки воспроизведения, такой недобор
    // стал бы систематическим сдвигом рисунка относительно позиции в звуке.
    const recalcCap = () =>
      setBarCap(Math.max(1, Math.floor((el.clientWidth + BAR_GAP_PX) / BAR_FOOTPRINT_PX)))
    recalcCap()
    const ro = new ResizeObserver(recalcCap)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Два масштаба дорожки, и это ровно тот баг, из-за которого рисунок
  // занимал левую треть, а головка ходила по всей ширине:
  //
  //  - ПОКА ЗАПИСЬ ИДЁТ итоговая длительность неизвестна, поэтому бары
  //    набегают слева направо по одному на кадр (50 мс), а лишнее слева
  //    уезжает за предел ширины — как и было;
  //  - КАК ТОЛЬКО ЗАПИСЬ ОСТАНОВЛЕНА дорожка перестаёт быть живым
  //    индикатором и становится статичной формой волны ВСЕЙ накопленной
  //    записи: замеры раскладываются ровно на `barCap` баров. Головка
  //    воспроизведения и перемотка считают позицию как долю длительности от
  //    полной ширины — теперь рисунок в том же масштабе, и они совпадают.
  //
  // При дозаписи `levels` не очищается (см. обработчик rec:start), поэтому
  // после добавления фрагмента раскладывается вся накопленная запись целиком
  // — тот же единый масштаб, что и у накопленного PCM в `Play`.
  //
  // Честность дорожки сохраняется: resampleLevels перераспределяет уже
  // измеренные значения (повтор при растяжении, максимум по окну при
  // сжатии), не интерполирует и не подмешивает минимальную высоту — ноль
  // остаётся нулём при любом масштабе, см. комментарий в levels.ts.
  const displayLevels = useMemo(
    () => (phase === 'recording' ? levels.slice(-barCap) : resampleLevels(levels, barCap)),
    [levels, barCap, phase]
  )

  // Часть 2: окно ОС подгоняется под фактическую высоту контента, а не
  // наоборот. rootRef — корневой div .overlay, у которого больше нет
  // height: 100vh (см. styles.css) — его высота теперь intrinsic, то есть
  // равна сумме высот детей flex-колонки (шапка источника, строка статуса,
  // дорожка уровня, поле транскрипта, ряд действий), каждый из которых то
  // появляется/исчезает, то меняет высоту сам (длинный транскрипт, перенос
  // строки ошибки). ResizeObserver на этом элементе видит ровно эти
  // изменения контента.
  //
  // Петля обратной связи (resize → measure → resize → ...), о которой
  // предупреждает бриф, здесь структурно разорвана: setSize ниже меняет
  // ТОЛЬКО размер нативного окна/webview, а intrinsic-высота .overlay
  // зависит только от контента — от высоты окна она не зависит вообще
  // (раньше зависела, когда .overlay сам был height: 100vh, и это была бы
  // прямая петля: измерили высоту окна → выставили её же → измерили снова).
  // Второй, защитный барьер — lastAppliedHeightRef: даже если что-то извне
  // всё же вызовет лишнее срабатывание ResizeObserver с тем же числом,
  // повторный setSize с уже применённым значением не уйдёт.
  const lastAppliedHeightRef = useRef(-1)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const win = getCurrentWindow()
    let rafId: number | null = null
    const applyHeight = () => {
      rafId = null
      const measured = Math.ceil(el.getBoundingClientRect().height)
      const clamped = Math.min(OVERLAY_MAX_HEIGHT_PX, Math.max(OVERLAY_MIN_HEIGHT_PX, measured))
      if (clamped === lastAppliedHeightRef.current) return
      lastAppliedHeightRef.current = clamped
      win.setSize(new LogicalSize(OVERLAY_WIDTH_PX, clamped)).catch(() => {
        // Окно могло исчезнуть/пересоздаться в неудачный момент — не
        // фатально, следующее срабатывание ResizeObserver попробует снова.
      })
    }
    // rAF коалесцирует несколько срабатываний ResizeObserver за один кадр
    // (React может обновить несколько кусков state за один рендер, каждый
    // из которых меняет высоту контента) в один вызов setSize — тот же
    // приём, что scheduleSeek у плеера ниже, и по той же причине: не
    // дёргать нативное окно чаще, чем реально нужно.
    const ro = new ResizeObserver(() => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(applyHeight)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [])

  useEffect(() => {
    const subs = [
      listen<RecStartPayload>('rec:start', (e) => {
        // Дозапись или новая запись — решает бэкенд (см. is_append_session в
        // commands.rs), панель только исполняет: одно решение на текст, звук
        // и дорожку, иначе они разъедутся.
        const append = e.payload?.append === true
        setPhase('recording')
        setError('')
        // Сообщение прошлой записи не должно висеть над новой: бэкенд пришлёт
        // его снова, если устройства всё ещё нет (событие идёт следом за
        // `rec:start`, см. begin_recording).
        setDeviceNotice('')
        setPermissionPane(null)
        // Язык — свойство РАСШИФРОВКИ, а не сессии: новая запись принесёт
        // свой, и ярлык от прошлой висеть над ней не должен. Это же и делает
        // принудительный выбор разовым по построению, а не по договорённости:
        // следующая запись снова идёт по настройке, а ярлык «Forced» гаснет.
        setLanguage(null)
        detectedLangRef.current = null
        // Снимок для Undo относится к документу, которого больше нет (при
        // новой записи поле очищается, при дозаписи — меняется), поэтому
        // предложение вернуть его теряет смысл вместе с началом записи.
        setReplaced(null)
        setRetranscribeError('')
        setRefineError('')
        // PCM всегда перечитываем заново: при дозаписи бэкенд склеил новый
        // фрагмент с прежним, и закэшированная тут копия устарела ровно так
        // же, как при обычной записи.
        pcmRef.current = null
        setDuration(0)
        if (!append) {
          // Новая сессия — новая запись журнала и чистый счёт по потолку.
          historyWriteRef.current = Promise.resolve(null)
          setLimitNotice('')
          setLevels([])
          runningMaxRef.current = REF_MIN
          // Шапка приходит отдельным событием с фонового потока чуть позже —
          // старое приложение не должно провисеть над новой записью до тех пор.
          setSourceApp(null)
          sourceAppNameRef.current = null
          // Очищаем редактор и возвращаем его в normal — то же самое "новый
          // цикл — чистый лист", что раньше делал один setText(''). Панель НЕ
          // забирает фокус здесь (запись только начинается, исходное приложение
          // должно остаться активным — см. focus-report.md), поэтому режим
          // сбрасывается тихо, без view.focus().
          const view = viewRef.current
          if (view) resetEditorContent(view, '')
        }
        // При дозаписи НЕ трогаем ни текст, ни дорожку, ни шапку источника:
        // текст остаётся на экране, чтобы человек видел, к чему дописывает
        // (диктуя продолжение, естественно смотреть на уже сказанное), новые
        // столбики продолжают старые, а приложение-источник у накопленного
        // текста то же самое — то, где нажали хоткей в первый раз.
      }),
      listen('rec:stop', () => {
        setPhase('transcribing')
        // Стоп означает, что запись — пусть даже пустая — уже лежит в
        // состоянии на бэкенде и доступна через get_last_recording.
        setHasRecording(true)
      }),
      listen<number>('rec:level', (e) => {
        const v = e.payload
        // Растёт мгновенно до текущего пика, угасает медленно — см.
        // комментарий у RUNNING_MAX_DECAY.
        runningMaxRef.current = Math.max(v, runningMaxRef.current * RUNNING_MAX_DECAY)
        // Пол REF_MIN — структурная гарантия инварианта: делитель не может
        // провалиться в шум, поэтому v = 0 (и вообще любая тишина) не может
        // быть растянута до заметной высоты.
        const ref = Math.max(REF_MIN, runningMaxRef.current)
        const height = Math.min(100, Math.sqrt(v / ref) * 100)
        // Копим ВСЕ замеры записи, а не только те, что влезли по ширине:
        // после остановки из них раскладывается форма волны всей записи (см.
        // displayLevels). 20 замеров в секунду — десять минут непрерывной
        // диктовки это 12 тысяч чисел, для памяти это ничто.
        setLevels((prev) => [...prev, height])
      }),
      listen<SourceAppPayload>('app:source', (e) => {
        setSourceApp(e.payload)
        sourceAppNameRef.current = e.payload?.name ?? null
      }),
      listen<TranscriptPayload>('transcript', (e) => {
        const view = viewRef.current
        // Smart Replace — до показа и до ИИ-правки: пользователь сразу видит
        // итоговый текст, а роль правит уже подставленные ссылки и имена, а
        // не произнесённые фразы-заготовки (см. smart-replace.ts).
        const text = applySmartReplaces(e.payload.text, smartReplacesRef.current)
        if (view) {
          // Дозапись идёт ЧЕРЕЗ ДОКУМЕНТ РЕДАКТОРА, в позицию курсора (или
          // вместо выделения) — appendTranscript трогает только диапазон
          // [from, to) текущего selection, остальной документ не задет
          // (см. её комментарий). Пользователь мог править текст руками,
          // включая перемещение курсора, пока диктовал продолжение
          // (в Vim-режиме это основной сценарий), и эти правки — в том
          // числе то, ГДЕ стоит курсор, — обязаны пережить добавку.
          if (e.payload.append) appendTranscript(view, text)
          else resetEditorContent(view, text)
          // В журнал уходит ИТОГОВЫЙ текст — то, что лежит в документе ПОСЛЕ
          // применения расшифровки. При дозаписи бэкенд итогового текста не
          // знает (он прислал только новый фрагмент), поэтому читаем его
          // здесь, из единственного места, где он существует целиком.
          //
          // Ошибку записи в журнал НЕ показываем в панели и не роняем ею
          // фазу: расшифровка удалась, текст на экране, вставка и копирование
          // работают. Сорвавшаяся запись в историю — потеря будущего удобства,
          // а не текущей работы, и превращать её в красную строку поверх
          // готового текста значило бы соврать о том, что случилось.
          // В консоль уходит только причина от бэкенда, без текста.
          //
          // ОДНА СЕССИЯ — ОДНА ЗАПИСЬ. Первая расшифровка сессии заводит
          // запись, дозаписи растят ЕЁ ЖЕ (см. updateHistoryEntry): иначе
          // диктовка с двумя добавками оставляла три плитки, каждая префикс
          // следующей, и полезна была только последняя. Идентификатор живёт
          // здесь, потому что здесь же живёт и сам итоговый текст.
          //
          // Пишем на КАЖДОЙ расшифровке, а не один раз в конце сессии: конца
          // у неё нет ни в каком надёжном смысле (панель могут закрыть,
          // приложение — снять), и отложенная запись теряла бы текст целиком
          // при падении посреди диктовки. Цена — журнал перестаёт быть
          // строго дозаписываемым файлом (см. history::update в Rust).
          const full = view.state.doc.toString()
          if (full.trim()) {
            const append = e.payload.append
            const durationSecs = e.payload.durationSecs
            historyWriteRef.current = historyWriteRef.current
              .then((entryId) =>
                append && entryId !== null
                  ? updateHistoryEntry(entryId, full, durationSecs)
                  : addHistoryEntry(full, durationSecs)
              )
              .catch((err) => {
                console.error('история: запись не сохранена:', String(err))
                // Сорвавшаяся запись обрывает цепочку id, но не сессию:
                // следующая дозапись заведёт новую плитку вместо того,
                // чтобы писать в неизвестно что.
                return null
              })
          }
          // Фокус на РЕДАКТОР (не просто на окно — это уже сделал Rust,
          // emit_to("transcript") + focus_overlay в одном месте, см. отчёт),
          // чтобы курсор сразу был виден и правка началась немедленно.
          // Выделения всего текста НЕ делаем: risk — одна случайная печатная
          // клавиша стёрла бы только что надиктованный текст целиком. normal
          // режим и так не печатает по умолчанию, так что каретка без
          // выделения — самый безопасный вариант.
          view.focus()
        }
        // Язык едет тем же событием, что и текст (см. TranscriptPayload в
        // commands.rs): показать язык одной расшифровки рядом с текстом
        // другой невозможно структурно. Здесь он всегда определённый, не
        // принудительный — принуждение бывает только через retranscribe.
        setLanguage(e.payload.language ? { name: e.payload.language, forced: false } : null)
        detectedLangRef.current = e.payload.language ?? null
        setPhase('ready')
        // ИИ-правка под активную роль и/или автоперевод — поверх уже
        // показанного текста, см. refine. Ни роли, ни языка — вызов выходит
        // сразу, без сети. targetLanguage refine читает из ref сам.
        lastDurationRef.current = e.payload.durationSecs
        // Авто-роль по приложению: запись началась поверх привязанного
        // приложения — эту расшифровку правит роль из привязки, и селектор
        // честно её показывает. Привязки нет — выбор возвращается к
        // постоянному (savedRoleIdRef): подмена живёт одну запись и не
        // утекает ни в настройки, ни в записи из других приложений.
        const autoRole = roleForApp(
          appRolesRef.current,
          rolesRef.current,
          sourceAppNameRef.current,
        )
        const effectiveId = autoRole ? autoRole.id : savedRoleIdRef.current
        setActiveRoleId(effectiveId)
        activeRoleIdRef.current = effectiveId
        refine(autoRole ?? undefined)
      }),
      listen<string>('rec:device-fallback', (e) => {
        setDeviceNotice(e.payload)
      }),
      // Триал кончился: запись не началась (гейт в begin_recording), панель
      // объясняет почему. Фаза ошибки честна — нажатие не сделало ничего.
      listen('license:expired', () => {
        setError(
          'The 14-day trial is over. Open Settings → License to enter a key or buy one — ' +
            'your text and settings are untouched.'
        )
        setPhase('error')
      }),
      // Потолок накопленного звука сессии (см. audio::MAX_SESSION_SAMPLES и
      // spawn_level_emitter/begin_recording в commands.rs). Приходит в двух
      // случаях: запись остановили на десятой минуте и дозапись отклонили,
      // потому что десять минут уже набраны. Оба — уведомление, не ошибка.
      listen<string>('rec:limit', (e) => {
        setLimitNotice(e.payload)
      }),
      listen<string>('error', (e) => {
        setError(e.payload)
        setPhase('error')
        // Обычная ошибка может прийти после отказа в правах — флаг из того
        // случая не должен пережить её и оставить модальный слой поверх панели.
        setPermissionPane(null)
      }),
      listen<AccessibilityErrorPayload>('error:accessibility', (e) => {
        setError(e.payload.message)
        setPermissionPane(e.payload.pane)
        setPhase('error')
      }),
    ]
    return () => {
      subs.forEach((p) => p.then((un) => un()))
    }
  }, [])

  // Захват выделения идёт мимо панели, но сообщать о неудаче больше негде:
  // главное окно при неудачном захвате не открывается вовсе.
  useEffect(() => {
    const un = listen<string>('capture:error', (e) => {
      setError(e.payload)
      setPhase('error')
      // Та же причина, что у обычной 'error' выше: флаг из более раннего
      // отказа в правах не должен пережить эту ошибку и оставить поверх
      // панели модальный слой с «Open Settings».
      setPermissionPane(null)
      // Показывать панель здесь не нужно: захват мог не открывать её вовсе,
      // но это делает Rust перед отправкой события (show_overlay в
      // commands.rs) — тем же вызовом, что и во всех остальных путях с
      // ошибкой, и так же без set_focus: фокус обязан остаться у
      // приложения, из которого выделяли текст.
    })
    return () => {
      un.then((f) => f())
    }
  }, [])

  // Голос в кадре: 0 — тишина/не пишем, 1..3 — ступени громкости. По нему
  // микрофон слегка «дышит» масштабом, а бейдж ON AIR загорается красным.
  // Вне записи — всегда 0: горящий бейдж при молчащем микрофоне врал бы, а
  // неподвижная иконка во время речи — вторая диагностика к дорожке
  // (микрофон не слышит).
  // Берём максимум за последние 4 замера (~200 мс), а не последний: замеры
  // идут 20 раз в секунду, и по одному отсчёту анимация дёргалась бы между
  // кадрами на каждом слоге. Шкала та же, что у столбиков дорожки (0..100).
  const voiceLevel =
    phase === 'recording' && levels.length > 0
      ? Math.min(3, Math.max(0, Math.floor(Math.max(...levels.slice(-4)) / 25)))
      : 0
  const speaking = voiceLevel > 0

  const toggleMic = () => {
    // Во время расшифровки микрофон неактивен: предыдущая запись ещё
    // обрабатывается, и вторая перетёрла бы её результат.
    if (phase === 'transcribing') return
    if (phase === 'recording') stopRecording()
    else startRecording()
  }

  // I6: провал вставки/копирования раньше не производил вообще ничего —
  // успех и отказ были неотличимы. Отказ идёт в уже существующую
  // поверхность ошибок, успех копирования — во временное подтверждение.
  //
  // Читают напрямую doc редактора, а не React state: "Paste и Copy читают
  // текущее содержимое редактора" — CodeMirror уже единственный источник
  // истины (см. комментарий у hasText выше), лишний проброс через state/ref
  // добавил бы задержку в один рендер без всякой пользы. Вызываются и по
  // клику (кнопки остаются кликабельными независимо от Vim-режима), и из
  // vim-экшена 'slaivePaste'/'slaiveClose' (normal-режим), и из глобального
  // обработчика клавиш ниже (когда редактор не в фокусе).
  // Право на вставку проверяется здесь, ДО попытки — если его уже нет,
  // показываем модальный слой сразу, не проходя через реальную попытку
  // paste_text (скрытие/показ панели + фиксированная пауза ради шага,
  // который заведомо провалится). Текст при этом всё равно должен стать
  // доступен пользователю — кладём его в буфер обмена напрямую: копирование
  // прав не требует и работает независимо от Accessibility.
  const onPaste = () => {
    const value = viewRef.current?.state.doc.toString() ?? ''
    // Часть 4: пустое поле не должно пастить — так же, как кнопка Paste
    // недоступна при пустом тексте.
    if (!value) return
    checkAccessibilityPermission()
      .then((allowed) => {
        if (allowed) {
          pasteText(value).catch((e) => {
            setError(String(e))
            setPhase('error')
            setPermissionPane(null)
          })
          return
        }
        copyText(value).catch(() => {
          // Если даже копирование не удалось — модальный слой остаётся
          // единственным сообщением; отдельную ошибку тут не поднимаем,
          // чтобы не перекрыть модалку баннером ошибки одновременно.
        })
        setShowAccessModal(true)
      })
      .catch(() => {
        // Сама проверка права не удалась (например, крейт недоступен на
        // платформе) — не блокируем пользователя молча слоем "нет права",
        // который тут не факт что верен: пробуем обычный путь, он даст
        // свою собственную, уже проверенную ошибку, если права и правда нет.
        pasteText(value).catch((e) => {
          setError(String(e))
          setPhase('error')
          setPermissionPane(null)
        })
      })
  }

  // Follow: текущий текст уходит в главное окно, оверлей прячется на стороне
  // Rust (follow_to_main_window) — см. её doc-комментарий про то, почему
  // это не hide_overlay(). Тот же guard на пустой текст, что у Paste/Copy.
  const onFollow = () => {
    const value = viewRef.current?.state.doc.toString() ?? ''
    if (!value) return
    followToMainWindow(value).catch((e) => {
      setError(String(e))
      setPhase('error')
      setPermissionPane(null)
    })
  }

  // Journal: дописать текущий текст в markdown-файл пользователя (см.
  // journal.ts / append_journal). Та же вспышка-подтверждение, что у Copy,
  // и тот же путь ошибки: неудачная запись — реальная потеря действия (в
  // отличие от фоновой history), пользователь нажал и ждёт результата.
  const onJournal = () => {
    const value = viewRef.current?.state.doc.toString() ?? ''
    if (!value.trim()) return
    appendJournal(formatJournalEntry(value, new Date()))
      .then(() => {
        setJournaled(true)
        setTimeout(() => setJournaled(false), 1500)
      })
      .catch((e) => {
        setError(String(e))
        setPhase('error')
        setPermissionPane(null)
      })
  }

  // Та же логика чтения, что и в onPaste — пустой транскрипт не должен
  // копироваться так же, как не должен пастить.
  const onCopy = () => {
    const value = viewRef.current?.state.doc.toString() ?? ''
    if (!value) return
    copyText(value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((e) => {
        setError(String(e))
        setPhase('error')
        setPermissionPane(null)
      })
  }

  // Повторная расшифровка УЖЕ ЗАПИСАННОГО звука под выбранным языком.
  // Определение языка иногда ошибается, и тогда текст бессмыслен целиком —
  // но звук записан нормально, и переговаривать абзац заново незачем.
  //
  // Звук, дорожка уровня и Play при этом не трогаются вообще: пересчитывается
  // только текст (бэкенд читает ту же сырую запись из last_recording, которую
  // играет Play, и ничего в неё не пишет — см. retranscribe в commands.rs).
  const onForceLanguage = (lang: ForcedLanguage) => {
    // Второй проход поверх первого отказывает и сам бэкенд, но дать нажать
    // второй раз и ответить отказом — хуже, чем не дать нажать.
    if (retranscribing) return
    // Снимок делается ЗДЕСЬ, в момент нажатия, а не в момент прихода
    // результата: между ними секунды, и поле за это время могли править.
    // Вернуть надо именно то, что человек видел, когда просил повтор.
    const previous = viewRef.current?.state.doc.toString() ?? ''
    setRetranscribing(true)
    setRetranscribeError('')
    // Работа видна той же строкой статуса, что и у первого прохода
    // («Transcribing…»): это ровно то же самое событие для пользователя, и
    // второй словарь состояний панели ради него не нужен.
    setPhase('transcribing')
    retranscribe(lang)
      .then((res) => {
        const view = viewRef.current
        // Пересчитанный текст — такой же сырой whisper-текст, Smart Replace
        // применяется к нему ровно как в обработчике transcript.
        const text = applySmartReplaces(res.text, smartReplacesRef.current)
        // Замена ЦЕЛИКОМ, а не вставка: пересчитан весь накопленный звук, и
        // приклеивать такой текст к старому означало бы показать сказанное
        // дважды. Прежнее содержимое уходит под Undo строкой ниже.
        if (view) resetEditorContent(view, text)
        setLanguage(res.language ? { name: res.language, forced: res.forced } : null)
        detectedLangRef.current = res.language ?? null
        // Пустое (или пробельное) прежнее содержимое возвращать незачем —
        // тот же порог, что в главном окне.
        setReplaced(previous.trim() ? previous : null)
        setReplacedNotice(RETRANSCRIBE_NOTICE)
        if (view) view.focus()
        // Пересчитанный текст — тоже сырой whisper-текст: активная роль
        // правит и его. Снимок Undo при этом сменится на пред-правочный —
        // последняя замена объясняется последней плашкой.
        lastDurationRef.current = res.durationSecs
        refine()
        // Журнал: плитка этой сессии должна держать ИСПРАВЛЕННЫЙ текст, а не
        // бессмысленный от неверного языка — иначе починка языка живёт только
        // до закрытия панели. Растим ту же запись, что и дозаписи (одна
        // сессия — одна плитка, см. обработчик transcript выше); id ещё нет,
        // только если первая запись в журнал сорвалась.
        historyWriteRef.current = historyWriteRef.current
          .then((entryId) =>
            entryId !== null
              ? updateHistoryEntry(entryId, text, res.durationSecs)
              : addHistoryEntry(text, res.durationSecs)
          )
          .catch((err) => {
            console.error('история: повторная расшифровка не сохранена:', String(err))
            return null
          })
      })
      .catch((e) => {
        // Текст в поле не тронут: его заменяет только ветка успеха выше.
        setRetranscribeError(String(e))
      })
      .finally(() => {
        setRetranscribing(false)
        // Фазу возвращаем ТОЛЬКО если она всё ещё наша. За эти секунды могла
        // прийти ошибка или начаться новая запись (хоткей успевает проскочить
        // в узкое окно до того, как бэкенд займёт модель) — затирать чужую
        // фазу своим «готово» значило бы соврать о состоянии панели.
        setPhase((p) => (p === 'transcribing' ? 'ready' : p))
      })
  }

  // Возврат текста, который заменила повторная расшифровка — побайтово, из
  // снимка. Ярлык языка при этом НЕ откатывается: он описывает, на каком
  // языке прошла расшифровка, а это случилось независимо от того, оставил
  // человек её результат или нет.
  const onUndoReplace = () => {
    if (replaced === null) return
    const view = viewRef.current
    if (view) resetEditorContent(view, replaced)
    setReplaced(null)
    if (view) view.focus()
  }

  // vim-экшены 'slaivePaste'/'slaiveClose' (см. верх файла) объявлены и
  // замаплены на <CR>/<Esc> ОДИН раз при загрузке модуля — Vim общий на весь
  // процесс. Сами колбэки они дёргают из vimActionTargets, актуализируем его
  // на каждый рендер — тот же приём, что pasteShortcutRef/copyShortcutRef
  // ниже, просто не через React-ref (эти функции объявлены вне компонента и
  // ref им не достать).
  useEffect(() => {
    vimActionTargets.onPaste = onPaste
    vimActionTargets.onClose = () => hideOverlay()
  })

  // Единый глобальный обработчик клавиш — не на редакторе, а на window, но
  // ТОЛЬКО как резерв на случай, когда сам редактор не в фокусе (фокус на
  // кнопке или вообще нигде). Пока редактор в фокусе, Escape/Enter уже
  // разобраны на уровне Vim: normal режим — через vim-экшены выше (это же
  // устраняет гонку между "какой сейчас режим" и "vim только что этот режим
  // сменил" — vim сам решает по СВОЕМУ внутреннему состоянию синхронно, до
  // того как событие вообще всплывает до этого обработчика), insert режим —
  // штатным поведением CodeMirror/vim (перенос строки на Enter, выход в
  // normal на Escape). Если бы этот обработчик ещё и проверял vimMode здесь,
  // он читал бы состояние ПОСЛЕ того, как vim мог его уже поменять тем же
  // нажатием — отсюда и резервная роль строго "редактор не в фокусе", без
  // обращения к vimMode вообще.
  //
  // Copy — единственный хоткей без этого раздвоения: Cmd+C не часть vim-
  // грамматики (в ней не бывает Cmd-модификатора), поэтому конфликта нет, и
  // он остаётся глобальным независимо от фокуса/режима, как было раньше.
  // Ref для showAccessModal — тот же приём, что pasteShortcutRef/copyShortcutRef
  // чуть выше: обработчик ниже навешен один раз на mount (deps: []), поэтому
  // читает актуальное значение через ref, а не через захваченную в замыкании
  // копию состояния на момент навешивания.
  const showAccessModalRef = useRef(showAccessModal)
  useEffect(() => {
    showAccessModalRef.current = showAccessModal
  }, [showAccessModal])
  // Тот же приём для второго модального слоя — «отказано в праве».
  const permissionPaneRef = useRef(permissionPane)
  useEffect(() => {
    permissionPaneRef.current = permissionPane
  }, [permissionPane])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editorFocused = viewRef.current?.hasFocus ?? false
      if (e.key === 'Escape') {
        // Модальный слой не должен быть ловушкой (см. бриф): Escape закрывает
        // его в первую очередь, независимо от фокуса редактора — иначе если
        // фокус случайно остался на редакторе, Escape ушёл бы в Vim вместо
        // закрытия слоя.
        if (showAccessModalRef.current) {
          setShowAccessModal(false)
          return
        }
        if (permissionPaneRef.current) {
          setPermissionPane(null)
          return
        }
        if (editorFocused) return // редактор/vim разберётся сам
        hideOverlay()
        return
      }
      // Раскрытие селекторов с клавиатуры — Cmd+R для «Redo as», Cmd+D для
      // роли. Селектор может отсутствовать в DOM (не та фаза, ролей нет) или
      // быть отключён (повтор/правка уже идёт) — оба случая закрывает
      // проверка элемента, второго источника правды о доступности не заводим.
      const pickerFor = matchesShortcut(e, REDO_AS_SHORTCUT)
        ? langForceRef.current
        : matchesShortcut(e, ROLE_SHORTCUT)
          ? roleSelectRef.current
          : null
      if (pickerFor) {
        if (pickerFor.disabled) return
        // preventDefault в том числе отбирает Cmd+R у перезагрузки webview.
        e.preventDefault()
        pickerFor.focus()
        // Именно РАСКРЫТЬ список, а не только сфокусировать: в открытом
        // списке стрелки ходят по пунктам, не меняя значения, Enter выбирает
        // (fires change), Escape закрывает без выбора.
        try {
          pickerFor.showPicker()
        } catch {
          // Нет transient activation или старый WebKit — остаётся фокус, на
          // macOS стрелка вниз раскрывает сфокусированный список сама.
        }
        return
      }
      if (matchesShortcut(e, pasteShortcutRef.current)) {
        if (editorFocused) return // normal → vim-экшен; insert → обычный Enter
        e.preventDefault()
        onPaste()
        return
      }
      if (matchesShortcut(e, copyShortcutRef.current)) {
        e.preventDefault()
        onCopy()
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Follow — отдельный слушатель, и отдельный он ровно из-за ФАЗЫ.
  //
  // Обработчик выше висит на всплытии: Paste и Escape там разбираются так,
  // что пока редактор в фокусе, клавиша принадлежит vim (см. длинный
  // комментарий у него), а Copy проходит мимо vim просто потому, что
  // Cmd-модификатора в грамматике vim не бывает. Follow не попадает ни в ту,
  // ни в другую категорию сама по себе: в отличие от Paste/Copy, её
  // комбинация настраивается пользователем и не ограничена Cmd-сочетаниями —
  // назначь на неё Ctrl+F, и `<C-f>` в vim это штатный моушен «страница
  // вперёд» (node_modules/@replit/codemirror-vim-core/vim.js, строка 132), до
  // которого на всплытии нажатие вообще не дошло бы. Дефолт — Cmd+F, у него
  // этой конкретной коллизии нет, но перехват на фазе захвата рассчитан на
  // любую настраиваемую комбинацию, а не только на дефолтную.
  //
  // Поэтому перехват, как в главном окне (MainWindow.tsx), — тот же приём,
  // а не второй механизм: обычный window-keydown, тот же matchesShortcut, та
  // же настройка. Плюс stopPropagation: preventDefault отменяет только
  // действие браузера, а CodeMirror слушает keydown на своём contentDOM и
  // прокрутил бы страницу всё равно — событие обязано остановиться здесь.
  //
  // Отобрать `<C-f>` у редактора не жалко по той же причине, по которой
  // панель уже отобрала у него `<CR>` (там это было "j^"): в короткой
  // надиктованной фразе листать страницами нечего.
  //
  // Голая клавиша сюда попасть не может — поле Follow в настройках требует
  // модификатора (см. Settings.tsx): перехваченная так же, она отобрала бы у
  // редактора обычный ввод.
  //
  // Эффект без списка зависимостей — намеренно, тот же приём, что в
  // MainWindow.tsx: обработчик читает и хоткей, и `onFollow`, и перевесить
  // один слушатель на каждый рендер честнее, чем держать ref на каждое из
  // этих значений. Устаревшего замыкания при этом не бывает по построению.
  useEffect(() => {
    const onFollowKey = (e: KeyboardEvent) => {
      // Слой «нет права на вставку» — модальный: пока он открыт, у панели
      // ровно два выхода, и уводить текст в другое окно мимо него нельзя.
      // Тот же guard, что у остальных действий в обработчике выше.
      if (showAccessModal) return
      if (!matchesShortcut(e, followShortcut)) return
      e.preventDefault()
      e.stopPropagation()
      onFollow()
    }
    window.addEventListener('keydown', onFollowKey, true)
    return () => window.removeEventListener('keydown', onFollowKey, true)
  })

  // Cmd+J → Journal: тот же эффект-без-зависимостей, что у Follow выше, и
  // тот же модальный guard. Пока путь к журналу не задан, кнопки нет — и
  // хоткей обязан молчать так же.
  useEffect(() => {
    const onJournalKey = (e: KeyboardEvent) => {
      if (showAccessModal) return
      if (!journalPath) return
      if (!matchesShortcut(e, JOURNAL_SHORTCUT)) return
      e.preventDefault()
      e.stopPropagation()
      onJournal()
    }
    window.addEventListener('keydown', onJournalKey, true)
    return () => window.removeEventListener('keydown', onJournalKey, true)
  })

  // Текущее проигрывание — чтобы повторный Play/перемотка обрывали
  // предыдущее, а не накладывали звук на звук. offset/startedAt — точка
  // отсчёта позиции головки воспроизведения (часть 1): offset — секунда
  // записи, с которой стартовал ЭТОТ источник, startedAt — currentTime его
  // AudioContext в момент старта; текущая позиция всегда
  // offset + (ctx.currentTime - startedAt), без отдельного таймера.
  const playbackRef = useRef<{
    ctx: AudioContext
    src: AudioBufferSourceNode
    offset: number
    startedAt: number
  } | null>(null)

  // PCM последней записи, закэшированный на фронтенде — и Play, и перемотка
  // (каждое движение при перетаскивании) читают его многократно, повторный
  // invoke на каждое действие был бы расточительным. Сбрасывается на
  // rec:start (см. эффект выше) — новый цикл записи не должен проигрывать
  // звук от предыдущего.
  const pcmRef = useRef<Float32Array | null>(null)

  const stopPlayback = () => {
    const prev = playbackRef.current
    if (!prev) return
    playbackRef.current = null
    // Снимаем onended до stop(): иначе прерванный источник сам закроет уже
    // новый контекст, когда его "ended" всё же долетит асинхронно.
    prev.src.onended = null
    try {
      prev.src.stop()
    } catch {
      // Уже остановлен или доиграл сам — не страшно.
    }
    prev.ctx.close()
  }

  // ponytail: играем через WebAudio, не заводя вывод звука в Rust — так в
  // разы меньше кода, и не нужен второй аудио-поток. Если понадобится
  // проигрывание без открытой панели, тогда завести вывод в Rust.
  //
  // Гарантирует, что pcmRef (и вместе с ним duration) заполнены для последней
  // записи. Кэширует результат — Play, а затем перемотка (или наоборот) не
  // бьют по backend второй раз, и каждое событие перетаскивания не превращается
  // в отдельный invoke. null — записи ещё нет или она пуста; вызывающая
  // сторона должна молча ничего не делать (как и раньше делал onPlay).
  const ensurePcm = (): Promise<Float32Array | null> => {
    if (pcmRef.current) return Promise.resolve(pcmRef.current)
    return getLastRecording().then((pcm) => {
      if (!pcm || pcm.length === 0) return null
      const arr = Float32Array.from(pcm)
      pcmRef.current = arr
      setDuration(arr.length / 16000)
      return arr
    })
  }

  // Общая точка входа для Play и перемотки — останавливает текущий звук
  // (если играл) и запускает новый источник с заданного смещения. offset —
  // секунды от начала записи. Вызывается только после того, как pcmRef уже
  // заполнен через ensurePcm.
  //
  // source.start(0, offset) — второй аргумент WebAudio как раз про
  // проигрывание с середины буфера. Смещение клампится чуть меньше
  // длительности: offset === duration ровно исключения не бросает, но и не
  // проигрывает ни одного сэмпла, так что головка тут же исчезла бы, не
  // сдвинувшись с места, — не то, что подразумевает клик в конец дорожки.
  const playFrom = (offset: number) => {
    const pcm = pcmRef.current
    if (!pcm) return
    stopPlayback()
    const durationSec = pcm.length / 16000
    const clampedOffset = Math.min(Math.max(0, offset), Math.max(0, durationSec - 1 / 16000))
    const ctx = new AudioContext()
    const buffer = ctx.createBuffer(1, pcm.length, 16000)
    buffer.getChannelData(0).set(pcm)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    src.connect(ctx.destination)
    // Закрываем контекст после проигрывания, иначе они копятся при каждом
    // нажатии/перемотке. playbackRef.current?.src === src — защита из
    // отчёта: у источника, остановленного перемоткой, onended уже снят в
    // stopPlayback(), поэтому сюда попадает только тот, что реально доиграл
    // сам, а не был прерван новым playFrom.
    src.onended = () => {
      if (playbackRef.current?.src === src) {
        playbackRef.current = null
        setIsPlaying(false)
      }
      ctx.close()
    }
    // currentTime свежесозданного контекста — точка отсчёта для позиции
    // головки (см. эффект requestAnimationFrame ниже): текущая позиция
    // всегда clampedOffset + (ctx.currentTime - startedAt), без отдельного
    // таймера, который разъехался бы со звуком на первой же системной паузе.
    const startedAt = ctx.currentTime
    playbackRef.current = { ctx, src, offset: clampedOffset, startedAt }
    src.start(0, clampedOffset)
    setIsPlaying(true)
  }

  // Кнопка — переключатель Play/Pause: пока звук играет, она показывает ⏸ и
  // останавливает проигрывание (см. JSX кнопки ниже). isPlaying взводится
  // сразу по клику — это закрывает окно между кликом и разрешением
  // ensurePcm, в которое иначе могло бы проскочить повторное нажатие.
  // Гасится он на любом пути, где реального проигрывания не случилось
  // (пустой буфер, отказ ensurePcm), и на естественном завершении в onended.
  // Play всегда начинает с начала записи — в отличие от перемотки, это
  // «послушать заново», а не «доиграть с места».
  // ponytail: пауза — это стоп, без запоминания позиции; возобновление с
  // места — когда записи станут настолько длинными, что «с начала» будет
  // раздражать (playFrom уже умеет offset).
  const onPlayPause = () => {
    if (isPlaying) {
      stopPlayback()
      setIsPlaying(false)
      return
    }
    setIsPlaying(true)
    ensurePcm()
      .then((pcm) => {
        if (!pcm) {
          setIsPlaying(false)
          return
        }
        playFrom(0)
      })
      .catch((e) => {
        setIsPlaying(false)
        setError(String(e))
        setPhase('error')
        setPermissionPane(null)
      })
  }

  // Перемотка (часть 1): клик или перетаскивание по дорожке переставляет
  // позицию и сразу проигрывает с новой точки — явное решение пользователя,
  // а не молчаливая перестановка. Работает одинаково во время проигрывания и
  // когда оно остановлено: playFrom сам обрывает текущий звук через
  // stopPlayback, если он был.
  const isDraggingRef = useRef(false)
  const pendingSeekXRef = useRef<number | null>(null)
  const seekRafRef = useRef<number | null>(null)

  const seekToClientX = (clientX: number) => {
    const el = levelsContainerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const width = rect.width || 1
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / width))
    ensurePcm().then((pcm) => {
      if (!pcm) return
      playFrom(frac * (pcm.length / 16000))
    })
  }

  // Перетаскивание может слать pointermove чаще, чем раз в кадр, а каждый
  // seek пересоздаёт AudioContext (playFrom → stopPlayback + новый
  // AudioContext). Коалесцируем через requestAnimationFrame: за один кадр
  // применяется только последняя позиция курсора, а не каждое промежуточное
  // событие.
  const scheduleSeek = (clientX: number) => {
    pendingSeekXRef.current = clientX
    if (seekRafRef.current !== null) return
    seekRafRef.current = requestAnimationFrame(() => {
      seekRafRef.current = null
      if (pendingSeekXRef.current !== null) seekToClientX(pendingSeekXRef.current)
    })
  }

  const onLevelsPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // Пока идёт запись, дорожка — живой индикатор в другом масштабе (бары
    // набегают, итоговая длительность неизвестна), и попадание клика по
    // времени было бы враньём. Плюс проигрывание в микрофон во время записи
    // само по себе не то, чего от кнопки ждут.
    if (!hasRecording || phase === 'recording') return
    e.currentTarget.setPointerCapture(e.pointerId)
    isDraggingRef.current = true
    seekToClientX(e.clientX)
  }
  const onLevelsPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    scheduleSeek(e.clientX)
  }
  const onLevelsPointerUp = () => {
    isDraggingRef.current = false
  }

  // Головка воспроизведения — перерисовывается через requestAnimationFrame,
  // не через setInterval: обновление синхронизировано с кадром отрисовки, не
  // жжёт батарею лишними тиками в фоне, когда панель не видна, и не
  // дёргается независимо от частоты кадров экрана. Позиция всегда считается
  // из AudioContext.currentTime активного плейбека (playbackRef), а не из
  // отдельного таймера — иначе она разъехалась бы со звуком на первой же
  // паузе системы (см. отчёт).
  useEffect(() => {
    if (!isPlaying) {
      setPlayheadPct(null)
      return
    }
    let raf: number
    const tick = () => {
      const pb = playbackRef.current
      if (pb && duration > 0) {
        const pos = pb.offset + (pb.ctx.currentTime - pb.startedAt)
        setPlayheadPct(Math.min(1, Math.max(0, pos / duration)))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying, duration])

  return (
    // data-tauri-drag-region на корне: Tauri стартует перетаскивание только
    // когда нажатие пришлось РОВНО в элемент с атрибутом (event.target, не
    // ближайший предок), поэтому любое пустое место панели — padding, зазоры
    // между рядами — двигает окно, а всё интерактивное (кнопки, редактор,
    // дорожка с перемоткой) остаётся собой: нажатие в них попадает в ребёнка
    // без атрибута. Тот же атрибут стоит на «мёртвых» текстовых узлах ниже
    // (шапка источника, строка статуса) — их собственные узлы иначе съели бы
    // нажатие; полоса сверху (.overlay-drag-region) остаётся для верхнего
    // padding, где нажатие перехватывал бы корень, но полоса была раньше и
    // держит зону между угловыми кнопками.
    <div className="overlay chassis" ref={rootRef} data-tauri-drag-region>
      {/* Close переехал сюда из ряда действий (часть 1 брифа) — это
          закрытие окна, а не действие над результатом, и вешается в
          привычный верхний угол панели, как обычно закрываются панели.
          Escape по-прежнему закрывает панель тем же путём (см. глобальный
          обработчик клавиш ниже) — эта кнопка лишь даёт кликабельную
          альтернативу, поведение не дублирует и не переопределяет. */}
      {/* Настройки рядом с закрытием: обе кнопки управляют окном, а не
          текстом, поэтому живут в одном углу и вне сетки действий — по той
          же причине, по которой оттуда в своё время уехали Play и Close. */}
      {/* Область перетаскивания окна — пустая полоса сверху панели, под
          которую уже зарезервирован верхний padding (32px, см. .overlay в
          styles.css: место оставлено под .overlay-close/.overlay-settings,
          чтобы они не наезжали на шапку источника/строку статуса). Панель
          borderless (decorations: false в tauri.conf.json), системной
          титульной строки для перетаскивания у неё нет вовсе — без этого
          элемента окно было бы неподвижно.

          Это НЕ вся панель: дорожка уровня поддерживает клик-и-протяжку для
          перемотки (onLevelsPointerDown/Move/Up), поле — редактор, а кнопки —
          кнопки, и `data-tauri-drag-region` на любом из них перехватывал бы
          обычный клик под перетаскивание окна. Единственное место, где это
          безопасно, — сама пустая полоса: обе угловые кнопки лежат поверх
          неё (z-index: 2 против z-index: 1 ниже) и остаются кликабельными,
          попадание мимо них по той же полосе двигает окно.

          Позиция окна НЕ запоминается между запусками — `center: true` в
          tauri.conf.json продолжает центрировать панель при каждом старте
          приложения, перетаскивание живёт только пока окно не пересоздано
          (панель скрывается, а не закрывается, пока приложение работает —
          см. show_overlay/hide_overlay в commands.rs, — поэтому позиция и
          так переживает Close/Show внутри одного запуска без специального
          кода). Сознательное упрощение, не забытое: центр — предсказуемое
          место, которое не может оказаться за пределами экрана, если между
          запусками сменился монитор или его разрешение, а сохранённая
          позиция может.
          // ponytail: позиция окна не сохраняется на диск между запусками,
          // усложнить до settings.json (как windowOpacity) с проверкой
          // «координата всё ещё на каком-то экране» через
          // availableMonitors(), когда пользователи попросят её помнить. */}
      <div className="overlay-drag-region" data-tauri-drag-region />
      <button
        type="button"
        className="overlay-settings"
        onClick={() => openSettingsWindow()}
        aria-label="Settings"
        title="Settings"
      >
        ⚙
      </button>
      <button
        type="button"
        className="overlay-close"
        onClick={() => hideOverlay()}
        aria-label="Close"
        title="Close"
      >
        ×
      </button>
      {sourceApp && (
        // Шапка не интерактивна — за неё естественно браться, чтобы двигать
        // панель, поэтому атрибут и на контейнере, и на самих узлах текста и
        // иконки: Tauri смотрит ровно на event.target (см. корень выше).
        <div className="source-app" data-tauri-drag-region>
          {sourceApp.icon && (
            <img
              className="source-app-icon"
              src={sourceApp.icon}
              alt=""
              draggable={false}
              data-tauri-drag-region
            />
          )}
          <span className="source-app-name" data-tauri-drag-region>{sourceApp.name}</span>
        </div>
      )}
      {/* Атрибут на ряду — двигает окно только пустое место ряда: нажатие в
          микрофон или бейдж режима попадает в их собственные узлы. */}
      <div className="row" data-tauri-drag-region>
        <div
          className={`mic ${phase === 'recording' ? 'live' : ''} ${phase === 'transcribing' ? 'busy' : ''}`}
          onClick={toggleMic}
        >
          {/* Иконка «дышит» масштабом по громкости — та же шкала 0..3, что
              раньше раскрывала рот роботу. transition на .mic-icon сглаживает
              шаги между замерами. */}
          <img
            className="mic-icon"
            src={micIcon}
            alt=""
            draggable={false}
            style={{ transform: `scale(${1 + voiceLevel * 0.06})` }}
          />
        </div>
        {/* ON AIR — горит красным только пока в записи слышен голос; в
            тишине и вне записи бейдж гаснет до нейтрального. Это индикатор
            «меня сейчас слышно», а не «идёт запись» — про запись говорят
            красная кнопка и статус. */}
        <span className={`onair${speaking ? ' live' : ''}`} data-tauri-drag-region>
          ON AIR
        </span>
        {/* Строка статуса — тоже мёртвый текст: пусть тянет окно (см. корень). */}
        <div className="status" data-tauri-drag-region>{phase === 'error' ? error : LABEL[phase]}</div>
        {/* Индикатор Vim-режима — виден только пока панель реально готова к
            редактированию (ready): в остальных фазах фокуса на редакторе нет
            и режим не имеет смысла показывать (см. фокус-репорт). Без него
            режимный Escape/Enter — лотерея: NORMAL закрывает/пастит,
            INSERT переносит строку/печатает, а на глаз не отличить. */}
        {phase === 'ready' && (
          <span className={`vim-mode vim-mode-${vimMode}`}>{vimMode.toUpperCase()}</span>
        )}
      </div>
      {/* Микрофон подменён на умолчание, потому что сохранённого устройства
          нет (см. rec:device-fallback в commands.rs). Не фаза ошибки —
          запись идёт; но и не подсказка, которую можно не заметить: без неё
          человек будет уверен, что диктует в iPhone. */}
      {deviceNotice && <div className="device-notice">{deviceNotice}</div>}
      {/* Потолок накопленного звука выбран. Та же поверхность, что у подмены
          микрофона, и по той же причине: запись и текст в порядке, но
          происходящее нужно объяснить — молчаливый потолок хуже, чем его
          отсутствие. */}
      {limitNotice && <div className="device-notice">{limitNotice}</div>}
      {/* Часть 1: дорожка теперь и элемент управления плеером — клик или
          перетаскивание переставляют позицию воспроизведения (см.
          onLevelsPointerDown/Move/Up и seekToClientX выше). Класс
          has-recording (курсор pointer) — только подсказка доступности,
          не декорация сигнала: при пустой дорожке клик и так no-op внутри
          seekToClientX/ensurePcm. playhead — единственный элемент дорожки,
          зависящий от данных (позиции воспроизведения), а не от уровня
          сигнала: появляется только пока playheadPct не null, то есть пока
          isPlaying (см. ограничение части 3 и эффект requestAnimationFrame
          выше) — при пустой и при полностью нулевой дорожке playheadPct
          всегда null (Play недоступен без hasRecording), так что здесь
          рисовать нечего.

          Часть 1 (регруппировка): Play переехал сюда, вплотную к дорожке —
          он транспортное управление ЗВУКОМ, а не действие над текстом
          (Paste/Copy/Follow), и должен стоять рядом с тем, чем управляет, а
          не в общем ряду с ними (см. отчёт). .levels-row — новый общий
          флекс-ряд: сама дорожка (flex: 1) остаётся 64px высотой (см.
          styles.css), компактная кнопка рядом — 32px, не растягивает ряд. */}
      <div className="levels-row">
        <div
          className={`levels${hasRecording ? ' has-recording' : ''}`}
          ref={levelsContainerRef}
          onPointerDown={onLevelsPointerDown}
          onPointerMove={onLevelsPointerMove}
          onPointerUp={onLevelsPointerUp}
          onPointerCancel={onLevelsPointerUp}
        >
          {displayLevels.map((height, i) => (
            <div key={i} className="level" style={{ height: `${height}%` }} />
          ))}
          {playheadPct !== null && (
            <div className="playhead" style={{ left: `${playheadPct * 100}%` }} />
          )}
        </div>
        {/* Пульсация во время проигрывания — мягкий индикатор активности
            (.overlay button.playing / @keyframes play-pulse в styles.css).
            Во время проигрывания кнопка НЕ блокируется, а превращается в
            Pause: повторное нажатие останавливает звук (onPlayPause). */}
        <button
          type="button"
          className={`play-transport ${isPlaying ? 'playing' : ''}`}
          disabled={!hasRecording || phase === 'recording'}
          onClick={onPlayPause}
          aria-label={isPlaying ? 'Pause' : 'Play'}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
      </div>
      {/* Часть 3/Vim: было read-only div, потом textarea, теперь CodeMirror с
          Vim-биндингами (@replit/codemirror-vim) — пользователь правит
          распознанный текст перед вставкой командами Vim, а не просто вводом.
          CodeMirror владеет DOM внутри этого контейнера императивно (см.
          эффект создания EditorView), поэтому React не рендерит содержимое
          сам — только сам div-контейнер. Paste/Copy читают doc редактора
          напрямую (onPaste/onCopy выше), не React state. Enter/Escape в
          normal режиме обрабатываются через Vim.mapCommand (см. верх файла);
          хоткей Copy — глобально (см. эффект выше), не здесь. */}
      <div className="transcript-field" ref={editorContainerRef} />
      {/* ИИ-правка идёт: индикатор-«челнок» во всю ширину под полем текста
          — на месте прежнего чипа «Polishing…» в строке роли, который был
          незаметен. Бегущий сегмент, а не проценты: у запроса к модели нет
          измеримого прогресса. */}
      {refining && (
        <div
          className="refine-bar"
          role="progressbar"
          aria-label="Polishing the transcript with the dictor role"
        >
          <div className="refine-bar-thumb" />
        </div>
      )}
      {/* Строка про ЯЗЫК — и ярлык, и селектор принудительного выбора.
          Стоит между полем и действиями, вплотную под текстом, потому что
          относится именно к тексту: ярлык отвечает «на каком языке это
          прочитано», а селектор пересчитывает ЭТОТ ЖЕ текст на другом языке.
          В строку статуса это не поместить: там уже микрофон, ON AIR, сам
          статус и бейдж Vim-режима, и пятый элемент (а с селектором —
          шестой) превратил бы её в свалку. К дорожке уровня — тоже нет: та
          про звук, а язык про текст, и повторная расшифровка звука не
          касается вовсе (см. onForceLanguage).

          Ярлык внутри строки
          — отдельное условие: в авторежиме язык определила модель, и это
          информация; при языке, приколотом в настройках, whisper его не
          определял — ему его назвали, и повторять человеку его же настройку
          значило бы занимать место шумом (решает бэкенд, см.
          language_report). Селектор остаётся в обоих случаях: приколотая
          настройка тоже бывает не тем, что нужно этой записи. */}
      {/* Язык и роль — ОДНА строка из двух плотных пар «ярлык + селектор» с
          КОНСТАНТНЫМ порядком: «Redo as» всегда первый (просто выключен,
          пока пересчитывать нечего), роль всегда сразу за ним, чип
          Detected/Forced — в конце строки у правого края. Прежняя версия
          показывала языковую пару только в фазе ready и прижимала роль
          вправо — роль прыгала от левого края к правому на каждой
          расшифровке. */}
      {(phase === 'ready' || retranscribing || roles.length > 0 || translateLanguages.length > 0) && (
        <div className="lang-row">
          {/* Селектор сбрасывается в пустое значение после каждого выбора
              (value="" — контролируемое): это кнопка-действие, а не поле
              настройки, и показывать в нём «текущий язык» было бы обещанием
              постоянства, которого здесь нет. Постоянное предпочтение живёт
              в Recognition settings; выбор здесь действует на одну запись и
              гаснет с началом следующей (см. rec:start). */}
          <select
            ref={langForceRef}
            className="lang-force"
            value=""
            disabled={phase !== 'ready' || !hasRecording || retranscribing}
            aria-label="Re-transcribe this recording in another language"
            title="⌘R opens this list"
            onChange={(e) => onForceLanguage(e.target.value as ForcedLanguage)}
          >
            <option value="" disabled>
              {retranscribing ? 'Re-transcribing…' : 'Redo as…'}
            </option>
            {FORCED_LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
          {/* Подпись хоткея — тот же бейдж, что на кнопках действий:
              комбинация видна, а не спрятана в title. */}
          <span className="shortcut-badge">{formatShortcutBadge(REDO_AS_SHORTCUT)}</span>
          {/* Роль диктора — постоянное предпочтение, в отличие от разового
              «Redo as» слева, поэтому селектор показывает текущее значение
              и виден всегда (пока роли вообще заведены в настройках): роль
              выбирают и ПЕРЕД записью, не только над готовым текстом.
              Пара обёрнута в .role-group: ярлык, селектор и индикатор
              держатся вплотную и двигаются по строке как одно целое. */}
          {roles.length > 0 && (
            <span className="role-group">
              <span className="lang-chip">Role</span>
              <select
                ref={roleSelectRef}
                className="lang-force"
                value={activeRoleId ?? ''}
                disabled={refining}
                aria-label="Dictor role that polishes the transcript through the AI provider"
                title="⌘D opens this list"
                onChange={(e) => onRoleChange(e.target.value)}
              >
                <option value="">No role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name || '(unnamed)'}
                  </option>
                ))}
              </select>
              <span className="shortcut-badge">{formatShortcutBadge(ROLE_SHORTCUT)}</span>
            </span>
          )}
          {/* Язык автоперевода — постоянное предпочтение, как роль: выбрал
              язык, и каждая расшифровка (и уже готовый текст) переводится в
              него тем же ИИ-проходом (см. onTargetLanguageChange / refine).
              Список — из translate_languages, что и подменю Translate главного
              окна. Текущее значение, которого нет в списке (список правили в
              настройках), добавляем отдельным пунктом, чтобы селектор не
              показывал пустоту при включённом переводе. */}
          {translateLanguages.length > 0 && (
            <span className="role-group">
              <span className="lang-chip">To</span>
              <select
                className="lang-force"
                value={targetLanguage}
                disabled={refining}
                aria-label="Target language — the AI translates the transcript into it"
                onChange={(e) => onTargetLanguageChange(e.target.value)}
              >
                <option value="">No translation</option>
                {targetLanguage && !translateLanguages.includes(targetLanguage) && (
                  <option value={targetLanguage}>{targetLanguage}</option>
                )}
                {translateLanguages.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </span>
          )}
          {/* Факт о языке — в конце строки у правого края: появляясь после
              расшифровки, он никого не сдвигает, в отличие от прежнего места
              перед селектором. */}
          {(phase === 'ready' || retranscribing) && language && (
            <span className={`lang-chip lang-report${language.forced ? ' forced' : ''}`}>
              {language.forced ? 'Forced' : 'Detected'}: {language.name}
            </span>
          )}
        </div>
      )}
      {/* Повтор не удался. Та же поверхность, что у подмены микрофона и
          потолка сессии, и по той же причине: текст на месте и работает,
          сломалась только попытка его улучшить. Фазой ошибки это быть не
          может — она увела бы и строку языка, и селектор, и повторить
          попытку стало бы нечем. */}
      {retranscribeError && (
        <div className="device-notice">
          {retranscribeError} The text is unchanged.
        </div>
      )}
      {/* ИИ-правка не удалась — та же поверхность и тот же довод, что у
          retranscribeError: сырой текст на месте и работает. */}
      {refineError && (
        <div className="device-notice">
          {refineError} The raw transcript is unchanged.
        </div>
      )}
      {/* Строка возврата заменённого текста — нейтральная плашка, не ошибка:
          ничего не сломалось, текст заменён ровно так, как и просили. Тот же
          приём, что .mw-notice в главном окне. */}
      {replaced !== null && (
        <div className="overlay-notice">
          <span>{replacedNotice}</span>
          <div className="overlay-notice-actions">
            <button onClick={onUndoReplace}>Undo</button>
            <button onClick={() => setReplaced(null)}>Dismiss</button>
          </div>
        </div>
      )}
      {/* Регруппировка (часть 1 брифа): Play переехал к дорожке уровня
          (.levels-row выше — транспорт для звука, не действие над
          результатом), Close переехал в верхний угол панели (.overlay-close
          выше — закрытие окна, не действие над результатом). Здесь остаются
          ровно три кнопки — действия НАД РАСПОЗНАННЫМ ТЕКСТОМ, и они же
          были причиной, по которой сетка вообще существует: подпись и
          бейдж хоткея внутри кнопки не должны переноситься на разные
          строки ни при какой ширине колонки (см. .action-grid button ниже),
          поэтому сетка с фиксированным числом колонок, а не флекс-строка.
          3 кнопки в 3 колонки — один ряд, без переноса. Open Settings
          (случай permissionPane) здесь больше не появляется: четвёртая
          кнопка переносилась на второй ряд и ломала разметку — отказ в
          правах показывается модальным слоем ниже, как и «нет права на
          вставку». */}
      <div className="actions action-grid action-grid-3">
        <button className="primary" disabled={!hasText} onClick={onPaste}>
          Paste <span className="shortcut-badge">{formatShortcutBadge(pasteShortcut)}</span>
        </button>
        <button disabled={!hasText} onClick={onCopy}>
          {copied ? 'Copied' : (
            <>
              Copy <span className="shortcut-badge">{formatShortcutBadge(copyShortcut)}</span>
            </>
          )}
        </button>
        {/* Follow: открывает главное окно с текущим текстом, оверлей
            прячется (см. onFollow / follow_to_main_window в Rust). Тот же
            guard на пустой текст, что у Paste/Copy. */}
        <button disabled={!hasText} onClick={onFollow}>
          Follow <span className="shortcut-badge">{formatShortcutBadge(followShortcut)}</span>
        </button>
        {/* Journal — только при заданном в настройках пути: без него кнопка
            вела бы в ошибку, а не в файл. Вспышка «Saved» — как у Copy. */}
        {journalPath && (
          <button disabled={!hasText} onClick={onJournal}>
            {journaled ? 'Saved' : (
              <>
                Journal{' '}
                <span className="shortcut-badge">{formatShortcutBadge(JOURNAL_SHORTCUT)}</span>
              </>
            )}
          </button>
        )}
      </div>
      {/* Модальный слой "отказано в праве" (permissionPane) — перекрывает
          всю панель, как и слой Paste ниже: инлайн-кнопкой в сетке действий
          он переносился на второй ряд и ломал разметку. Тоже НЕ ловушка:
          Escape и Close закрывают слой, сообщение об ошибке остаётся в
          статусной строке панели (phase === 'error'). */}
      {permissionPane && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Permission required">
            <p className="modal-text">{error}</p>
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() => {
                  openPrivacyPane(permissionPane)
                  setPermissionPane(null)
                }}
              >
                Open Settings
              </button>
              <button onClick={() => setPermissionPane(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {/* Модальный слой "нет права на вставку" — перекрывает всю панель.
          Показывается сразу по нажатию Paste, когда право уже отсутствует
          (см. onPaste), не после попытки. НЕ ловушка: Escape (см. глобальный
          обработчик клавиш выше) и кнопка Close оба закрывают слой без
          побочных эффектов — копирование в буфер уже случилось до показа
          слоя и остаётся доступным по кнопке Copy независимо от него. */}
      {showAccessModal && (
        <div className="modal-backdrop" role="presentation">
          <div className="modal" role="dialog" aria-modal="true" aria-label="Accessibility permission required">
            <p className="modal-text">
              Slaive can't send keystrokes to other apps yet, so Paste can't insert the text
              automatically. The text is already on your clipboard — press Cmd+V to paste it
              manually, or turn on Accessibility access below to make Paste work directly.
            </p>
            <div className="modal-actions">
              <button
                className="primary"
                onClick={() => {
                  openPrivacyPane('accessibility')
                  setShowAccessModal(false)
                }}
              >
                Open Settings
              </button>
              <button onClick={() => setShowAccessModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
