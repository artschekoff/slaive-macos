import { invoke } from '@tauri-apps/api/core'
import type { AiSettings } from './ai.ts'

export type Settings = {
  hotkey: string
  /** Глобальный хоткей захвата выделенного текста из чужого приложения. */
  captureHotkey: string
  modelPath: string | null
  language: 'auto' | 'ru' | 'en'
  /** Optional VAD model path. `null` means VAD is off — transcription still works. */
  vadModelPath: string | null
  /** Window-level shortcut (see shortcut.ts format) that pastes the transcript
   *  back into the source app. Not a global hotkey — only active while the
   *  overlay panel is open and focused. Default "Enter". */
  pasteShortcut: string
  /** Window-level shortcut that copies the transcript to the clipboard.
   *  Same scoping as pasteShortcut. Default "Super+KeyC" (Cmd+C). */
  copyShortcut: string
  /** Window-level shortcut that hands the transcript to the main window
   *  (the panel's Follow button). Same scoping as pasteShortcut, but a
   *  modifier is required: the panel catches it on the capture phase and stops
   *  it there, so a bare key would be taken away from the Vim editor.
   *  Default "Super+KeyF" (Cmd+F) — Cmd+F is also Fix in the main window, but
   *  Follow lives in the panel and Fix in the main window, and only one
   *  window is focused at a time, so the two never fire together. */
  followShortcut: string
  /** Window-level shortcuts for the main window's action menu (see
   *  action-shortcuts.ts). Same scoping as pasteShortcut/copyShortcut: they
   *  only fire while the main window is focused, never system-wide. */
  translateShortcut: string
  askAiShortcut: string
  fixShortcut: string
  shortenShortcut: string
  summarizeShortcut: string
  /** Window-level shortcut for the main window's Paste button. Separate from
   *  `pasteShortcut` only because of the key, not the action: the overlay's
   *  default is a bare Enter, which its editor hands to a Vim action; the main
   *  window has no such action, so a bare Enter there would mean what it means
   *  in any editor — a new line. Default "Super+Enter" (Cmd+Return). */
  mainPasteShortcut: string
  /** Window-level shortcut for Accept — the step that makes the model's
   *  proposal the text for good. Deliberately stiffer than Paste: accepting
   *  replaces what the user had, and the previous text is then only reachable
   *  through the editor's Undo. Default "Shift+Super+Enter" (Shift+Cmd+Return).
   *  Its counterpart Cancel is Escape and is not stored — see ESCAPE_SHORTCUT
   *  in action-shortcuts.ts. */
  acceptShortcut: string
  /** AI provider settings — model + base URL per provider. Keys live in the
   *  Keychain, never here (see `aiKeySet` below and `set_ai_key`). */
  ai: AiSettings
  /** Target languages of the main window's Translate submenu, as plain names
   *  separated by commas or newlines — "English, Spanish, Russian". Not ISO
   *  codes: the model reads a name just as well, and a name list is editable in
   *  one field. The submenu is built from this at render time (see
   *  `buildActionTree`), so editing it changes the menu with no code change.
   *  Empty means "not chosen" and falls back to the three defaults — an empty
   *  list could only produce a dead submenu. */
  translateLanguages: string
  /** Microphone gain multiplier applied to the PCM handed to VAD and whisper.
   *  Never applied to the level track — that one keeps showing the raw signal
   *  (see `apply_gain` in audio.rs). 1.0 = untouched, range 0.5–10. */
  micGain: number
  /** Speech detection threshold for VAD (Silero), 0.1–0.9, default 0.5 (the
   *  whisper.cpp default). NOT microphone sensitivity — that's `micGain`. */
  vadThreshold: number
  /** Recording device name as `cpal` reports it. `null` = "System default",
   *  meaning follow the system — NOT "pin to whatever is default today". */
  inputDevice: string | null
  /** How opaque the app's windows are, 0.5–1.0, default 0.9. Applied as the
   *  native window alpha (`NSWindow.alphaValue`), so it covers the whole
   *  window — web content, the native title bar and the shadow alike — not
   *  just what CSS can reach. One value for all three windows.
   *
   *  The floor is 0.5 on purpose: below that, text stops reading against a
   *  busy wallpaper and the window itself stops being distinguishable from
   *  whatever is behind it. */
  windowOpacity: number
  /** User's term list, fed to whisper's `initial_prompt` (see
   *  `whisper::initial_prompt`). Empty = the parameter isn't passed at all. */
  dictionary: string
}

export type SettingsResponse = Settings & {
  /** C1.4: false, если последняя попытка зарегистрировать хоткей провалилась. */
  hotkeyOk: boolean
  /** provider id -> whether a key is stored for it in the Keychain. The key
   *  itself never appears here or anywhere else in the frontend. */
  aiKeySet: Record<string, boolean>
  /** Peak amplitude of the last recording BEFORE gain — the reference point
   *  for the gain slider. `null` until something has been recorded in this
   *  run. Updated live through the `rec:peak` event while Settings is open. */
  lastPeak: number | null
}

export const getSettings = () => invoke<SettingsResponse>('get_settings')
export const saveSettings = (settings: Settings) => invoke<void>('save_settings', { settings })
export const hideOverlay = () => invoke<void>('hide_overlay')

/** Applies window opacity right away, without writing anything to disk — the
 *  slider calls this on every move. A visual setting judged by eye can't ask
 *  the user to save first and look second. Saving still happens the ordinary
 *  way, through `saveSettings` with the rest of the form. */
export const setWindowOpacity = (opacity: number) =>
  invoke<void>('set_window_opacity', { opacity })

/** `missing` — no file on disk; `downloaded` — file present but another model
 *  is in use; `active` — this is the one transcription runs on. Decided from
 *  the file on disk, never from the settings entry: the file may have been
 *  deleted outside the app. */
export type ModelState = 'missing' | 'downloaded' | 'active'

export type ModelEntry = {
  id: string
  label: string
  /** What this model is actually like in practice — the line that helps pick. */
  note: string
  /** Size in the repository, bytes (verified against huggingface metadata). */
  sizeBytes: number
  state: ModelState
  /** Real size on disk, present only when the file exists. */
  diskBytes: number | null
  path: string | null
}

export type VadEntry = {
  label: string
  note: string
  sizeBytes: number
  downloaded: boolean
  diskBytes: number | null
}

export type ModelCatalog = {
  models: ModelEntry[]
  vad: VadEntry
  /** Total taken by the models folder, bytes. */
  diskBytes: number
  modelsDir: string
}

export type Progress = { downloaded: number; total: number }

export const listModels = () => invoke<ModelCatalog>('list_models')
export const downloadModel = (id: string) => invoke<string>('download_model', { id })

/** Makes an already-downloaded model the active one — writes its path into
 *  settings. Replaces hand-editing the model path. */
export const useModel = (id: string) => invoke<string>('use_model', { id })

/** Deletes a downloaded model. Refuses on the active one — the app would be
 *  left without transcription. No confirmation: it re-downloads with one click. */
export const deleteModel = (id: string) => invoke<void>('delete_model', { id })

/** Downloads the (single, fixed) VAD model. No id — there is no size choice for it. */
export const downloadVadModel = () => invoke<string>('download_vad_model')

export type InputDevices = {
  devices: string[]
  /** Name of the current system default — a caption for the "System default"
   *  entry only. Picking it never pins that name into settings. */
  defaultDevice: string | null
}

/** Enumerates recording devices. Called on demand (a Refresh button), not once
 *  at startup: an iPhone comes and goes, and that can't require a restart. */
export const listInputDevices = () => invoke<InputDevices>('list_input_devices')

export const startRecording = () => invoke<void>('start_recording')
export const stopRecording = () => invoke<void>('stop_recording')

/** PCM последней завершённой записи (16 кГц моно) для воспроизведения через WebAudio. */
export const getLastRecording = () => invoke<number[] | null>('get_last_recording')

/** Tells the backend whether the overlay editor currently holds any text.
 *  Only the boolean — the transcript itself never crosses this boundary.
 *  Together with overlay window visibility this is the whole append rule
 *  (see `is_append_session` in commands.rs). */
export const setOverlayHasText = (hasText: boolean) =>
  invoke<void>('set_overlay_has_text', { hasText })

export const pasteText = (text: string) => invoke<void>('paste_text', { text })
export const copyText = (text: string) => invoke<void>('copy_text', { text })

export type PrivacyPane = 'automation' | 'accessibility'
export const openPrivacyPane = (pane: PrivacyPane) => invoke<void>('open_privacy_pane', { pane })

/** C1 / hotkey capture: разбирает строку через global-hotkey, не регистрируя её. */
export const validateHotkey = (hotkey: string) => invoke<void>('validate_hotkey', { hotkey })

export const listAiProviders = () => invoke<import('./ai.ts').AiProviderInfo[]>('list_ai_providers')

/** Кладёт ключ провайдера в Keychain. Ключ никогда не читается обратно —
 *  только признак "задан" через `getSettings().aiKeySet`. */
export const setAiKey = (provider: string, key: string) =>
  invoke<void>('set_ai_key', { provider, key })

/** Кнопка "Проверить связь": короткий пробный запрос к текущему провайдеру.
 *  Единственное место в настройках, откуда уходит реальный сетевой запрос к
 *  ИИ — только по явному нажатию. */
export const testAiConnection = () => invoke<string>('test_ai_connection')

/** Действие меню главного окна (Translate/Ask AI/Fix/Shorten/Summarize) —
 *  единственная сетевая точка входа этого окна, вызывается ТОЛЬКО по явному нажатию
 *  действия (см. бриф главного окна: ни при открытии окна, ни при получении
 *  текста запросов быть не должно). system/user собираются во фронтенде
 *  (см. action-tree.ts) — сама команда лишь резолвит провайдера и шлёт запрос. */
export const runAiAction = (system: string, user: string) =>
  invoke<string>('run_ai_action', { system, user })

/** Прерывает текущий запрос к ИИ. Без этого Cancel отпускал бы только
 *  интерфейс, а HTTP доигрывал бы в фоне, списывая токены за ответ, который
 *  никто не увидит. */
export const cancelAiAction = () => invoke<void>('cancel_ai_action')

/** Право на отправку синтетических нажатий (Accessibility) — тот же
 *  источник правды, что использует paste_text перед реальной попыткой.
 *  Overlay зовёт это ДО paste_text, чтобы решить, показывать ли модальный
 *  слой сразу, не проходя через заведомо провальную попытку вставки. */
export const checkAccessibilityPermission = () => invoke<boolean>('check_accessibility_permission')

/** Открывает окно настроек — используется кнопками "Open Settings" вне
 *  оверлея (модальный слой права уже использует openPrivacyPane напрямую;
 *  эта команда — для мест, которым нужно окно целиком, а не конкретный
 *  раздел System Settings, например баннер ошибки провайдера в главном окне). */
export const openSettingsWindow = () => invoke<void>('open_settings_window')

/** Follow из оверлея: главное окно получает текущий текст и поднимается
 *  наверх, оверлей прячется. См. follow_to_main_window в Rust — окно-синглтон,
 *  второе не создаётся. */
export const followToMainWindow = (text: string) => invoke<void>('follow_to_main_window', { text })

/** Name and icon of the app the dictation came from — the same `prev_app_pid`
 *  `paste_text` restores focus to, resolved the same way the overlay's header
 *  is resolved (no AppleScript, no permission prompt).
 *
 *  `null` means there is no target at all: either the window was opened
 *  without a preceding dictation, or that app has quit since. Both show the
 *  same way — an explanatory header and a disabled Paste button. */
export type SourceApp = { name: string; icon: string | null }
export const getSourceApp = () => invoke<SourceApp | null>('get_source_app')

/** One entry of the transcript history, as it is stored on disk (one JSON
 *  object per line in `history.jsonl`). The audio is never stored — only the
 *  text, when it happened and how long the recording was.
 *
 *  `id` is the creation time in UTC milliseconds and doubles as the
 *  identifier (see `history.rs`): unique, human-readable in the file itself,
 *  and it needs neither a uuid dependency nor a counter on disk. */
export type HistoryEntry = {
  id: number
  text: string
  /** Seconds of audio behind this text. On an append session this covers the
   *  whole accumulated recording, matching the accumulated text. */
  durationSecs: number
}

/** Reads the history, newest first — the order the tile grid shows it in. */
export const listHistory = () => invoke<HistoryEntry[]>('list_history')

/** Appends one transcript to the history. Called by the overlay right after a
 *  transcript lands in its editor, not by the backend: on an append session
 *  the resulting text exists only in the editor document (the backend sends
 *  just the new fragment, so hand edits survive), and the history must hold
 *  the resulting text. Failed or too-short recordings never reach this, since
 *  the overlay only calls it on a `transcript` event.
 *
 *  Returns the id of the new entry. The overlay keeps it for the rest of the
 *  session and grows that one entry with `updateHistoryEntry` instead of
 *  writing a second, near-identical tile per append. */
export const addHistoryEntry = (text: string, durationSecs: number) =>
  invoke<number>('add_history_entry', { text, durationSecs })

/** Replaces the text and duration of the session's existing entry, so one
 *  dictation session is one history tile however many times it was appended
 *  to. Returns the id the text now lives under — normally the same one, but a
 *  new one if the entry had been deleted or evicted meanwhile.
 *
 *  Only ever called when a new transcript arrives. Hand edits never reach it:
 *  the history records what was said, not what the document currently says. */
export const updateHistoryEntry = (id: number, text: string, durationSecs: number) =>
  invoke<number>('update_history_entry', { id, text, durationSecs })

/** Dictionary size against whisper's prompt budget, counted by the tokenizer
 *  of the selected model — not estimated from length. There is no second
 *  estimate on this side any more: measured on a real model, characters per
 *  token range from 1.5 (acronym lists) to 6.2 (English prose), so any
 *  length-based formula is off by up to 2x in both directions.
 *
 *  `tokens` is null when no model is installed, which is the one case nothing
 *  can be counted — and also the case where the dictionary is unused anyway.
 *  The call can take a second the first time: it loads the model into the
 *  same cache transcription uses. */
export type PromptBudget = { tokens: number | null; max: number }
export const countPromptTokens = (dictionary: string) =>
  invoke<PromptBudget>('count_prompt_tokens', { dictionary })

export const deleteHistoryEntry = (id: number) => invoke<void>('delete_history_entry', { id })

/** Wipes the history. Irreversible — the UI asks for confirmation first. */
export const clearHistory = () => invoke<void>('clear_history')

/** Убирает главное окно и возвращает Dock-иконку (activation policy) в
 *  Accessory — тот же путь, которым окно уходит по крестику (см.
 *  hide_main_window в Rust). Зовётся после успешной вставки. */
export const hideMainWindow = () => invoke<void>('hide_main_window')
