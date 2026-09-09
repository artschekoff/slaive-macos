use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Строка хоткея в формате Tauri, например "Ctrl+Space".
    pub hotkey: String,
    /// Абсолютный путь к файлу модели ggml-*.bin.
    pub model_path: Option<PathBuf>,
    /// "auto" | "ru" | "en"
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "Ctrl+Space".to_string(),
            model_path: None,
            language: "auto".to_string(),
        }
    }
}

/// Битый или отсутствующий файл — не ошибка: возвращаем дефолты, чтобы
/// приложение всегда стартовало.
/// ponytail: без резервных копий и версионирования схемы, добавить когда полей станет много
pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).context("Couldn't create the settings folder.")?;
    let raw = serde_json::to_string_pretty(s)?;
    std::fs::write(dir.join(FILE_NAME), raw).context("Couldn't write settings to disk.")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // tmp() из брифа использовал только process::id(), который одинаков для
    // всех тестов в этом бинарнике — при параллельных потоках cargo тесты
    // гонялись за одну и ту же папку и флакали. Добавлен id потока, чтобы
    // каждый параллельно выполняющийся тест был изолирован; проверки не менялись.
    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_when_file_missing() {
        let dir = tmp();
        let s = load(&dir);
        assert_eq!(s.hotkey, "Ctrl+Space");
        assert_eq!(s.model_path, None);
        assert_eq!(s.language, "auto");
    }

    #[test]
    fn round_trip() {
        let dir = tmp();
        let s = Settings {
            hotkey: "Alt+Space".into(),
            model_path: Some(std::path::PathBuf::from("/tmp/ggml-small.bin")),
            language: "ru".into(),
        };
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
    }

    #[test]
    fn defaults_when_file_corrupt() {
        let dir = tmp();
        std::fs::write(dir.join("settings.json"), "{ это не json").unwrap();
        assert_eq!(load(&dir), Settings::default());
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(dir.join("settings.json"), r#"{"language":"en"}"#).unwrap();
        let s = load(&dir);
        assert_eq!(s.language, "en");
        assert_eq!(s.hotkey, "Ctrl+Space");
    }
}
