use crate::audio::Recorder;
use crate::settings::Settings;
use crate::whisper::Transcriber;
use std::sync::Mutex;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// PID приложения, которое было активным в момент нажатия хоткея.
    /// Используется при вставке текста, чтобы вернуть фокус в исходное окно.
    pub prev_app_pid: Mutex<Option<i32>>,
    /// Активная запись с микрофона, если она сейчас идёт.
    pub recorder: Mutex<Option<Recorder>>,
    /// Загруженная модель whisper, если она уже загружена.
    pub transcriber: Mutex<Option<Transcriber>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            prev_app_pid: Mutex::new(None),
            recorder: Mutex::new(None),
            transcriber: Mutex::new(None),
        }
    }
}
