import { invoke } from '@tauri-apps/api/core'

export type Settings = {
  hotkey: string
  modelPath: string | null
  language: 'auto' | 'ru' | 'en'
}

export const getSettings = () => invoke<Settings>('get_settings')
export const saveSettings = (settings: Settings) => invoke<void>('save_settings', { settings })
export const hideOverlay = () => invoke<void>('hide_overlay')

export type ModelInfo = { id: string; label: string; sizeMb: number }
export type Progress = { downloaded: number; total: number }

export const listModels = () => invoke<ModelInfo[]>('list_models')
export const downloadModel = (id: string) => invoke<string>('download_model', { id })

export const startRecording = () => invoke<void>('start_recording')
export const stopRecording = () => invoke<void>('stop_recording')
