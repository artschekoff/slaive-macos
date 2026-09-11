// Чистая машина состояний применения ОДНОГО действия меню — цикл из брифа:
// простое (idle) → ожидание (pending) → предложено (proposed) → снова idle
// (Accept делает proposed текстом окончательно; Cancel не трогает текст сам —
// вызывающая сторона применяет `original` обратно в редактор, см.
// MainWindow.tsx). Без DOM и без Tauri — тот же принцип, что у menu-state.ts.
//
// `original` хранится ОТДЕЛЬНО от `proposed` и не трогается на всём
// протяжении цикла — вот чем гарантирована точность отмены: Cancel не
// восстанавливает исходный текст обратным преобразованием результата, он
// просто был всё это время рядом, нетронутым, и применяется как есть,
// побайтово.
export type ApplyState =
  | { phase: 'idle' }
  | { phase: 'pending'; original: string; requestId: number }
  | { phase: 'proposed'; original: string; proposed: string }

export function idleApplyState(): ApplyState {
  return { phase: 'idle' }
}

/** Начинает цикл применения действия. `requestId` — монотонный счётчик со
 *  стороны вызывающего (MainWindow): каждому запуску свой номер, чтобы
 *  ответ устаревшего запроса не перезаписал состояние, которое к нему уже не
 *  относится (см. receiveResult/receiveError). */
export function startRequest(original: string, requestId: number): ApplyState {
  return { phase: 'pending', original, requestId }
}

/** Ответ пришёл — применяется только если запрос всё ещё тот, что мы ждём:
 *  устаревший requestId (после Cancel или после того, как успел стартовать
 *  следующий запрос) — ответ молча отбрасывается (возвращается тот же
 *  объект состояния без изменений), вместо того чтобы затереть текст, к
 *  которому пользователь уже не имеет отношения. Это и есть гарантия «упавший
 *  или опоздавший запрос не должен ничего портить» из брифа.
 *
 *  ponytail: настоящей отмены сетевого запроса (AbortController на фронте,
 *  отмена внутри reqwest на бэкенде) здесь нет — Cancel просто переводит
 *  состояние так, что поздний ответ больше не совпадёт по requestId, запрос
 *  в сети продолжает идти вхолостую. Усложнять до реальной отмены запроса,
 *  если пользователь начнёт жаловаться на счёт за отменённые им же запросы
 *  или на ощутимую нагрузку от них. */
export function receiveResult(state: ApplyState, requestId: number, proposed: string): ApplyState {
  if (state.phase !== 'pending' || state.requestId !== requestId) return state
  return { phase: 'proposed', original: state.original, proposed }
}

/** Ошибка запроса — тот же принцип устаревания, что и у receiveResult.
 *  Текст НЕ восстанавливается здесь: он и не был тронут (см. `original`
 *  выше) — переход в idle означает только "цикл ожидания закрыт", а не
 *  "вернуть текст". Сообщение об ошибке — забота вызывающей стороны, не
 *  часть этого состояния. */
export function receiveError(state: ApplyState, requestId: number): ApplyState {
  if (state.phase !== 'pending' || state.requestId !== requestId) return state
  return { phase: 'idle' }
}

/** Cancel — из ожидания или из предложенного результата, оба одинаково
 *  завершают цикл. Вызывающая сторона применяет `original` в редактор в
 *  обоих случаях (во время pending текст и так уже оригинал — применение
 *  идемпотентно, ветвить по фазе незачем). */
export function cancelApply(_state: ApplyState): ApplyState {
  return { phase: 'idle' }
}

/** Accept — предложенный текст становится финальным. Сам текст в редактор
 *  кладёт вызывающая сторона ДО или одновременно с вызовом (в MainWindow.tsx
 *  proposed уже лежит в редакторе к этому моменту — см. эффект синхронизации),
 *  здесь только закрывается цикл. No-op вне фазы 'proposed'. */
export function acceptApply(state: ApplyState): ApplyState {
  if (state.phase !== 'proposed') return state
  return { phase: 'idle' }
}
