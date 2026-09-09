#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod commands;
mod model;
mod settings;
mod state;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::hide_overlay,
            commands::list_models,
            commands::download_model,
        ])
        .setup(|app| {
            let dir = commands::data_dir(app.handle())?;
            let loaded = settings::load(&dir);
            app.manage(state::AppState::new(loaded));

            let hotkey = app
                .state::<state::AppState>()
                .settings
                .lock()
                .unwrap()
                .hotkey
                .clone();
            if let Err(e) = commands::register_hotkey(app.handle(), &hotkey) {
                eprintln!("хоткей не зарегистрирован: {e}");
            }

            // Меню-бар приложение: без иконки в доке и без переключения по Cmd+Tab.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let settings_item = MenuItemBuilder::with_id("settings", "Настройки…").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Выход").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&settings_item, &quit_item])
                .build()?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .icon_as_template(true)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "settings" => {
                        if let Some(w) = app.get_webview_window("settings") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("не удалось запустить Slaive");
}
