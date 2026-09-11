// Дерево действий главного окна — данные, а не разветвление в разметке (см.
// бриф): пятое действие или новый уровень подменю — это правка массива ниже,
// а не новая ветка JSX. MainWindow.tsx рендерит текущий уровень одним и тем
// же циклом по массиву узлов независимо от глубины (см. menu-state.ts).

/** Что уходит в run_ai_action — собирается здесь, из текущего текста поля
 *  (и, для 'prompt'-узлов, свободного запроса пользователя), а не в Rust:
 *  ai.rs ничего не знает о меню, оно лишь резолвит провайдера и шлёт то, что
 *  ему дали. */
export type AiActionRequest = { system: string; user: string }

/** Ключ настройки, в которой лежит хоткей этого действия (см. api.ts
 *  Settings и src-tauri/src/settings.rs). Живёт на самом узле дерева, а не в
 *  отдельной таблице «id → ключ»: иначе пятое действие пришлось бы добавлять
 *  в двух местах, и они разъехались бы молча — ровно та беда, ради которой
 *  дерево вообще стало данными. Есть только у корневых действий; у пунктов
 *  подменю хоткей позиционный и не хранится (см. action-shortcuts.ts). */
export type ActionShortcutKey =
  | 'translateShortcut'
  | 'askAiShortcut'
  | 'fixShortcut'
  | 'shortenShortcut'

export type LeafNode = {
  kind: 'leaf'
  id: string
  label: string
  shortcutKey?: ActionShortcutKey
  /** Выполняется сразу по клику — без промежуточного экрана. */
  buildRequest: (text: string) => AiActionRequest
}

export type PromptNode = {
  kind: 'prompt'
  id: string
  label: string
  placeholder: string
  shortcutKey?: ActionShortcutKey
  /** Как у LeafNode, но с дополнительным свободным запросом пользователя. */
  buildRequest: (text: string, query: string) => AiActionRequest
}

export type BranchNode = {
  kind: 'branch'
  id: string
  label: string
  shortcutKey?: ActionShortcutKey
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
const SHORTEN_SYSTEM =
  'You shorten the given text, keeping its meaning and tone. Reply with only the shortened text, nothing else — no explanations, no quotes around it.'
const translateSystem = (language: string) =>
  `You translate the given text to ${language}. Reply with only the translation, nothing else — no explanations, no quotes around it.`
const ASK_AI_SYSTEM =
  'You edit or answer questions about the given text as the user instructs, and reply with only the result text to use in place of the original — no explanations, no quotes around it.'

export const ACTION_TREE: MenuNode[] = [
  {
    kind: 'branch',
    id: 'translate',
    label: 'Translate',
    shortcutKey: 'translateShortcut',
    children: [
      leaf('translate-en', 'English', (text) => ({ system: translateSystem('English'), user: text })),
      leaf('translate-ru', 'Russian', (text) => ({ system: translateSystem('Russian'), user: text })),
    ],
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
  leaf('fix', 'Fix', (text) => ({ system: FIX_SYSTEM, user: text }), 'fixShortcut'),
  leaf('shorten', 'Shorten', (text) => ({ system: SHORTEN_SYSTEM, user: text }), 'shortenShortcut'),
]
