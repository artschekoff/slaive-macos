import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatSpeed,
  percentOf,
  progressLabel,
  pushSample,
  reduceDownload,
  speedFrom,
  summarize,
  SPEED_WINDOW_MS,
  type Download,
} from './download-progress.ts'

const MB = 1_000_000

/** Прогоняет последовательность замеров через редьюсер, как это делает
 *  обработчик события в Settings.tsx. Времена — миллисекунды от начала. */
function run(steps: readonly { at: number; downloaded: number; total?: number }[]): Download {
  let state = reduceDownload(null, { type: 'start', label: 'large-v3-turbo' })
  for (const step of steps) {
    state = reduceDownload(state, {
      type: 'progress',
      at: step.at,
      progress: { downloaded: step.downloaded, total: step.total ?? 1_624_555_275 },
    })
  }
  assert.ok(state)
  return state
}

test('скорость: пара замеров даёт приращение, делённое на время', () => {
  assert.equal(speedFrom([{ downloaded: 0, at: 0 }, { downloaded: 4 * MB, at: 1000 }]), 4 * MB)
  // Полсекунды на мегабайт — два мегабайта в секунду.
  assert.equal(speedFrom([{ downloaded: MB, at: 2000 }, { downloaded: 2 * MB, at: 2500 }]), 2 * MB)
})

test('скорость: нулевой интервал времени не даёт ни деления на ноль, ни бесконечности', () => {
  // Два события в одну миллисекунду — обычное дело, когда мегабайты выходят
  // из буфера пачкой.
  const speed = speedFrom([{ downloaded: MB, at: 7000 }, { downloaded: 3 * MB, at: 7000 }])
  assert.equal(speed, null)
})

test('скорость: одного замера и отката счётчика не хватает для ответа', () => {
  assert.equal(speedFrom([{ downloaded: MB, at: 0 }]), null)
  assert.equal(speedFrom([]), null)
  // Счётчик не вырос — делать вид, что скорость нулевая, нечестно: показывать
  // «0 B/s» на живой загрузке хуже, чем не показывать ничего.
  assert.equal(speedFrom([{ downloaded: 5 * MB, at: 0 }, { downloaded: 5 * MB, at: 1000 }]), null)
  assert.equal(speedFrom([{ downloaded: 5 * MB, at: 0 }, { downloaded: 4 * MB, at: 1000 }]), null)
})

test('скорость: нулевой интервал в живой последовательности сохраняет прежнее число', () => {
  // Ровный ход 2 MB/s, затем два события в одну миллисекунду.
  const state = run([
    { at: 0, downloaded: 0 },
    { at: 500, downloaded: MB },
    { at: 1000, downloaded: 2 * MB },
    { at: 1000, downloaded: 3 * MB },
  ])
  assert.ok(state.bytesPerSecond !== null)
  // Прежнее значение осталось, а не обнулилось и не стало Infinity.
  assert.ok(Number.isFinite(state.bytesPerSecond))
  assert.ok(state.bytesPerSecond > 0)
})

test('сглаживание: одиночный выброс не утраивает показанную скорость', () => {
  // Ровные 2 MB/s: мегабайт каждые полсекунды.
  const steady = [
    { at: 0, downloaded: 0 },
    { at: 500, downloaded: MB },
    { at: 1000, downloaded: 2 * MB },
    { at: 1500, downloaded: 3 * MB },
    { at: 2000, downloaded: 4 * MB },
  ]
  const before = run(steady).bytesPerSecond
  assert.ok(before !== null)
  assert.ok(Math.abs(before - 2 * MB) < 0.1 * MB, `ровный ход ≈2 MB/s, получено ${before}`)

  // Выброс: следом за ровным ходом три события вылетают из буфера за 15 мс
  // подряд. Приращение байт на событие ограничено сверху порогом в model.rs
  // (событие уходит на каждый набежавший мегабайт), поэтому выброс здесь
  // всегда временнОй, а не байтовый: мегабайт за 5 мс — это мгновенные
  // 200 MB/s, в сто раз выше настоящей скорости канала.
  const burst = [
    { at: 2005, downloaded: 5 * MB },
    { at: 2010, downloaded: 6 * MB },
    { at: 2015, downloaded: 7 * MB },
  ]
  const instant = MB / ((2015 - 2010) / 1000)
  assert.ok(instant >= 100 * before, 'мгновенная скорость на выбросе действительно в разы выше')

  const after = run([...steady, ...burst]).bytesPerSecond
  assert.ok(after !== null)
  assert.ok(
    after < 3 * before,
    `выброс не должен утраивать показанное: было ${before}, стало ${after}`
  )
})

test('сглаживание: устойчивая смена скорости всё-таки доезжает до показанного числа', () => {
  // Сглаживание, которое не отзывается на настоящее изменение, бесполезно:
  // после перехода на 10 MB/s окно должно показать примерно 10 MB/s.
  const steps = [
    { at: 0, downloaded: 0 },
    { at: 500, downloaded: MB },
    { at: 1000, downloaded: 2 * MB },
  ]
  // Десять мегабайт в секунду — событие каждые 100 мс, три с половиной секунды.
  for (let i = 1; i <= 35; i++) steps.push({ at: 1000 + i * 100, downloaded: (2 + i) * MB })

  const state = run(steps).bytesPerSecond
  assert.ok(state !== null)
  assert.ok(
    state > 8 * MB && state < 12 * MB,
    `ожидалось ≈10 MB/s, получено ${state}`
  )
})

test('окно: старые замеры выбрасываются, но пара остаётся всегда', () => {
  const samples = pushSample(
    [
      { downloaded: 0, at: 0 },
      { downloaded: MB, at: 1000 },
      { downloaded: 2 * MB, at: 2000 },
    ],
    { downloaded: 3 * MB, at: 3000 }
  )
  // Окно 2 с: замер в нуле вышел за край.
  assert.equal(samples.length, 3)
  assert.equal(samples[0].at, 1000)

  // Медленная сеть: между событиями больше окна. Обрезать до одного замера
  // нельзя — считать станет не из чего.
  const sparse = pushSample([{ downloaded: 0, at: 0 }], {
    downloaded: MB,
    at: SPEED_WINDOW_MS * 5,
  })
  assert.equal(sparse.length, 2)
  assert.ok(speedFrom(sparse) !== null)
})

test('форматирование скорости: байты, килобайты, мегабайты', () => {
  assert.equal(formatSpeed(12_400_000), '12.4 MB/s')
  assert.equal(formatSpeed(1_000_000), '1.0 MB/s')
  assert.equal(formatSpeed(1_624_555), '1.6 MB/s')
  assert.equal(formatSpeed(847_300), '847 KB/s')
  assert.equal(formatSpeed(1_000), '1 KB/s')
  assert.equal(formatSpeed(512), '512 B/s')
  assert.equal(formatSpeed(1), '1 B/s')
})

test('форматирование скорости: нечего показать — пусто, а не NaN и не 0', () => {
  assert.equal(formatSpeed(null), '')
  assert.equal(formatSpeed(0), '')
  assert.equal(formatSpeed(-5), '')
  assert.equal(formatSpeed(Number.NaN), '')
  assert.equal(formatSpeed(Number.POSITIVE_INFINITY), '')
})

test('процент: известная длина, неизвестная длина, переполнение', () => {
  assert.equal(percentOf(812_277_637, 1_624_555_275), 50)
  assert.equal(percentOf(0, 1_624_555_275), 0)
  assert.equal(percentOf(1_624_555_275, 1_624_555_275), 100)
  assert.equal(percentOf(5 * MB, 0), null)
  // Скачано больше заявленного — 101% на экране выглядит поломкой.
  assert.equal(percentOf(2_000_000_000, 1_624_555_275), 100)
})

test('сброс состояния при ошибке и при успехе', () => {
  const live = run([
    { at: 0, downloaded: 0 },
    { at: 500, downloaded: MB },
  ])
  assert.equal(reduceDownload(live, { type: 'error' }), null)
  assert.equal(reduceDownload(live, { type: 'done' }), null)
  // Индикатора нет — опоздавший замер не должен его воскресить: гасить его
  // потом будет нечему, и он останется висеть навсегда.
  assert.equal(
    reduceDownload(null, { type: 'progress', at: 900, progress: { downloaded: MB, total: 2 * MB } }),
    null
  )
})

test('новая загрузка начинается с нуля, а не с хвоста прошлой', () => {
  const stale = run([
    { at: 0, downloaded: 0 },
    { at: 500, downloaded: 400 * MB },
  ])
  const fresh = reduceDownload(stale, { type: 'start', label: 'small' })
  assert.ok(fresh)
  assert.equal(fresh.downloaded, 0)
  assert.equal(fresh.total, 0)
  assert.equal(fresh.bytesPerSecond, null)
  assert.equal(fresh.samples.length, 0)
  assert.equal(fresh.label, 'small')
})

test('подпись под полосой: сколько из скольки и с какой скоростью', () => {
  const state = run([
    { at: 0, downloaded: 0 },
    { at: 500, downloaded: 400 * MB },
    { at: 1000, downloaded: 812 * MB },
  ])
  assert.equal(progressLabel(state), '812 MB of 1.6 GB · 812.0 MB/s')
})

test('подпись под полосой: без Content-Length остаётся счётчик байт', () => {
  const state = run([
    { at: 0, downloaded: 0, total: 0 },
    { at: 1000, downloaded: 5 * MB, total: 0 },
  ])
  assert.equal(progressLabel(state), '5 MB downloaded · 5.0 MB/s')
  assert.equal(percentOf(state.downloaded, state.total), null)
})

test('сводка: ничего не качается — индикатора нет', () => {
  assert.equal(summarize([]), null)
  assert.equal(summarize([null, null]), null)
})

test('сводка: одна загрузка — её процент, её скорость, её имя', () => {
  const state = run([
    { at: 0, downloaded: 0 },
    { at: 1000, downloaded: 812_277_637 },
  ])
  assert.deepEqual(summarize([state, null]), {
    percent: 50,
    speed: '812.3 MB/s',
    label: 'large-v3-turbo',
  })
})

test('сводка: две одновременные загрузки складываются в один процент', () => {
  // Модель whisper и модель VAD качаются параллельно — кнопка Download у VAD
  // во время загрузки модели не заблокирована.
  const model: Download = {
    label: 'small',
    downloaded: 100 * MB,
    total: 400 * MB,
    samples: [],
    bytesPerSecond: 2 * MB,
  }
  const vad: Download = {
    label: 'Silero',
    downloaded: 0,
    total: 100 * MB,
    samples: [],
    bytesPerSecond: MB,
  }
  assert.deepEqual(summarize([model, vad]), {
    percent: 20, // 100 из 500 МБ
    speed: '3.0 MB/s',
    label: '2 downloads',
  })
})

test('сводка: неизвестная длина у одной гасит общий процент, но не индикатор', () => {
  const known: Download = {
    label: 'small',
    downloaded: 100 * MB,
    total: 400 * MB,
    samples: [],
    bytesPerSecond: 2 * MB,
  }
  const unknown: Download = {
    label: 'Silero',
    downloaded: 5 * MB,
    total: 0,
    samples: [],
    bytesPerSecond: null,
  }
  const summary = summarize([known, unknown])
  assert.ok(summary)
  assert.equal(summary.percent, null)
  assert.equal(summary.speed, '2.0 MB/s')
})
