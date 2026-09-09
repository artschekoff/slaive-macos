use crate::audio::Recorder;
use crate::settings::Settings;
use crate::whisper::Transcriber;
use std::sync::Mutex;
use tauri_plugin_global_shortcut::Shortcut;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// PID приложения, которое было активным в момент нажатия хоткея.
    /// Используется при вставке текста, чтобы вернуть фокус в исходное окно.
    pub prev_app_pid: Mutex<Option<i32>>,
    /// Активная запись с микрофона, если она сейчас идёт.
    pub recorder: Mutex<Option<Recorder>>,
    /// Загруженная модель whisper, если она уже загружена.
    pub transcriber: Mutex<Option<Transcriber>>,
    /// Текущая зарегистрированная глобальная комбинация — нужна, чтобы при
    /// смене хоткея снять именно её, а не все хоткеи разом.
    pub current_hotkey: Mutex<Option<Shortcut>>,
    /// Успешно ли зарегистрирован хоткей при последней попытке (старт
    /// приложения или сохранение настроек). Если нет — окно настроек должно
    /// предупредить пользователя, что комбинация не работает.
    pub hotkey_ok: Mutex<bool>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            prev_app_pid: Mutex::new(None),
            recorder: Mutex::new(None),
            transcriber: Mutex::new(None),
            current_hotkey: Mutex::new(None),
            hotkey_ok: Mutex::new(true),
        }
    }
}
