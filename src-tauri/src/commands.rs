use crate::audio::Recorder;
use crate::macos;
use crate::model::{self, ModelInfo};
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::whisper::{Transcriber, MIN_SAMPLES};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Как часто эмиттер уровня опрашивает `drain_peaks` и шлёт `rec:level`.
/// 20 кадров в секунду — с запасом для дорожки, панель не захлебнётся.
const LEVEL_EMIT_INTERVAL: Duration = Duration::from_millis(50);

/// Тексты отказов в правах — общие для двух путей в `paste_text`:
/// превентивной проверки перед попыткой вставки и разбора сообщения
/// osascript после её неудачи (право могут отозвать между ними).
const ACCESSIBILITY_PERMISSION_MESSAGE: &str = "Slaive needs Accessibility permission to send keystrokes to other apps. \
     Go to System Settings → Privacy & Security → Accessibility and turn \
     Slaive on.";
const AUTOMATION_PERMISSION_MESSAGE: &str = "Slaive needs permission to control System Events to bring back the app \
     you were using. Go to System Settings → Privacy & Security → Automation \
     → Slaive → System Events and turn it on.";

/// Поднимает поток, который во время записи раз в `LEVEL_EMIT_INTERVAL`
/// вычерпывает пики через `drain_peaks` и шлёт максимум в панель.
///
/// Гарантия завершения: флаг проверяется и до, и после каждого сна, сам сон
/// ограничен `LEVEL_EMIT_INTERVAL` — никакого ожидания без выхода. Как только
/// `end_recording` опускает флаг, поток замечает это максимум через один
/// интервал и возвращается, не трогая состояние следующей записи (у неё уже
/// будет свой, отдельный флаг).
fn spawn_level_emitter(app: AppHandle, stop: Arc<AtomicBool>) {
    std::thread::spawn(move || loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        std::thread::sleep(LEVEL_EMIT_INTERVAL);
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let state = app.state::<AppState>();
        let peaks = {
            // Тот же стиль, что и в `drain_peaks`: отравленный мьютекс —
            // не повод ронять поток, просто нечего вернуть на этот тик.
            match state.recorder.lock() {
                Ok(guard) => guard.as_ref().map(|r| r.drain_peaks()),
                Err(_) => None,
            }
        };
        // Пусто, если колбэк ещё не успел ничего накопить — это тоже 0.0,
        // а не повод молчать: кадры дорожки идут с постоянным темпом.
        let level = peaks
            .unwrap_or_default()
            .into_iter()
            .fold(0.0f32, f32::max);
        let _ = app.emit_to("overlay", "rec:level", level);
    });
}

/// Папка данных приложения; создаётся при первом обращении.
pub fn data_dir(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("No access to the app data folder: {e}."))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Ответ `get_settings`: настройки плюс производное рантайм-состояние,
/// которое незачем хранить на диске.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    #[serde(flatten)]
    pub settings: Settings,
    /// C1.4: успешно ли сейчас зарегистрирован глобальный хоткей. Отказ на
    /// старте раньше уходил только в лог — окно настроек должно явно
    /// предупредить, а не оставлять пользователя гадать, почему хоткей молчит.
    pub hotkey_ok: bool,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> SettingsResponse {
    SettingsResponse {
        settings: state.settings.lock().unwrap().clone(),
        hotkey_ok: *state.hotkey_ok.lock().unwrap(),
    }
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    // C1: разобрать и зарегистрировать новый хоткей ДО того, как что-либо
    // запишется на диск или в состояние. Если регистрация упала — опечатка
    // или комбинация занята другим приложением — ничего не сохраняем, и
    // прежний рабочий хоткей остаётся на месте вместо того, чтобы быть
    // затёртым битой строкой.
    register_hotkey(&app, &settings.hotkey).map_err(|e| e.to_string())?;

    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    settings::save(&dir, &settings).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings.clone();

    // Путь к модели или язык могли поменяться — перезагрузим модель при следующей записи.
    *state.transcriber.lock().unwrap() = None;

    // Окно overlay живёт всё время работы приложения (скрывается, а не
    // пересоздаётся), поэтому свежие Paste/Copy-хоткеи и их бейджи на
    // кнопках не долетят до него сами собой — шлём событие, а не полагаемся
    // на то, что панель когда-нибудь перезапросит get_settings.
    let _ = app.emit_to("overlay", "settings:changed", settings);

    Ok(())
}

pub fn show_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        // Не вызываем set_focus: фокус должен остаться у исходного приложения.
        let _ = w.set_visible_on_all_workspaces(true);
        let _ = w.show();
    }
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
}

pub fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit_to("overlay", "error", message);
}

/// C2.3: раздел «Конфиденциальность и безопасность» едет в payload вместе
/// с текстом — так кнопка в панели открывает именно тот раздел, где есть
/// нужный переключатель, вместо того чтобы всегда вести в Accessibility.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AccessibilityErrorPayload {
    pub message: String,
    pub pane: macos::PrivacyPane,
}

/// Отказ в правах — единственная ошибка, из которой пользователь может
/// выйти сам, поэтому у неё отдельное событие: панель вешает кнопку на
/// него, а не на подстроку в тексте, который могут переформулировать.
pub fn emit_accessibility_error(
    app: &AppHandle,
    message: impl Into<String>,
    pane: macos::PrivacyPane,
) {
    let payload = AccessibilityErrorPayload {
        message: message.into(),
        pane,
    };
    let _ = app.emit_to("overlay", "error:accessibility", payload);
}

/// Имя и иконка приложения, из которого пользователь вызвал Slaive.
/// `icon` — уже готовый `data:` URL: `.icns` не рендерится в WebView,
/// поэтому конвертация в PNG-base64 сделана заранее в `macos::resolve_app`,
/// а сборку URL из голого base64 берёт на себя эта сторона границы, а не
/// платформенный модуль, который ничего не должен знать о фронтенде.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SourceAppPayload {
    pub name: String,
    pub icon: Option<String>,
}

/// Шлёт панели, из какого приложения вызвали запись. Зовётся с фонового
/// потока (см. `hotkey_pressed`) — к этому моменту запись уже идёт.
fn emit_source_app(app: &AppHandle, source: macos::SourceApp) {
    let payload = SourceAppPayload {
        name: source.name,
        icon: source
            .icon_png_base64
            .map(|b64| format!("data:image/png;base64,{b64}")),
    };
    let _ = app.emit_to("overlay", "app:source", payload);
}

/// Хоткей зажат: показываем панель и начинаем запись.
pub fn hotkey_pressed(app: &AppHandle) {
    // I4: порядок специально такой. begin_recording стартует запись первой
    // строкой. Раньше первым шагом был frontmost_pid() — первый Apple Events
    // вызов приложения, который на первом запуске блокирует поток до ответа
    // пользователя на системный диалог прав, и первое слово срезалось. Захват
    // pid и показ панели идут после: show_overlay намеренно не зовёт
    // set_focus, так что активное приложение к этому моменту всё ещё то самое.
    begin_recording(app);
    let pid = crate::macos::frontmost_pid();
    *app.state::<AppState>().prev_app_pid.lock().unwrap() = pid;
    show_overlay(app);

    // Разрешение имени/иконки приложения-источника — три форка system-
    // инструментов (ps, PlistBuddy, при наличии иконки ещё и sips) — на
    // фоновом потоке, а не здесь: запись уже идёт (begin_recording — первая
    // строка функции), и хот-путь записи не должен ждать этого. Шапка
    // панели появится на кадр позже, уже поверх идущей записи.
    if let Some(pid) = pid {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Some(source) = macos::resolve_app(pid) {
                emit_source_app(&app, source);
            }
        });
    }
}

/// Хоткей отпущен: останавливаем запись и запускаем расшифровку.
pub fn hotkey_released(app: &AppHandle) {
    end_recording(app);
}

/// Общая логика старта записи — используется и хоткеем, и кликом по микрофону.
pub fn begin_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.recorder.lock().unwrap();
    if slot.is_some() {
        return; // уже пишем — повторное нажатие игнорируем
    }
    // Пока идёт расшифровка, транскрибер заблокирован фоновым потоком.
    // Занятая блокировка — и есть признак того, что предыдущая запись ещё
    // обрабатывается, поэтому новую не начинаем: её результат всё равно
    // перетёрся бы, а писала бы она в никуда.
    // ponytail: признак «идёт расшифровка» читаем из уже существующей
    // блокировки вместо отдельного флага — если появится второй потребитель
    // транскрибера, завести явный флаг состояния.
    match state.transcriber.try_lock() {
        Ok(_) => {}
        // I2 / I3: WouldBlock — предыдущая расшифровка ещё идёт, это
        // временно и ожидаемо. Молчать нельзя: иначе панель остаётся в
        // прежней фазе без активного recorder, а когда придёт результат
        // ПРЕДЫДУЩЕЙ записи, пользователь примет его за текст этой попытки
        // и вставит не то.
        Err(std::sync::TryLockError::WouldBlock) => {
            return emit_error(
                app,
                "Still transcribing the previous recording. Wait a moment and try again.",
            );
        }
        // I2: Poisoned — паника внутри whisper.cpp отравила мьютекс навсегда,
        // это не временное состояние. Молчаливый выход оставлял бы хоткей
        // мёртвым до перезапуска без единого объяснения.
        Err(std::sync::TryLockError::Poisoned(_)) => {
            eprintln!("мьютекс транскрибера отравлен — предыдущая расшифровка запаниковала");
            return emit_error(
                app,
                "The previous transcription crashed. Restart Slaive to keep recording.",
            );
        }
    }
    match Recorder::start() {
        Ok(rec) => {
            *slot = Some(rec);

            // Флаг публикуем, ЕЩЁ держа блокировку `state.recorder` (слот
            // жив до `drop(slot)` ниже). Пока лок держим мы, end_recording
            // не может забрать recorder — а значит не может проскочить мимо
            // ещё не записанного флага и остаться с потоком без адресата
            // остановки. Обоснование через happens-before — в отчёте.
            let stop = Arc::new(AtomicBool::new(false));
            *state.level_emitter_stop.lock().unwrap() = Some(stop.clone());
            spawn_level_emitter(app.clone(), stop);

            drop(slot);
            let _ = app.emit_to("overlay", "rec:start", ());
        }
        Err(e) => {
            // cpal отдаёт причину по-английски — в лог. Пользователю — один
            // из двух текстов в зависимости от причины (I8): отсутствие
            // устройства не лечится выдачей разрешения, которое, возможно,
            // уже есть.
            eprintln!("микрофон недоступен: {e}");
            let text = if e.to_string().contains("no input device found") {
                "No microphone found. Connect one and try again."
            } else {
                "Couldn't open the microphone. Grant Slaive access in System Settings → Privacy & Security → Microphone and try again."
            };
            emit_error(app, text);
        }
    }
}

/// Общая логика остановки записи и запуска расшифровки в фоновом потоке.
pub fn end_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Some(rec) = state.recorder.lock().unwrap().take() else {
        return; // не писали — нечего останавливать
    };
    // Порядок принципиален: сначала забираем recorder, только потом флаг.
    // begin_recording пишет флаг в level_emitter_stop, ЕЩЁ держа блокировку
    // recorder, и лишь после этого её отпускает — значит успешный take()
    // recorder здесь возможен только после того, как та запись флага уже
    // случилась и стала видна нам (happens-before через мьютекс recorder).
    // Если бы порядок был обратным, можно было бы вклиниться между
    // "проверили level_emitter_stop" и "забрали recorder" и упустить ещё не
    // опубликованный флаг — поток-эмиттер остался бы без адресата остановки.
    if let Some(stop) = state.level_emitter_stop.lock().unwrap().take() {
        stop.store(true, Ordering::Relaxed);
    }
    let _ = app.emit_to("overlay", "rec:stop", ());

    let app = app.clone();
    // Транскрипция блокирует поток на секунды — уводим её с потока событий.
    std::thread::spawn(move || {
        let pcm = match rec.stop() {
            Ok(pcm) => pcm,
            Err(e) => {
                // cpal отдаёт причину по-английски — в лог, пользователю фиксированный текст.
                eprintln!("запись не удалась: {e}");
                return emit_error(&app, "Recording failed. Try again.");
            }
        };
        // Пиковая амплитуда — диагностика ради которой всё затевалось: если
        // отказано в доступе к микрофону, macOS отдаёт поток нулей вместо
        // ошибки, и пик остаётся 0.0000 при любой длине записи. Число — не
        // содержимое речи, логировать можно.
        let peak = pcm.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        eprintln!("записано сэмплов: {}, пиковая амплитуда: {peak:.4}", pcm.len());

        // Кладём PCM в состояние для воспроизведения независимо от исхода
        // расшифровки ниже — короткую или беззвучную запись тоже полезно
        // прослушать, чтобы понять, что произошло. `state` берём здесь же,
        // от уже переехавшего в поток владения `app` — внешний `state` из
        // начала функции жив только до `std::thread::spawn` и не может быть
        // захвачен `move`-замыканием.
        let state = app.state::<AppState>();
        *state.last_recording.lock().unwrap() = Some(pcm.clone());

        // I7: случайный тап по хоткею — самая частая ошибка первого запуска,
        // и она же самый медленный путь, если сначала грузить модель.
        // Проверяем длину записи до обращения к транскриберу.
        if pcm.len() < MIN_SAMPLES {
            return emit_error(
                &app,
                "Recording too short — hold the hotkey and speak longer.",
            );
        }

        let (model_path, language, vad_model_path) = {
            let s = state.settings.lock().unwrap();
            (s.model_path.clone(), s.language.clone(), s.vad_model_path.clone())
        };

        let Some(model_path) = model_path else {
            return emit_error(&app, "No model selected. Open Settings and download one.");
        };

        // Загружаем модель один раз и держим в памяти.
        let mut slot = state.transcriber.lock().unwrap();
        if slot.is_none() {
            match Transcriber::load(&model_path) {
                Ok(t) => *slot = Some(t),
                Err(e) => {
                    // Верхняя строка ошибки (e.to_string()) уже по-английски
                    // — её добавляет .context(...) в whisper.rs. В лог уводим
                    // полную цепочку: причина внутри неё (whisper.cpp,
                    // файловая система) пользователю не нужна.
                    eprintln!("модель whisper не загрузилась: {e:?}");
                    return emit_error(&app, e.to_string());
                }
            }
        }
        let result = slot
            .as_ref()
            .unwrap()
            .transcribe(&pcm, &language, vad_model_path.as_deref());
        drop(slot);

        match result {
            Ok(text) if text.is_empty() => {
                emit_error(&app, "Nothing was transcribed. Try again and speak clearly.")
            }
            Ok(text) => {
                let _ = app.emit_to("overlay", "transcript", text);
            }
            Err(e) => {
                // Тот же приём: верхнее сообщение из .context(...) уже
                // по-английски и полезно пользователю («recording too
                // short…»), а полную цепочку — в лог, без содержимого записи.
                eprintln!("расшифровка не удалась: {e:?}");
                emit_error(&app, e.to_string())
            }
        }
    });
}

#[tauri::command]
pub fn start_recording(app: AppHandle) {
    begin_recording(&app);
}

#[tauri::command]
pub fn stop_recording(app: AppHandle) {
    end_recording(&app);
}

#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    model::CATALOG.to_vec()
}

#[tauri::command]
pub async fn download_model(app: AppHandle, id: String) -> Result<String, String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let path = model::download(&app, &dir, &id)
        .await
        .map_err(|e| e.to_string())?;

    // Сразу прописываем путь в настройки — пользователю не надо копировать его руками.
    // Чтение, запись на диск и обновление состояния — одна критическая секция:
    // иначе между чтением клона и записью обратно можно потерять правку,
    // которую пользователь успел сохранить через save_settings, пока модель качалась.
    let state = app.state::<AppState>();
    {
        let mut guard = state.settings.lock().unwrap();
        let mut candidate = guard.clone();
        candidate.model_path = Some(path.clone());
        settings::save(&dir, &candidate).map_err(|e| e.to_string())?;
        *guard = candidate;
        // I1: save_settings уже сбрасывает transcriber при смене настроек —
        // download_model меняет model_path в обход неё и должен делать тот
        // же однострочный сброс. Без него скачал большую модель — а
        // продолжаешь получать результаты старой, без единого признака.
        *state.transcriber.lock().unwrap() = None;
    }

    Ok(path.to_string_lossy().to_string())
}

/// VAD — отдельный от моделей транскрипции артефакт (см. `model.rs`): ровно
/// один файл, без выбора размера, поэтому и своя команда без параметра `id`.
#[tauri::command]
pub async fn download_vad_model(app: AppHandle) -> Result<String, String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let path = model::download_vad(&app, &dir)
        .await
        .map_err(|e| e.to_string())?;

    let state = app.state::<AppState>();
    {
        let mut guard = state.settings.lock().unwrap();
        let mut candidate = guard.clone();
        candidate.vad_model_path = Some(path.clone());
        settings::save(&dir, &candidate).map_err(|e| e.to_string())?;
        *guard = candidate;
        // VAD-путь читается заново из настроек на каждую расшифровку (см.
        // `end_recording`), а не кэшируется внутри `Transcriber` — сбрасывать
        // transcriber тут не нужно, в отличие от смены модели транскрипции.
    }

    Ok(path.to_string_lossy().to_string())
}

/// Разбирает строку хоткея и регистрирует комбинацию. Вызывается на старте
/// и из `save_settings`.
///
/// Порядок специально такой: сначала пробуем зарегистрировать НОВУЮ
/// комбинацию, и только при успехе снимаем старую. Опечатка или комбинация,
/// занятая другим приложением, не должна убивать уже работающий хоткей —
/// единственный вход в продукт.
///
/// Флаг `hotkey_ok` эта функция выставляет только в `true` при успехе:
/// успех однозначно значит, что ДЕЙСТВУЮЩИЙ хоткей исправен. Провал — нет:
/// при смене хоткея провал ничего не меняет, прежний хоткей как работал,
/// так и работает, и флаг не должен начать врать про него. Единственный
/// случай, когда провал реально означает «хоткей не работает», — это старт
/// приложения без предыдущей рабочей регистрации, и это знает только
/// вызывающая сторона (`main.rs`), а не эта функция.
pub fn register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let result = try_register_hotkey(app, hotkey);
    if result.is_ok() {
        *app.state::<AppState>().hotkey_ok.lock().unwrap() = true;
    }
    result
}

fn try_register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| anyhow::anyhow!("Couldn't parse hotkey combination \"{hotkey}\": {e}."))?;

    let gs = app.global_shortcut();

    // Комбинация не изменилась и уже активна — снимать и перевешивать нечего.
    if gs.is_registered(shortcut) {
        return Ok(());
    }

    gs.on_shortcut(shortcut, move |app, _shortcut, event| match event.state() {
        ShortcutState::Pressed => hotkey_pressed(app),
        ShortcutState::Released => hotkey_released(app),
    })
    .map_err(|e| anyhow::anyhow!("Couldn't register hotkey combination: {e}."))?;

    // Новая комбинация подтверждена рабочей — теперь можно снять старую.
    let state = app.state::<AppState>();
    let mut current = state.current_hotkey.lock().unwrap();
    if let Some(prev) = current.take() {
        let _ = gs.unregister(prev);
    }
    *current = Some(shortcut);

    Ok(())
}

/// C1 / «Запись хоткея нажатием»: проверяет, что строка разбирается в
/// валидную комбинацию `global-hotkey`, не регистрируя её. Фронтенд зовёт
/// это сразу после записи нажатия — расхождение с реальным форматом крейта
/// должно всплыть понятным сообщением, а не мёртвым хоткеем.
#[tauri::command]
pub fn validate_hotkey(hotkey: String) -> Result<(), String> {
    hotkey
        .parse::<Shortcut>()
        .map(|_| ())
        .map_err(|e| format!("This key combination isn't supported: {e}."))
}

#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn paste_text(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| e.to_string())?;

    let pid = *app.state::<AppState>().prev_app_pid.lock().unwrap();

    // Панель прячем до возврата фокуса: пока она на экране, активным
    // приложением может быть она сама, а не то, куда мы хотим вставить текст.
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }

    // osascript блокирует поток на ~100 мс — уводим в фон, чтобы UI не подвисал.
    std::thread::spawn(move || {
        // Спрашиваем систему напрямую ДО фокус-ресторейшна и паузы: разбор
        // текста ошибки уже один раз подвёл (см. `permission_pane`), а без
        // права всё равно ничего не выйдет — незачем тратить фиксированную
        // паузу и цикл смены фокуса на попытку, которая гарантированно
        // провалится.
        if !macos::has_accessibility_permission() {
            show_overlay(&app);
            emit_accessibility_error(
                &app,
                ACCESSIBILITY_PERMISSION_MESSAGE,
                macos::PrivacyPane::Accessibility,
            );
            return;
        }

        if let Some(pid) = pid {
            if let Err(e) = macos::activate_pid(pid) {
                // Приложение могли закрыть между запоминанием PID и вставкой —
                // это ожидаемо, вставляем в то, что активно сейчас.
                eprintln!("не удалось вернуть фокус: {e}");
            }
            // Даём macOS домигать переключением фокуса.
            // ponytail: фиксированная пауза — угадывание, что приложение уже
            // стало активным, а не подтверждение этого. Опрос обошёлся бы ещё
            // в вызов osascript на итерацию (frontmost_pid() тоже идёт через
            // System Events). Если на медленно поднимающихся приложениях
            // текст начнёт уходить не туда — заменить на цикл опроса
            // frontmost_pid() до совпадения с запомненным `pid` вместо сна
            // фиксированной длины.
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        if let Err(e) = macos::send_paste() {
            let msg = e.to_string();
            // `send_paste` больше не ходит через osascript/System Events —
            // теперь это CGEventPost, а он в принципе не умеет сообщать об
            // отказе в праве: без Accessibility событие просто молча
            // отбрасывается системой, `send_paste` в этом случае возвращает
            // `Ok(())`. Настоящий отказ в праве уже отловлен ВЫШЕ,
            // `has_accessibility_permission()`, — сюда, в `Err`, теперь
            // попадают только сбои создания CGEventSource/CGEvent, у которых
            // нет отношения к правам. `permission_pane` здесь оставлен не зря:
            // `activate_pid` (возврат фокуса) выше по-прежнему идёт через
            // osascript и может вернуть Automation-код (-1743) или один из
            // Accessibility-кодов — но его ошибка сейчас только логируется
            // (см. `eprintln!` выше) и в `msg` не попадает, так что при
            // реальном использовании эта ветка `Some(pane)` не срабатывает;
            // проверка остаётся как защита на случай, если сообщение
            // `send_paste` когда-нибудь снова станет проходить через текст
            // ошибки внешнего процесса.
            if let Some(pane) = macos::permission_pane(&msg) {
                show_overlay(&app);
                let text = match pane {
                    macos::PrivacyPane::Automation => AUTOMATION_PERMISSION_MESSAGE,
                    macos::PrivacyPane::Accessibility => ACCESSIBILITY_PERMISSION_MESSAGE,
                };
                emit_accessibility_error(&app, text, pane);
            } else {
                // Технические детали — только в лог: в них нет распознанной речи,
                // но и пользователю они ничего не объясняют.
                eprintln!("вставка не удалась: {msg}");
                show_overlay(&app);
                // I5: буфер обмена уже получил текст первой строкой этой
                // команды — при отказе автоматической вставки говорим об
                // этом прямо, а не оставляем тупик.
                emit_error(
                    &app,
                    "Couldn't paste automatically. The text is already on your clipboard — \
                     press Cmd+V to paste it manually.",
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn open_privacy_pane(pane: macos::PrivacyPane) {
    macos::open_privacy_pane(pane);
}

/// Отдаёт PCM последней завершённой записи (16 кГц моно) для воспроизведения
/// через WebAudio на фронтенде. `None`, если ещё ничего не записали.
#[tauri::command]
pub fn get_last_recording(app: AppHandle) -> Option<Vec<f32>> {
    app.state::<AppState>().last_recording.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Дефолтный хоткей — Cmd+T. Фронтенд собирает акселератор из
    /// `KeyboardEvent.code` ("KeyT" для клавиши T) и имени модификатора
    /// ("Super" для Cmd), так что строка по умолчанию должна быть именно
    /// такой формы — иначе `Settings::default().hotkey` не разберётся тем
    /// же парсером, что и хоткей, записанный руками в настройках.
    #[test]
    fn default_hotkey_accelerator_parses() {
        assert!(validate_hotkey("Super+KeyT".to_string()).is_ok());
        assert_eq!(
            "Super+KeyT".to_string(),
            crate::settings::Settings::default().hotkey
        );
    }
}
