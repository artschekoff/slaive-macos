import { invoke } from '@tauri-apps/api/core'

export type Settings = {
  hotkey: string
  modelPath: string | null
  language: 'auto' | 'ru' | 'en'
}

export const getSettings = () => invoke<Settings>('get_settings')
export const saveSettings = (settings: Settings) => invoke<void>('save_settings', { settings })
export const hideOverlay = () => invoke<void>('hide_overlay')
