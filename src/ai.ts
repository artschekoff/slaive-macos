// Чистая логика раздела ИИ в настройках — то, что можно протестировать без
// DOM и без Tauri. Отображение (Settings.tsx) вызывает эти функции, но само
// в тестах не участвует — тот же принцип, что у shortcut.ts/ShortcutCapture.

export type AiProviderInfo = {
  id: string
  label: string
  implemented: boolean
  defaultBaseUrl: string
  exampleModel: string
}

export type ProviderConfig = {
  model: string
  baseUrl: string | null
}

export type AiSettings = {
  provider: string
  providers: Record<string, ProviderConfig>
}

/** Пустой/дефолтный конфиг для провайдера, у которого ещё нет записи в `providers`. */
export function emptyProviderConfig(): ProviderConfig {
  return { model: '', baseUrl: null }
}

/**
 * Адрес, на который реально уйдут запросы — то же правило, что и в
 * ai.rs::effective_base_url: пустая/отсутствующая настройка = дефолт
 * провайдера, иначе — введённое значение с обрезанным хвостовым слэшем.
 * Используется и для строки "к какому хосту пойдут запросы" в настройках
 * (обязательное требование брифа — конкретный хост, а не абстрактное «ИИ»).
 */
export function effectiveBaseUrl(info: Pick<AiProviderInfo, 'defaultBaseUrl'>, baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim()
  if (!trimmed) return info.defaultBaseUrl
  return trimmed.replace(/\/+$/, '')
}

/** Провайдер можно выбрать в UI только если бэкенд его реализовал. */
export function isSelectable(info: Pick<AiProviderInfo, 'implemented'> | undefined): boolean {
  return info?.implemented === true
}
