import { invoke } from '@tauri-apps/api/core'

export type Settings = {
  hotkey: string
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
}

export type SettingsResponse = Settings & {
  /** C1.4: false, если последняя попытка зарегистрировать хоткей провалилась. */
  hotkeyOk: boolean
}

export const getSettings = () => invoke<SettingsResponse>('get_settings')
export const saveSettings = (settings: Settings) => invoke<void>('save_settings', { settings })
export const hideOverlay = () => invoke<void>('hide_overlay')

export type ModelInfo = { id: string; label: string; sizeMb: number }
export type Progress = { downloaded: number; total: number }

export const listModels = () => invoke<ModelInfo[]>('list_models')
export const downloadModel = (id: string) => invoke<string>('download_model', { id })

/** Downloads the (single, fixed) VAD model. No id — there is no size choice for it. */
export const downloadVadModel = () => invoke<string>('download_vad_model')

export const startRecording = () => invoke<void>('start_recording')
export const stopRecording = () => invoke<void>('stop_recording')

/** PCM последней завершённой записи (16 кГц моно) для воспроизведения через WebAudio. */
export const getLastRecording = () => invoke<number[] | null>('get_last_recording')

export const pasteText = (text: string) => invoke<void>('paste_text', { text })
export const copyText = (text: string) => invoke<void>('copy_text', { text })

export type PrivacyPane = 'automation' | 'accessibility'
export const openPrivacyPane = (pane: PrivacyPane) => invoke<void>('open_privacy_pane', { pane })

/** C1 / hotkey capture: разбирает строку через global-hotkey, не регистрируя её. */
export const validateHotkey = (hotkey: string) => invoke<void>('validate_hotkey', { hotkey })
