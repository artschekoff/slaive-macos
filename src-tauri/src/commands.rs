use crate::audio::Recorder;
use crate::macos;
use crate::model::{self, ModelInfo};
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::whisper::{Transcriber, MIN_SAMPLES};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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
    *state.settings.lock().unwrap() = settings;

    // Путь к модели или язык могли поменяться — перезагрузим модель при следующей записи.
    *state.transcriber.lock().unwrap() = None;

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

/// Хоткей зажат: показываем панель и начинаем запись.
pub fn hotkey_pressed(app: &AppHandle) {
    // I4: порядок специально такой. begin_recording стартует запись первой
    // строкой. Раньше первым шагом был frontmost_pid() — первый Apple Events
    // вызов приложения, который на первом запуске блокирует поток до ответа
    // пользователя на системный диалог прав, и первое слово срезалось. Захват
    // pid и показ панели идут после: show_overlay намеренно не зовёт
    // set_focus, так что активное приложение к этому моменту всё ещё то самое.
    begin_recording(app);
    *app.state::<AppState>().prev_app_pid.lock().unwrap() = crate::macos::frontmost_pid();
    show_overlay(app);
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
        // Длительность логируем, содержимое — никогда.
        eprintln!("записано сэмплов: {}", pcm.len());

        // I7: случайный тап по хоткею — самая частая ошибка первого запуска,
        // и она же самый медленный путь, если сначала грузить модель.
        // Проверяем длину записи до обращения к транскриберу.
        if pcm.len() < MIN_SAMPLES {
            return emit_error(
                &app,
                "Recording too short — hold the hotkey and speak longer.",
            );
        }

        let state = app.state::<AppState>();
        let (model_path, language) = {
            let s = state.settings.lock().unwrap();
            (s.model_path.clone(), s.language.clone())
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
        let result = slot.as_ref().unwrap().transcribe(&pcm, &language);
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
        if let Some(pid) = pid {
            if let Err(e) = macos::activate_pid(pid) {
                // Приложение могли закрыть между запоминанием PID и вставкой —
                // это ожидаемо, вставляем в то, что активно сейчас.
                eprintln!("не удалось вернуть фокус: {e}");
            }
            // Даём macOS домигать переключением фокуса.
            // ponytail: фиксированная пауза вместо подтверждения, что приложение
            // действительно стало активным. Опрос frontmost стоил бы ещё по вызову
            // osascript на итерацию. Если на медленно поднимающихся приложениях текст
            // начнёт уходить не туда — заменить на CGEvent и опрос активного окна.
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        if let Err(e) = macos::send_paste() {
            let msg = e.to_string();
            // C2: -1743 (Automation) и «not allowed assistive»/-25211
            // (Accessibility) — два разных отказа с двумя разными разделами
            // настроек. Раньше оба вели в Accessibility, где для Automation
            // нет нужного переключателя.
            if let Some(pane) = macos::permission_pane(&msg) {
                show_overlay(&app);
                let text = match pane {
                    macos::PrivacyPane::Automation => {
                        "Slaive needs permission to control System Events to bring back the app \
                         you were using. Go to System Settings → Privacy & Security → Automation \
                         → Slaive → System Events and turn it on."
                    }
                    macos::PrivacyPane::Accessibility => {
                        "Slaive needs Accessibility permission to send keystrokes to other apps. \
                         Go to System Settings → Privacy & Security → Accessibility and turn \
                         Slaive on."
                    }
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
