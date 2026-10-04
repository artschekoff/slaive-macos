// Дерево действий главного окна — данные, а не разветвление в разметке (см.
// бриф): шестое действие или новый уровень подменю — это правка массива ниже,
// а не новая ветка JSX. MainWindow.tsx рендерит текущий уровень одним и тем
// же циклом по массиву узлов независимо от глубины (см. menu-state.ts).

/** Что уходит в run_ai_action — собирается здесь, из текущего текста поля
 *  (и, для 'prompt'-узлов, свободного запроса пользователя), а не в Rust:
 *  ai.rs ничего не знает о меню, оно лишь резолвит провайдера и шлёт то, что
 *  ему дали. */
export type AiActionRequest = { system: string; user: string }

/** Ключ настройки, в которой лежит хоткей этого действия (см. api.ts
 *  Settings и src-tauri/src/settings.rs). Живёт на самом узле дерева, а не в
 *  отдельной таблице «id → ключ»: иначе новое действие пришлось бы добавлять
 *  в двух местах, и они разъехались бы молча — ровно та беда, ради которой
 *  дерево вообще стало данными. Есть только у корневых действий; у пунктов
 *  подменю хоткей позиционный и не хранится (см. action-shortcuts.ts). */
export type ActionShortcutKey =
  | 'translateShortcut'
  | 'askAiShortcut'
  | 'generateShortcut'
  | 'fixShortcut'
  | 'shortenShortcut'
  | 'summarizeShortcut'

export type LeafNode = {
  kind: 'leaf'
  id: string
  label: string
  shortcutKey?: ActionShortcutKey
  /** Действию не нужен текст в поле: оно доступно и на пустом редакторе.
   *  По умолчанию (undefined) текст обязателен — Fix/Translate и прочим
   *  без текста нечего обрабатывать. Сейчас флаг несёт только Generate. */
  worksOnEmpty?: boolean
  /** Выполняется сразу по клику — без промежуточного экрана. */
  buildRequest: (text: string) => AiActionRequest
}

export type PromptNode = {
  kind: 'prompt'
  id: string
  label: string
  placeholder: string
  shortcutKey?: ActionShortcutKey
  /** См. LeafNode.worksOnEmpty. Для prompt-узла флаг значит ещё и «запрос
   *  необязателен»: Generate можно запускать вовсе без входных данных. */
  worksOnEmpty?: boolean
  /** Как у LeafNode, но с дополнительным свободным запросом пользователя. */
  buildRequest: (text: string, query: string) => AiActionRequest
}

export type BranchNode = {
  kind: 'branch'
  id: string
  label: string
  shortcutKey?: ActionShortcutKey
  worksOnEmpty?: boolean
  children: MenuNode[]
}

export type MenuNode = LeafNode | PromptNode | BranchNode

function leaf(
  id: string,
  label: string,
  buildRequest: LeafNode['buildRequest'],
  shortcutKey?: ActionShortcutKey
): LeafNode {
  return { kind: 'leaf', id, label, buildRequest, shortcutKey }
}

// Системные промпты — по одному на действие, коротко и однозначно: модель
// должна вернуть ТОЛЬКО текст замены, без комментариев и кавычек вокруг
// него — MainWindow подставляет ответ в поле как есть (см. run_ai_action).
const FIX_SYSTEM =
  'You fix grammar, spelling and punctuation in the given text. Reply with only the corrected text, nothing else — no explanations, no quotes around it.'

// Shorten и Summarize — РАЗНЫЕ работы над надиктованным текстом, и вся
// разница держится на этих двух промптах: первый оставляет текст текстом
// пользователя, только без воды ("я надиктовал сообщение, подчисти его"),
// второй вытаскивает суть и переписывает её своими словами ("я говорил
// десять минут, дай выжимку"). Если эти формулировки сблизить, две кнопки
// начнут выдавать одно и то же и одна из них станет лишней.
const SHORTEN_SYSTEM =
  'You tighten the given text without rewriting it. Cut filler, false starts, ' +
  'repetition and padding; keep the author’s own words, tone and order of ideas, so the ' +
  'result still reads as their sentences with the slack taken out. Do not restructure it ' +
  'into a list, do not generalize, and do not drop any point they made. Reply with only ' +
  'the tightened text, nothing else — no explanations, no quotes around it.'
const SUMMARIZE_SYSTEM =
  'You summarize the given text: work out what it is actually about and state that ' +
  'substance in your own words. Rephrasing freely is expected — do not try to preserve the ' +
  'author’s sentences. Give a few short bullet points, one idea each, or two or three ' +
  'sentences when there is only one idea; leave out asides, examples and repetition that ' +
  'carry no point. Reply with only the summary, nothing else — no explanations, no ' +
  'preamble, no quotes around it.'

const translateSystem = (language: string) =>
  `You translate the given text to ${language}. Reply with only the translation, nothing else — no explanations, no quotes around it.`
const ASK_AI_SYSTEM =
  'You edit or answer questions about the given text as the user instructs, and reply with only the result text to use in place of the original — no explanations, no quotes around it.'

// Generate — обратная роль текста поля: не объект действия, а сама
// инструкция. Пользователь нажал хоткей захвата без выделения (курсор стоит
// в поле ввода), окно открылось пустым, он надиктовал «напиши Дэну, что я
// опаздываю» — и по этой инструкции модель пишет готовый текст для вставки.
// Работает и совсем с нуля: поле пустое, опциональный сид (тема/набросок/
// стиль) вводится в prompt-строке, а при пустом сиде модель пишет короткую
// нейтральную заготовку.
const GENERATE_SYSTEM =
  'The given text is the user’s request, usually dictated by voice: write the text it asks ' +
  'for, in the language the request implies. If the request is empty, write a short ' +
  'neutral placeholder paragraph. Reply with only the text to insert — no ' +
  'explanations, no preamble, no quotes around it.'

/** Дефолтные языки перевода — та же строка, что в Settings::default() на
 *  бэкенде (src-tauri/src/settings.rs, DEFAULT_TRANSLATE_LANGUAGES). Здесь она
 *  в двух ролях: заглушка до первого ответа get_settings и запасной список,
 *  когда поле настройки пусто (см. buildActionTree). */
export const DEFAULT_TRANSLATE_LANGUAGES = 'English, Spanish, Russian'

/**
 * Разбирает поле настроек в список языков.
 *
 * Хранятся обычные НАЗВАНИЯ ("English, Spanish, Russian"), а не ISO-коды и не
 * выбор из каталога: модель одинаково понимает и то и другое, а название
 * правится в одном текстовом поле — каталог на две сотни языков ради трёх
 * нужных стоил бы отдельного экрана выбора и ничего бы не дал.
 *
 * Разделители — и запятая, и перевод строки, как у словаря терминов: писать
 * список в столбик так же естественно, как в строку, и заставлять выбирать
 * один способ незачем. Повторы отбрасываются по названию без учёта регистра —
 * иначе два одинаковых пункта заняли бы два номера ⌘1…⌘9 и получили бы
 * одинаковый id (он же ключ React-списка).
 */
export function parseLanguageList(raw: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,\n]/)) {
    const name = part.trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/**
 * Дерево действий для заданного списка языков перевода.
 *
 * Строится на КАЖДЫЙ рендер главного окна из настройки (см. MainWindow.tsx),
 * поэтому правка списка в настройках меняет подменю Translate без единой
 * строки кода — ровно то, ради чего меню и сделано данными.
 *
 * Пустой список подменю не даёт: берётся дефолт. Пустая настройка означает
 * «не выбрано», а не «переводить некуда» — второго смысла у списка целевых
 * языков просто нет, и единственное, что можно из него построить, — мёртвый
 * пункт меню. Выключенная кнопка Translate с объяснением стоила бы новой
 * ветки в разметке и нового состояния у узла ради случая, у которого нет
 * полезного исхода; дефолт не стоит ничего и всегда оставляет меню рабочим.
 * Настройка при этом НЕ переписывается: очищенное поле остаётся очищенным
 * (см. settings.rs), а подсказка рядом с ним прямо говорит, что тогда
 * действуют три языка по умолчанию.
 */
export function buildActionTree(rawLanguages: string = DEFAULT_TRANSLATE_LANGUAGES): MenuNode[] {
  const parsed = parseLanguageList(rawLanguages)
  const languages = parsed.length > 0 ? parsed : parseLanguageList(DEFAULT_TRANSLATE_LANGUAGES)
  return [
    {
      kind: 'branch',
      id: 'translate',
      label: 'Translate',
      shortcutKey: 'translateShortcut',
      // id пункта — из самого названия, а не из его позиции: список после
      // дедупликации уникален по названию без учёта регистра, поэтому id тоже
      // уникален, а ключ уровня в MainWindow (он собирается из id) меняется
      // при правке списка, а не остаётся прежним при новом составе кнопок.
      children: languages.map((language) =>
        leaf(`translate-${language.toLowerCase()}`, language, (text) => ({
          system: translateSystem(language),
          user: text,
        }))
      ),
    },
    {
      kind: 'prompt',
      id: 'ask-ai',
      label: 'Ask AI',
      shortcutKey: 'askAiShortcut',
      placeholder: 'e.g. make this more formal',
      buildRequest: (text, query) => ({
        system: ASK_AI_SYSTEM,
        user: `Instruction: ${query}\n\nText:\n${text}`,
      }),
    },
    {
      kind: 'prompt',
      id: 'generate',
      label: 'Generate',
      shortcutKey: 'generateShortcut',
      worksOnEmpty: true,
      placeholder: 'optional seed: topic, draft or style',
      // Сид и надиктованный текст складываются в один запрос: сид первым —
      // это уточнение сверху («деловым тоном»), текст поля — сама инструкция
      // или черновик. Любая из частей может отсутствовать.
      buildRequest: (text, query) => ({
        system: GENERATE_SYSTEM,
        user: [query.trim(), text.trim()].filter(Boolean).join('\n\n'),
      }),
    },
    leaf('fix', 'Fix', (text) => ({ system: FIX_SYSTEM, user: text }), 'fixShortcut'),
    leaf('shorten', 'Shorten', (text) => ({ system: SHORTEN_SYSTEM, user: text }), 'shortenShortcut'),
    leaf(
      'summarize',
      'Summarize',
      (text) => ({ system: SUMMARIZE_SYSTEM, user: text }),
      'summarizeShortcut'
    ),
  ]
}

/** Дерево с языками по умолчанию. Используется как состояние до первого
 *  ответа get_settings и как опора тестов; живое окно строит своё дерево из
 *  настройки (см. buildActionTree выше). */
export const ACTION_TREE: MenuNode[] = buildActionTree()
