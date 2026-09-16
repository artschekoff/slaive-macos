// Двумерная навигация по сетке плиток истории (см. HistoryView.tsx) —
// сознательно ОТДЕЛЬНЫЙ модуль от menu-state.ts, а не тот же с флагом "а
// тут у нас сетка": столбец действий одномерный и с фиксированной одной
// колонкой, сетка истории — auto-fill с числом колонок, зависящим от
// ширины окна (см. .history-grid в styles.css), и с почти всегда неполной
// последней строкой. Свести оба под один переключатель запутало бы каждый
// из них сильнее, чем два маленьких честных модуля рядом.
//
// Влево/вправо ниже переиспользуют moveSelectionUp/moveSelectionDown из
// menu-state.ts НАПРЯМУЮ, а не копируют их: сетка читается одной лентой
// слева-направо-сверху-вниз (тот же порядок, что и DOM/Tab), и "шаг по
// ленте с циклом на краях" — та же самая функция, что уже листает столбец
// действий, просто по другому смыслу клавиши. Вверх/вниз — другое движение
// (шаг не на 1, а на число колонок, и с подтягиванием к ближайшему пункту
// в неполной строке), под него нужна отдельная арифметика — она ниже.
import { moveSelectionDown, moveSelectionUp } from './menu-state.ts'

/** Число строк в сетке — последняя может быть неполной (см. отчёт: девять
 *  плиток в три колонки дают три строки, десять — четыре, где в последней
 *  одна плитка). `Math.max(1, ...)` — пустая сетка формально даёт 0 строк,
 *  но вызывающая сторона уже отсекла length<=0 раньше, чем дело доходит до
 *  деления на columns. */
function rowCount(length: number, columns: number): number {
  return Math.max(1, Math.ceil(length / Math.max(1, columns)))
}

/** Индекс ПОСЛЕДНЕГО существующего пункта в данной строке — меньше
 *  columns-1, если строка неполная (последняя строка почти всегда такая). */
function lastIndexInRow(row: number, length: number, columns: number): number {
  return Math.min((row + 1) * columns - 1, length - 1)
}

/** Шаг вниз на строку с сохранением колонки. С последней строки — цикл на
 *  первую, тем же принципом "не упираться в тупик", что и у moveSelectionDown
 *  в столбце действий (см. отчёт про edge-поведение). Если в целевой строке
 *  этой колонки не существует (переход упёрся бы в неполную последнюю
 *  строку — ровно тот случай из отчёта), выбор подтягивается к БЛИЖАЙШЕМУ
 *  существующему пункту той строки, а не проваливается в пустоту и не
 *  остаётся молча на месте. */
export function moveGridDown(index: number, length: number, columns: number): number {
  if (length <= 0) return 0
  const cols = Math.max(1, columns)
  const rows = rowCount(length, cols)
  const row = Math.floor(index / cols)
  const col = index % cols
  const targetRow = row >= rows - 1 ? 0 : row + 1
  return Math.min(targetRow * cols + col, lastIndexInRow(targetRow, length, cols))
}

/** Зеркало moveGridDown — шаг вверх, цикл с первой строки на последнюю.
 *  Верхняя строка при переходе ВНИЗ→ВВЕРХ (цикл) всегда полная (неполной
 *  бывает только последняя), поэтому подтягивание к ближайшему пункту здесь
 *  нужно только для промежуточных шагов, не для самого цикла — но считается
 *  той же формулой, без отдельной ветки под этот частный случай. */
export function moveGridUp(index: number, length: number, columns: number): number {
  if (length <= 0) return 0
  const cols = Math.max(1, columns)
  const rows = rowCount(length, cols)
  const row = Math.floor(index / cols)
  const col = index % cols
  const targetRow = row <= 0 ? rows - 1 : row - 1
  return Math.min(targetRow * cols + col, lastIndexInRow(targetRow, length, cols))
}

/** Шаг вправо по ленте сетки (строка за строкой, слева направо), с тем же
 *  циклом на краях, что у столбца действий, — потому что это буквально та
 *  же функция: сетка листается той же лентой, что и одномерный список,
 *  просто по горизонтали, а не по вертикали. */
export function moveGridRight(index: number, length: number): number {
  return moveSelectionDown(index, length)
}

/** Зеркало moveGridRight. */
export function moveGridLeft(index: number, length: number): number {
  return moveSelectionUp(index, length)
}
