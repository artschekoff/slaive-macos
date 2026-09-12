//! Журнал расшифровок: что было надиктовано, когда и сколько это длилось.
//!
//! Модуль ничего не знает ни про Tauri, ни про окна: на вход папка данных,
//! на выход записи. Путь к папке приходит снаружи (`commands::data_dir`,
//! то есть `app.path().app_data_dir()`), хардкода здесь нет.
//!
//! ПРИВАТНОСТЬ. Это личная речь пользователя, лежащая на диске открытым
//! текстом. Правило проекта «не логировать расшифровку» остаётся в силе и
//! внутри этого модуля: в `eprintln!` уходят только числа — сколько записей,
//! сколько байт, сколько строк пропущено. Ни `text`, ни его кусок, ни его
//! длина по символам в лог не попадают.
//!
//! ФОРМАТ. JSONL: одна запись — одна строка. Не SQLite (зависимость и схема
//! ради сотен строк) и не JSON-массив (дозапись потребовала бы перечитать и
//! переписать файл целиком). Обычный путь здесь — открыть файл на дозапись и
//! дописать строку.
//!
//! ЗВУК НЕ ХРАНИМ. Минута диктовки в f32/16 кГц — это почти четыре мегабайта;
//! история из двухсот записей превратилась бы в гигабайты ради функции, о
//! которой не просили. Длительность хранится числом.
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

const FILE_NAME: &str = "history.jsonl";
/// Временное имя для перезаписи файла целиком (вытеснение, удаление).
/// Переименование в пределах одной папки атомарно, поэтому прерванная
/// перезапись оставляет нетронутым СТАРЫЙ файл, а не половину нового.
const TMP_FILE_NAME: &str = "history.jsonl.tmp";

/// Сколько записей храним. Старые вытесняются при дозаписи.
pub const MAX_ENTRIES: usize = 200;

/// Одна запись журнала. `camelCase` — как и у остальных структур, которые
/// уходят во фронтенд; тот же регистр лежит и в файле, менять его потом
/// нельзя без миграции.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Момент создания в миллисекундах UTC от эпохи — он же идентификатор.
    /// Отдельного поля `id` нет намеренно: время создания уникально (см.
    /// `next_id`), человекочитаемо в самом файле и не требует ни uuid, ни
    /// счётчика на диске.
    pub id: u64,
    /// Текст расшифровки целиком — именно он ложится в редактор при нажатии
    /// на плитку. Обрезка «сколько влезет в плитку» — дело интерфейса
    /// (src/history.ts), здесь текст хранится как есть.
    pub text: String,
    /// Длительность записи в секундах. При дозаписи — длительность всего
    /// накопленного звука, чтобы число относилось к тому же, к чему и текст.
    pub duration_secs: f32,
}

/// Последний выданный идентификатор в этом запуске. Часы дают миллисекунды,
/// и двух расшифровок в одну миллисекунду в природе не бывает — но цена
/// совпадения (удаление одной записи убирает обе) несопоставима с ценой
/// четырёх строк, а системное время умеет ещё и прыгать назад.
static LAST_ID: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Строго возрастающий идентификатор: обычно это просто текущее время.
fn next_id() -> u64 {
    let now = now_ms();
    loop {
        let last = LAST_ID.load(Ordering::Relaxed);
        let id = if now > last { now } else { last + 1 };
        // compare_exchange, а не load+store: две расшифровки одновременно не
        // идут (транскрибер под мьютексом), но полагаться на это из другого
        // модуля значило бы завязать корректность идентификаторов на чужой
        // инвариант.
        if LAST_ID
            .compare_exchange_weak(last, id, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            return id;
        }
    }
}

pub fn file_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Читает журнал. Порядок — как в файле: от старых к новым.
///
/// БИТАЯ СТРОКА НЕ РОНЯЕТ ЧТЕНИЕ. Процесс могли убить посреди записи строки
/// (выключение питания, `Force Quit`) — тогда последняя строка оборвана на
/// середине. Такая строка пропускается, остальные читаются. По той же
/// причине файл читается байтами и превращается в строку через
/// `from_utf8_lossy`: обрыв мог прийтись на середину многобайтового символа,
/// и `read_to_string` отказался бы отдать ВЕСЬ файл из-за одного такого
/// байта.
///
/// Отсутствующий файл — пустая история, а не ошибка: до первой расшифровки
/// его и не должно быть.
pub fn load(dir: &Path) -> anyhow::Result<Vec<Entry>> {
    let path = file_path(dir);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(anyhow::Error::new(e).context("Couldn't read the history file.")),
    };
    let text = String::from_utf8_lossy(&raw);
    let mut entries = Vec::new();
    let mut skipped = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Entry>(line) {
            Ok(entry) => entries.push(entry),
            Err(_) => skipped += 1,
        }
    }
    if skipped > 0 {
        // Только счётчик: в битой строке лежит та же личная речь.
        eprintln!("история: пропущено битых строк: {skipped}");
    }
    Ok(entries)
}

/// Добавляет запись и возвращает её.
///
/// Обычный путь — открыть файл на дозапись и дописать одну строку; ни чтения,
/// ни перезаписи. Проверка переполнения делается по числу переводов строки в
/// файле, то есть без разбора JSON, и только когда записей стало больше
/// потолка, файл переписывается целиком (см. `trim_to_cap`).
pub fn append(dir: &Path, text: &str, duration_secs: f32) -> anyhow::Result<Entry> {
    std::fs::create_dir_all(dir).context("Couldn't create the app data folder.")?;
    let entry = Entry {
        id: next_id(),
        text: text.to_string(),
        duration_secs,
    };
    // Запись сериализуется В ОДНУ СТРОКУ: `to_string` (не `to_string_pretty`)
    // плюс экранирование переносов внутри JSON-строки самим serde_json — на
    // этом и держится «строка файла = запись».
    let line = serde_json::to_string(&entry)?;
    debug_assert!(!line.contains('\n'));
    let path = file_path(dir);
    {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .context("Couldn't open the history file.")?;
        writeln!(f, "{line}").context("Couldn't write to the history file.")?;
    }
    trim_to_cap(dir)?;
    Ok(entry)
}

/// Вытеснение: если записей больше потолка, оставляем последние `MAX_ENTRIES`.
///
/// Считаем строки по байту `\n`, без разбора JSON, — в подавляющем
/// большинстве вызовов это единственная работа сверх дозаписи.
/// ponytail: после переполнения перезапись случается на каждой новой записи;
/// если файл вырастет настолько, что это станет заметно, вытеснять пачкой
/// (обрезать до 200, когда накопилось 220).
fn trim_to_cap(dir: &Path) -> anyhow::Result<()> {
    let path = file_path(dir);
    let raw = std::fs::read(&path).context("Couldn't read the history file.")?;
    let lines = raw.iter().filter(|b| **b == b'\n').count();
    if lines <= MAX_ENTRIES {
        return Ok(());
    }
    let mut entries = load(dir)?;
    // Битые строки уже отсеяны загрузкой, поэтому записей может оказаться и
    // меньше потолка — тогда перезапись просто вычистит мусор.
    if entries.len() > MAX_ENTRIES {
        entries.drain(..entries.len() - MAX_ENTRIES);
    }
    write_all(dir, &entries)
}

/// Удаляет одну запись по идентификатору. Отсутствие такой записи — не
/// ошибка: интерфейс мог показывать список, из которого её уже удалили.
pub fn delete(dir: &Path, id: u64) -> anyhow::Result<()> {
    let mut entries = load(dir)?;
    let before = entries.len();
    entries.retain(|e| e.id != id);
    if entries.len() == before {
        return Ok(());
    }
    write_all(dir, &entries)
}

/// Стирает историю целиком — удалением файла, а не пустой перезаписью:
/// незачем оставлять на диске файл с прежним размером, когда пользователь
/// попросил убрать содержимое. Подтверждение спрашивает интерфейс: обратно
/// это не достаётся ничем.
pub fn clear(dir: &Path) -> anyhow::Result<()> {
    let path = file_path(dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(anyhow::Error::new(e).context("Couldn't delete the history file.")),
    }
}

/// Перезапись файла целиком через временный файл и переименование: прерванная
/// на середине перезапись оставляет старый файл нетронутым. Обычная запись
/// поверх могла бы оставить обрубок вместо всей истории — а история, в
/// отличие от модели, заново не скачивается.
fn write_all(dir: &Path, entries: &[Entry]) -> anyhow::Result<()> {
    let tmp = dir.join(TMP_FILE_NAME);
    let mut buf = String::new();
    for e in entries {
        buf.push_str(&serde_json::to_string(e)?);
        buf.push('\n');
    }
    std::fs::write(&tmp, &buf).context("Couldn't write the history file.")?;
    std::fs::rename(&tmp, file_path(dir)).context("Couldn't replace the history file.")?;
    Ok(())
}

/// Размер файла в байтах — для лога. Числа логировать можно, содержимое нет.
pub fn file_bytes(dir: &Path) -> u64 {
    std::fs::metadata(file_path(dir)).map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Та же изоляция, что у тестов настроек: pid плюс id потока, иначе
    // параллельные тесты дерутся за одну папку.
    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-history-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn empty_when_file_missing() {
        let dir = tmp();
        assert!(load(&dir).unwrap().is_empty());
    }

    #[test]
    fn append_keeps_order_and_fields() {
        let dir = tmp();
        append(&dir, "первая", 1.5).unwrap();
        append(&dir, "вторая", 2.25).unwrap();
        let entries = load(&dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "первая");
        assert_eq!(entries[1].text, "вторая");
        assert_eq!(entries[1].duration_secs, 2.25);
        // Порядок в файле — от старых к новым.
        assert!(entries[0].id < entries[1].id);
    }

    /// Две записи подряд укладываются в одну миллисекунду — без монотонного
    /// счётчика они получили бы один и тот же id, и удаление одной убрало бы
    /// обе.
    #[test]
    fn ids_are_unique_within_the_same_millisecond() {
        let dir = tmp();
        let mut ids = Vec::new();
        for _ in 0..50 {
            ids.push(append(&dir, "x", 0.1).unwrap().id);
        }
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), ids.len(), "идентификаторы повторились");
    }

    /// Многострочный текст обязан остаться ОДНОЙ строкой файла — иначе
    /// «строка = запись» ломается, и половина текста читается как битая
    /// строка.
    #[test]
    fn multiline_text_stays_one_line() {
        let dir = tmp();
        append(&dir, "первая строка\nвторая строка", 1.0).unwrap();
        let raw = std::fs::read_to_string(file_path(&dir)).unwrap();
        assert_eq!(raw.lines().count(), 1);
        assert_eq!(load(&dir).unwrap()[0].text, "первая строка\nвторая строка");
    }

    #[test]
    fn evicts_oldest_beyond_the_cap() {
        let dir = tmp();
        for i in 0..MAX_ENTRIES + 5 {
            append(&dir, &format!("запись {i}"), 1.0).unwrap();
        }
        let entries = load(&dir).unwrap();
        assert_eq!(entries.len(), MAX_ENTRIES);
        // Вытесняются САМЫЕ СТАРЫЕ, последняя запись на месте.
        assert_eq!(entries[0].text, "запись 5");
        assert_eq!(entries[MAX_ENTRIES - 1].text, format!("запись {}", MAX_ENTRIES + 4));
    }

    /// Обрыв питания посреди записи строки: файл кончается половиной JSON.
    /// Остальные записи обязаны прочитаться.
    #[test]
    fn broken_line_in_the_middle_is_skipped() {
        let dir = tmp();
        append(&dir, "до", 1.0).unwrap();
        // Битая строка ровно посередине — не в конце: обрыв мог случиться и
        // при перезаписи, и тогда мусор оказывается внутри файла.
        let good = std::fs::read_to_string(file_path(&dir)).unwrap();
        let broken = format!("{good}{{\"id\":123,\"text\":\"обор\n");
        std::fs::write(file_path(&dir), broken).unwrap();
        append(&dir, "после", 2.0).unwrap();

        let entries = load(&dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].text, "до");
        assert_eq!(entries[1].text, "после");
    }

    /// Обрыв пришёлся на середину многобайтового символа — файл целиком уже
    /// не валидный UTF-8. `read_to_string` вернул бы ошибку на ВЕСЬ файл.
    #[test]
    fn invalid_utf8_tail_does_not_kill_the_file() {
        let dir = tmp();
        append(&dir, "целая запись", 1.0).unwrap();
        let mut raw = std::fs::read(file_path(&dir)).unwrap();
        // Первый байт двухбайтовой кириллической буквы без пары.
        raw.extend_from_slice(&[b'{', b'"', b't', 0xD0]);
        std::fs::write(file_path(&dir), raw).unwrap();

        let entries = load(&dir).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].text, "целая запись");
    }

    #[test]
    fn delete_removes_only_the_named_entry() {
        let dir = tmp();
        let a = append(&dir, "первая", 1.0).unwrap();
        let b = append(&dir, "вторая", 1.0).unwrap();
        let c = append(&dir, "третья", 1.0).unwrap();

        delete(&dir, b.id).unwrap();
        let entries = load(&dir).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, a.id);
        assert_eq!(entries[1].id, c.id);

        // Удаление несуществующей записи — не ошибка и ничего не трогает.
        delete(&dir, b.id).unwrap();
        assert_eq!(load(&dir).unwrap().len(), 2);
    }

    #[test]
    fn clear_removes_everything() {
        let dir = tmp();
        append(&dir, "первая", 1.0).unwrap();
        append(&dir, "вторая", 1.0).unwrap();
        clear(&dir).unwrap();
        assert!(load(&dir).unwrap().is_empty());
        assert!(!file_path(&dir).exists());
        // Повторная очистка пустой истории — тоже не ошибка.
        clear(&dir).unwrap();
        // И после очистки журнал продолжает работать.
        append(&dir, "новая", 1.0).unwrap();
        assert_eq!(load(&dir).unwrap().len(), 1);
    }

    /// Перезапись не должна оставлять за собой временный файл: он лежит в той
    /// же папке данных и при следующем чтении был бы просто мусором на диске.
    #[test]
    fn rewrite_leaves_no_temp_file() {
        let dir = tmp();
        let e = append(&dir, "первая", 1.0).unwrap();
        delete(&dir, e.id).unwrap();
        assert!(!dir.join(TMP_FILE_NAME).exists());
    }
}
