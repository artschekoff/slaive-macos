use crate::audio::Recorder;
use crate::capture::ClipboardGate;
use crate::settings::Settings;
use crate::whisper::Transcriber;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tauri_plugin_global_shortcut::Shortcut;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// Окно Setup открыто автоматикой старта, а не рукой из трея: такому
    /// окну разрешено спрятаться самому, когда обязательные проверки
    /// дозеленеют (см. SetupWindow.tsx). Открытое человеком — не прячется:
    /// человек пришёл смотреть.
    pub setup_auto_opened: Mutex<bool>,
    /// PID приложения, которое было активным в момент нажатия хоткея.
    /// Используется при вставке текста, чтобы вернуть фокус в исходное окно.
    pub prev_app_pid: Mutex<Option<i32>>,
    /// Единственный вход к общему буферу обмена. Держат его на всё время
    /// своей последовательности захват выделения и вставка текста — обе
    /// пишут в буфер чужое содержимое и обе обязаны видеть его нетронутым
    /// (см. `capture::ClipboardGate`).
    pub clipboard: ClipboardGate,
    /// Активная запись с микрофона, если она сейчас идёт.
    pub recorder: Mutex<Option<Recorder>>,
    /// Загруженная модель whisper, если она уже загружена.
    pub transcriber: Mutex<Option<Transcriber>>,
    /// Текущая зарегистрированная глобальная комбинация — нужна, чтобы при
    /// смене хоткея снять именно её, а не все хоткеи разом.
    pub current_hotkey: Mutex<Option<Shortcut>>,
    /// Зарегистрированный хоткей захвата — хранится, чтобы снять регистрацию
    /// при смене комбинации. Та же роль, что у `current_hotkey`.
    pub current_capture_hotkey: Mutex<Option<Shortcut>>,
    /// Успешно ли зарегистрирован хоткей при последней попытке (старт
    /// приложения или сохранение настроек). Если нет — окно настроек должно
    /// предупредить пользователя, что комбинация не работает.
    pub hotkey_ok: Mutex<bool>,
    /// PCM последней завершённой записи (16 кГц моно) — для воспроизведения.
    pub last_recording: Mutex<Option<Vec<f32>>>,
    /// Флаг остановки потока-эмиттера уровней текущей записи. `Some` только
    /// пока эмиттер активен; `end_recording` вынимает его и опускает флаг.
    pub level_emitter_stop: Mutex<Option<Arc<AtomicBool>>>,
    /// Забирала ли панель нативный фокус в текущем цикле (транскрипт готов
    /// или показана ошибка). `hide_overlay` читает флаг, чтобы понять, нужно
    /// ли явно возвращать фокус исходному приложению при закрытии по Escape/
    /// Close — если панель фокус не забирала (запись ещё идёт/идёт
    /// расшифровка), macOS ничего не переключала, и возвращать нечего.
    /// Сбрасывается в начале каждой новой записи (см. `begin_recording`).
    pub overlay_took_focus: Mutex<bool>,
    /// Есть ли прямо сейчас текст в редакторе панели. Единственный источник
    /// правды по тексту — сам редактор (CodeMirror, общий для панели и
    /// главного окна), поэтому фронтенд сообщает сюда только узкое булево
    /// «пусто/не пусто» через `set_overlay_has_text`, а не сам текст.
    /// Вместе с видимостью окна overlay это и есть правило дозаписи (см.
    /// `begin_recording`).
    pub overlay_has_text: Mutex<bool>,
    /// Режим текущей записи: дозапись к уже накопленному (`true`) или новая
    /// запись с чистого листа (`false`). Решение принимается один раз в
    /// `begin_recording` и живёт до `end_recording`, чтобы текст, PCM и
    /// дорожка не могли разъехаться в разные режимы.
    pub appending: Mutex<bool>,
    /// Пиковая амплитуда последней записи ДО усиления — ориентир для
    /// ползунка Microphone gain в настройках. Число, а не содержимое речи.
    pub last_peak: Mutex<Option<f32>>,

    /// Сигнал отмены текущего запроса к ИИ. `cancel_ai_action` дёргает его,
    /// `run_ai_action` ждёт его в `select!` наравне с самим запросом — что
    /// сработает первым, то и победит. Notify, а не флаг: флаг пришлось бы
    /// опрашивать в цикле, а reqwest рвёт соединение сам, как только его
    /// футура сброшена.
    pub ai_cancel: Arc<tokio::sync::Notify>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            setup_auto_opened: Mutex::new(false),
            prev_app_pid: Mutex::new(None),
            clipboard: ClipboardGate::default(),
            recorder: Mutex::new(None),
            transcriber: Mutex::new(None),
            current_hotkey: Mutex::new(None),
            current_capture_hotkey: Mutex::new(None),
            hotkey_ok: Mutex::new(true),
            last_recording: Mutex::new(None),
            level_emitter_stop: Mutex::new(None),
            overlay_took_focus: Mutex::new(false),
            overlay_has_text: Mutex::new(false),
            appending: Mutex::new(false),
            last_peak: Mutex::new(None),
            ai_cancel: Arc::new(tokio::sync::Notify::new()),
        }
    }
}
