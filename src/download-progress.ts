// Состояние скачивания модели: сколько скачано, с какой скоростью и как это
// подписать. Чистое, без React и DOM, — по той же причине, что levels.ts и
// shortcut-conflicts.ts: `npm test` гоняет node --test прямо по .ts, а
// проверять расчёт скорости на живой загрузке в 1.6 ГБ нельзя ни быстро, ни
// повторяемо. Краевые случаи здесь настоящие: два события в одну миллисекунду
// (деление на ноль), одиночный выброс от буферизации (скорость прыгает в
// десять раз), обрыв (индикатор не должен остаться висеть).
//
// Свой тип замера, а не импорт из api.ts: тот тянет @tauri-apps/api, которого
// в node --test нет.

import { formatBytes } from './format.ts'

/** Полезная нагрузка события `model:progress` / `vad:progress`.
 *  `total` равен нулю, когда сервер не прислал Content-Length. */
export type Progress = { downloaded: number; total: number }

/** Замер с меткой времени ПРИЁМА. Время ставит фронт: в событии его нет, да и
 *  нужна задержка до получения, а не до отправки. */
export type Sample = { downloaded: number; at: number }

/**
 * Ширина окна усреднения скорости.
 *
 * Мгновенная скорость (приращение между соседними событиями) нечитаема:
 * model.rs шлёт событие каждый набежавший мегабайт, а мегабайты приходят
 * рывками — то три события подряд в одну миллисекунду из буфера, то пауза на
 * секунду. Число скакало бы от 2 MB/s до 400 MB/s и обратно по нескольку раз
 * в секунду.
 *
 * Усредняем скользящим окном, а не экспоненциальным сглаживанием по
 * мгновенным замерам, именно из-за такой пачки: EMA видит подряд несколько
 * огромных мгновенных значений и успевает на них взобраться, а потом рушится
 * на паузе. Окно же делит набежавшие байты на настоящее прошедшее время, и
 * пачка в него просто попадает целиком — выброс в сто крат по мгновенной
 * скорости сдвигает показанное меньше чем вдвое (см. тест про выброс).
 *
 * Байтовых выбросов здесь не бывает по построению: model.rs шлёт событие на
 * каждый набежавший мегабайт, то есть приращение на событие ограничено
 * сверху. Выброс может быть только временнЫм, а с ним окно и справляется.
 *
 * Считаем по краям окна — (байты последнего − байты первого) /
 * (время последнего − время первого), — промежуточные замеры в эту разность
 * входят и так.
 */
export const SPEED_WINDOW_MS = 2_000

/** Одна идущая загрузка. `null` снаружи означает «ничего не качается». */
export type Download = {
  /** Что качается — подпись индикатора. */
  label: string
  downloaded: number
  /** 0 — длина неизвестна, процент считать не из чего. */
  total: number
  /** Замеры внутри окна усреднения, от старого к новому. */
  samples: readonly Sample[]
  /** null, пока считать не из чего (меньше двух замеров в окне). */
  bytesPerSecond: number | null
}

export type DownloadEvent =
  | { type: 'start'; label: string }
  | { type: 'progress'; at: number; progress: Progress }
  /** Успешное завершение и отказ гасят индикатор ОДИНАКОВО: разница видна по
   *  строке ошибки рядом, а полоса в обоих случаях больше не про «идёт». */
  | { type: 'done' }
  | { type: 'error' }

/**
 * Переход состояния по событию. Вся логика «когда индикатор появляется и
 * когда гаснет» живёт здесь, а не в обработчиках Settings.tsx, чтобы сброс
 * при ошибке проверялся тестом: до этого полоса VAD после неудачной загрузки
 * оставалась на экране до перезапуска окна — событий больше нет, а гасить её
 * было некому.
 */
export function reduceDownload(state: Download | null, event: DownloadEvent): Download | null {
  switch (event.type) {
    case 'start':
      return { label: event.label, downloaded: 0, total: 0, samples: [], bytesPerSecond: null }
    case 'done':
    case 'error':
      return null
    case 'progress': {
      // Замер без начала — опоздавшее событие уже завершённой загрузки.
      // Воскрешать по нему индикатор нельзя: гасить его будет нечему.
      if (!state) return null
      const samples = pushSample(state.samples, {
        downloaded: event.progress.downloaded,
        at: event.at,
      })
      // Не посчиталось — держим прежнее число, а не мигаем пустотой:
      // «скорость на мгновение исчезла» читается как сбой.
      const fresh = speedFrom(samples)
      return {
        ...state,
        downloaded: event.progress.downloaded,
        total: event.progress.total,
        samples,
        bytesPerSecond: fresh ?? state.bytesPerSecond,
      }
    }
  }
}

/** Добавляет замер и выбрасывает вышедшие из окна. Два последних остаются
 *  всегда: на медленной сети события реже окна, и после отсечения по времени
 *  не осталось бы пары, из которой вообще можно считать. */
export function pushSample(samples: readonly Sample[], next: Sample): Sample[] {
  const all = [...samples, next]
  const cutoff = next.at - SPEED_WINDOW_MS
  let first = 0
  while (first < all.length - 2 && all[first].at < cutoff) first++
  return all.slice(first)
}

/** Скорость в байтах в секунду по краям окна. `null` — считать не из чего:
 *  один замер, нулевой интервал времени (два события в одну миллисекунду) или
 *  счётчик не вырос. */
export function speedFrom(samples: readonly Sample[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  const seconds = (last.at - first.at) / 1000
  const bytes = last.downloaded - first.downloaded
  if (!(seconds > 0) || !(bytes > 0)) return null
  return bytes / seconds
}

/** Доля в процентах, 0…100. `null` — длина неизвестна. */
export function percentOf(downloaded: number, total: number): number | null {
  if (!(total > 0) || !Number.isFinite(downloaded)) return null
  return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)))
}

/**
 * Скорость человеческими единицами. Десятичные приставки — как в formatBytes
 * и как считает сам huggingface, иначе «1.6 GB за 12.4 MB/s» не сходилось бы
 * в уме.
 *
 * Один знак у мегабайтов и ноль у остальных: «12.4 MB/s» несёт смысл,
 * «847.3 KB/s» — нет. Пусто, если считать нечего: подпись рядом с полосой
 * тогда просто не показывается.
 */
export function formatSpeed(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return ''
  if (bytesPerSecond >= 1_000_000) return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`
  if (bytesPerSecond >= 1_000) return `${Math.round(bytesPerSecond / 1_000)} KB/s`
  return `${Math.round(bytesPerSecond)} B/s`
}

// ponytail: оценки оставшегося времени нет, и это решение, а не пропуск.
// Событие прогресса привязано к объёму (мегабайт скачан — событие ушло), а не
// ко времени, поэтому чем медленнее сеть, тем реже замеры: ровно там, где
// обратный отсчёт нужнее всего, в окне лежит одна пара точек и оценка скачет
// с «2 минуты» на «40 секунд» и обратно. Прыгающий отсчёт хуже отсутствующего:
// его читают как обещание. Добавлять, если model.rs начнёт слать события ещё
// и по таймеру (тогда частота замеров перестанет зависеть от скорости) —
// вместе с порогом «показывать, только если скорость держится в пределах
// ±20% окна».

/** Строка под полосой: сколько из скольки и с какой скоростью. */
export function progressLabel(d: Download): string {
  const speed = formatSpeed(d.bytesPerSecond)
  const amount =
    d.total > 0
      ? `${formatBytes(d.downloaded)} of ${formatBytes(d.total)}`
      : // Без Content-Length полосы нет, но счётчик байт хотя бы показывает,
        // что загрузка не встала (I9).
        `${formatBytes(d.downloaded)} downloaded`
  return speed ? `${amount} · ${speed}` : amount
}

/** Сводка для индикатора в левом столбце. `null` — ничего не качается. */
export type DownloadSummary = {
  /** null — хотя бы у одной загрузки неизвестна длина, общий процент считать не из чего. */
  percent: number | null
  /** Готовая строка скорости или пусто. */
  speed: string
  /** Подпись: что именно качается. */
  label: string
}

/**
 * Сводит идущие загрузки в одну строку. Их может быть две одновременно —
 * кнопка Download у VAD не заблокирована во время загрузки модели whisper, —
 * и тогда индикатор показывает общий прогресс по сумме байт, а не прогресс
 * одной из них: «48%» рядом с пунктом Models отвечает на вопрос «сколько
 * осталось ждать вообще», а не «сколько осталось у той, которую я выбрал
 * первой».
 */
export function summarize(downloads: readonly (Download | null)[]): DownloadSummary | null {
  const active = downloads.filter((d): d is Download => d !== null)
  if (active.length === 0) return null

  const downloaded = active.reduce((sum, d) => sum + d.downloaded, 0)
  // Общая длина имеет смысл, только если известна у всех: иначе процент врал
  // бы в большую сторону на неучтённых байтах.
  const total = active.every((d) => d.total > 0) ? active.reduce((sum, d) => sum + d.total, 0) : 0
  const speed = active.reduce<number | null>(
    (sum, d) => (d.bytesPerSecond === null ? sum : (sum ?? 0) + d.bytesPerSecond),
    null
  )

  return {
    percent: percentOf(downloaded, total),
    speed: formatSpeed(speed),
    label: active.length === 1 ? active[0].label : `${active.length} downloads`,
  }
}
