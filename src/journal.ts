// Сборка markdown-записи журнала — отдельно от панели по тому же принципу,
// что smart-replace.ts: строку можно проверить тестом. Таймстамп собирается
// здесь, на фронте, потому что локальное время с таймзоной знает браузер,
// а Rust std — нет (см. src-tauri/src/journal.rs).

/** `- **2026-10-20 15:30** текст` — формат VoiceInk-журнала: плоский
 *  список, хронология читается глазами. Многострочный текст (роль Note
 *  делает списки) продолжается с отступом в два пробела — по правилам
 *  markdown это тот же пункт списка, а не разрыв на отдельные. */
export function formatJournalEntry(text: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const [first, ...rest] = text.trim().split('\n')
  return [`- **${stamp}** ${first}`, ...rest.map((l) => `  ${l}`)].join('\n')
}
