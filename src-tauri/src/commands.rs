use crate::audio::Recorder;
use crate::macos;
use crate::model::{self, ModelInfo};
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::whisper::Transcriber;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Папка данных приложения; создаётся при первом обращении.
pub fn data_dir(app: &AppHandle) -> anyhow::Result<std::path::PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow::anyhow!("нет доступа к папке данных: {e}"))?;
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    settings::save(&dir, &settings).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;

    // Путь к модели или язык могли поменяться — перезагрузим модель при следующей записи.
    *state.transcriber.lock().unwrap() = None;

    // Клонируем строку и сразу отпускаем мьютекс — register_hotkey не должен
    // вызываться с удерживаемой блокировкой настроек.
    let hotkey = state.settings.lock().unwrap().hotkey.clone();
    register_hotkey(&app, &hotkey).map_err(|e| e.to_string())?;

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

/// Отказ в правах — единственная ошибка, из которой пользователь может
/// выйти сам, поэтому у неё отдельное событие: панель вешает кнопку на
/// него, а не на подстроку в тексте, который могут переформулировать.
pub fn emit_accessibility_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit_to("overlay", "error:accessibility", message);
}

/// Хоткей зажат: показываем панель и начинаем запись.
pub fn hotkey_pressed(app: &AppHandle) {
    // Запоминаем, куда потом возвращать текст. Делаем это первой строкой,
    // пока панель ещё не показана и фокус точно у чужого приложения.
    *app.state::<AppState>().prev_app_pid.lock().unwrap() = crate::macos::frontmost_pid();
    show_overlay(app);
    begin_recording(app);
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
    if state.transcriber.try_lock().is_err() {
        return;
    }
    match Recorder::start() {
        Ok(rec) => {
            *slot = Some(rec);
            let _ = app.emit_to("overlay", "rec:start", ());
        }
        Err(e) => emit_error(app, format!("Микрофон недоступен: {e}")),
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
            Err(e) => return emit_error(&app, format!("Запись не удалась: {e}")),
        };
        // Длительность логируем, содержимое — никогда.
        eprintln!("записано сэмплов: {}", pcm.len());

        let state = app.state::<AppState>();
        let (model_path, language) = {
            let s = state.settings.lock().unwrap();
            (s.model_path.clone(), s.language.clone())
        };

        let Some(model_path) = model_path else {
            return emit_error(&app, "Модель не выбрана — открой настройки и скачай её");
        };

        // Загружаем модель один раз и держим в памяти.
        let mut slot = state.transcriber.lock().unwrap();
        if slot.is_none() {
            match Transcriber::load(&model_path) {
                Ok(t) => *slot = Some(t),
                Err(e) => return emit_error(&app, e.to_string()),
            }
        }
        let result = slot.as_ref().unwrap().transcribe(&pcm, &language);
        drop(slot);

        match result {
            Ok(text) if text.is_empty() => emit_error(&app, "Ничего не распознано"),
            Ok(text) => {
                let _ = app.emit_to("overlay", "transcript", text);
            }
            Err(e) => emit_error(&app, e.to_string()),
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
    }

    Ok(path.to_string_lossy().to_string())
}

/// Снимает все прежние хоткеи и вешает новый. Вызывается на старте и
/// после сохранения настроек.
pub fn register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let shortcut: Shortcut = hotkey
        .parse()
        .map_err(|e| anyhow::anyhow!("не удалось разобрать комбинацию «{hotkey}»: {e}"))?;

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    gs.on_shortcut(shortcut, move |app, _shortcut, event| match event.state() {
        ShortcutState::Pressed => hotkey_pressed(app),
        ShortcutState::Released => hotkey_released(app),
    })?;
    Ok(())
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
            if macos::is_permission_error(&msg) {
                show_overlay(&app);
                emit_accessibility_error(
                    &app,
                    "Нет доступа к управлению приложениями. Разреши Slaive в «Универсальном доступе».",
                );
            } else {
                // Технические детали — только в лог: в них нет распознанной речи,
                // но и пользователю они ничего не объясняют.
                eprintln!("вставка не удалась: {msg}");
                show_overlay(&app);
                emit_error(&app, "Не удалось вставить текст.");
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn open_accessibility_settings() {
    macos::open_accessibility_settings();
}
