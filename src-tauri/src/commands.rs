use crate::model::{self, ModelInfo};
use crate::settings::{self, Settings};
use crate::state::AppState;
use tauri::{AppHandle, Emitter, Manager, State};
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

// ponytail: не вызывается до Task 6/7 (ошибки распознавания речи), функция
// объявлена сейчас по контракту интерфейса — усложнять не время.
#[allow(dead_code)]
pub fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let message = message.into();
    let _ = app.emit_to("overlay", "error", message);
}

/// Хоткей зажат: показываем панель и начинаем запись.
pub fn hotkey_pressed(app: &AppHandle) {
    show_overlay(app);
    let _ = app.emit_to("overlay", "rec:start", ());
}

/// Хоткей отпущен: останавливаем запись и запускаем расшифровку.
pub fn hotkey_released(app: &AppHandle) {
    let _ = app.emit_to("overlay", "rec:stop", ());
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
    let state = app.state::<AppState>();
    let mut s = state.settings.lock().unwrap().clone();
    s.model_path = Some(path.clone());
    settings::save(&dir, &s).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = s;

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
