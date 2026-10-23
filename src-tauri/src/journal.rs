//! Дозапись готовой расшифровки в markdown-журнал пользователя. Модуль
//! ничего не знает ни про Tauri, ни про настройки — ему дают путь и уже
//! собранную запись (строку с таймстампом собирает фронтенд, см.
//! src/journal.ts: у Rust std нет локального времени, а у браузера есть).
//!
//! В отличие от history.rs это ЧУЖОЙ файл — заметки пользователя, поэтому
//! только дозапись в конец, никаких перезаписей и вытеснений: самое
//! страшное, что может сделать сбой, — не дописать свою строку.

use anyhow::Context;
use std::io::Write;
use std::path::Path;

/// Дописывает запись в конец файла, создавая файл при первом обращении.
/// Запись отделяется переводом строки; текст приходит уже готовой
/// markdown-строкой и не трогается.
pub fn append(path: &Path, entry: &str) -> anyhow::Result<()> {
    if entry.trim().is_empty() {
        // Пустую запись не пишем: пустая строка в чужих заметках — мусор.
        return Ok(());
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .with_context(|| format!("журнал: не открыть файл {}", path.display()))?;
    file.write_all(entry.as_bytes()).context("журнал: запись")?;
    file.write_all(b"\n").context("журнал: запись")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-journal-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn creates_the_file_and_appends_entries_in_order() {
        let path = tmp().join("journal.md");
        let _ = std::fs::remove_file(&path);
        append(&path, "- **2026-10-20 15:30** первая").unwrap();
        append(&path, "- **2026-10-20 15:31** вторая").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "- **2026-10-20 15:30** первая\n- **2026-10-20 15:31** вторая\n");
    }

    #[test]
    fn existing_user_content_is_untouched() {
        let path = tmp().join("existing.md");
        std::fs::write(&path, "# Мои заметки\n").unwrap();
        append(&path, "- **2026-10-20 15:30** запись").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "# Мои заметки\n- **2026-10-20 15:30** запись\n");
    }

    #[test]
    fn empty_entry_writes_nothing() {
        let path = tmp().join("empty.md");
        let _ = std::fs::remove_file(&path);
        append(&path, "   ").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn missing_parent_directory_is_an_error_not_a_panic() {
        let path = Path::new("/nonexistent-slaive-dir/journal.md");
        assert!(append(path, "- запись").is_err());
    }
}
