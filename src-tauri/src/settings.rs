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
    /// Абсолютный путь к файлу модели VAD (Silero), если пользователь её
    /// скачал. `None` — VAD выключен, расшифровка идёт по всей записи целиком,
    /// как и раньше; это не ошибка и не деградация, а сознательный дефолт.
    pub vad_model_path: Option<PathBuf>,
    /// Хоткей вставки текста в панели — в том же формате, что `hotkey`, но
    /// это НЕ глобальная комбинация: она перехватывается обычным keydown
    /// внутри окна overlay (см. Overlay.tsx), а не через
    /// tauri-plugin-global-shortcut, поэтому здесь не проходит через
    /// `validate_hotkey`/`register_hotkey` и хранится как обычная строка.
    pub paste_shortcut: String,
    /// Хоткей копирования текста в панели — та же оговорка, что у
    /// `paste_shortcut`: окно-локальный, не глобальный.
    pub copy_shortcut: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // Cmd+T — сознательный выбор пользователя, несмотря на коллизию
            // с «New Tab» в большинстве приложений; предупреждение об этом
            // теперь в подсказке настроек, а не здесь.
            hotkey: "Super+KeyT".to_string(),
            model_path: None,
            language: "auto".to_string(),
            vad_model_path: None,
            // Enter — уже существовавшее поведение до того, как оно стало
            // настраиваемым; голая клавиша допустима именно потому, что это
            // окно-локальный хоткей, а не глобальный (см. комментарий у поля).
            paste_shortcut: "Enter".to_string(),
            // Cmd+C — стандартное системное сочетание для копирования.
            copy_shortcut: "Super+KeyC".to_string(),
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
        assert_eq!(s.hotkey, "Super+KeyT");
        assert_eq!(s.model_path, None);
        assert_eq!(s.language, "auto");
        assert_eq!(s.vad_model_path, None);
        assert_eq!(s.paste_shortcut, "Enter");
        assert_eq!(s.copy_shortcut, "Super+KeyC");
    }

    #[test]
    fn round_trip() {
        let dir = tmp();
        let s = Settings {
            hotkey: "Alt+Space".into(),
            model_path: Some(std::path::PathBuf::from("/tmp/ggml-small.bin")),
            language: "ru".into(),
            vad_model_path: Some(std::path::PathBuf::from("/tmp/ggml-silero-v5.1.2.bin")),
            paste_shortcut: "Shift+Enter".into(),
            copy_shortcut: "Ctrl+Alt+KeyC".into(),
        };
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
    }

    /// Настройки, сохранённые до появления VAD, не должны переставать
    /// загружаться — отсутствующее поле должно тихо стать `None`.
    #[test]
    fn settings_without_vad_field_still_load() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.vad_model_path, None);
        assert_eq!(s.language, "ru");
    }

    /// Настройки, сохранённые до появления настраиваемых Paste/Copy, не
    /// должны переставать загружаться — отсутствующие поля тихо становятся
    /// дефолтами, тем же путём, что уже отработан для VAD выше.
    #[test]
    fn settings_without_shortcut_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.paste_shortcut, "Enter");
        assert_eq!(s.copy_shortcut, "Super+KeyC");
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
        assert_eq!(s.hotkey, "Super+KeyT");
    }
}
