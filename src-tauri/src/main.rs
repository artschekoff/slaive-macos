#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod audio;
mod commands;
mod macos;
mod model;
mod settings;
mod state;
mod whisper;

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
            commands::download_vad_model,
            commands::use_model,
            commands::delete_model,
            commands::list_input_devices,
            commands::start_recording,
            commands::stop_recording,
            commands::paste_text,
            commands::copy_text,
            commands::open_privacy_pane,
            commands::validate_hotkey,
            commands::get_last_recording,
            commands::list_ai_providers,
            commands::set_ai_key,
            commands::test_ai_connection,
            commands::run_ai_action,
            commands::cancel_ai_action,
            commands::check_accessibility_permission,
            commands::open_settings_window,
            commands::follow_to_main_window,
            commands::set_overlay_has_text,
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
                // register_hotkey сам выставляет hotkey_ok только в true (при
                // успехе смены хоткея прежний рабочий не должен помечаться
                // как сломанный из-за неудачной попытки). Только здесь, на
                // старте, провал реально означает «хоткей не работает вообще»
                // — предыдущей рабочей регистрации не было и взять флаг
                // неоткуда, кроме как выставить его явно.
                *app.state::<state::AppState>().hotkey_ok.lock().unwrap() = false;
            }

            // Без модели приложение бесполезно — сразу показываем настройки.
            if app.state::<state::AppState>().settings.lock().unwrap().model_path.is_none() {
                if let Some(w) = app.get_webview_window("settings") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }

            // Меню-бар приложение: без иконки в доке и без переключения по Cmd+Tab.
            // Временно переключается в Regular, пока открыто главное окно
            // (см. commands::show_main_window) — оно, в отличие от overlay/
            // settings, должно «жить в доке как окно приложения» (бриф).
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Настройки — тот же синглтон, что и main: без перехвата закрытия
            // крестик уничтожал бы окно по-настоящему, и следующий пункт
            // "Settings…" в трее получал бы None от get_webview_window,
            // молча не делая ничего. Симптом — "настройки открываются, пока
            // их ни разу не закроешь".
            if let Some(settings_window) = app.get_webview_window("settings") {
                let app_handle = app.handle().clone();
                settings_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("settings") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            // Главное окно — синглтон, как overlay/settings: объявлено в
            // tauri.conf.json скрытым, никогда не уничтожается, только
            // прячется. CloseRequested по умолчанию уничтожил бы окно —
            // тогда follow_to_main_window после первого закрытия навсегда
            // получал бы None от get_webview_window и тихо переставал
            // работать (та же ловушка, которой посвящён «второе окно не
            // плодить» в брифе, только с другой стороны — тут не плодить
            // некому, а вот потерять единственное легко). prevent_default +
            // hide — тот же приём, которым оверлей и настройки прячутся, а не
            // закрываются по-настоящему. Заодно возвращаем activation policy
            // обратно в Accessory: главное окно закрыто — Dock-иконка не
            // нужна, приложение снова только в строке меню.
            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("main") {
                            let _ = w.hide();
                        }
                        #[cfg(target_os = "macos")]
                        let _ = app_handle.set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                });
            }

            let settings_item = MenuItemBuilder::with_id("settings", "Settings…").build(app)?;
            let quit_item = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&settings_item, &quit_item])
                .build()?;

            // Отдельная иконка для строки меню, а не иконка приложения.
            // В режиме template macOS берёт из картинки только альфа-канал и
            // перекрашивает силуэт сама под светлую или тёмную панель. Цветная
            // иконка приложения непрозрачна по всей площади, поэтому в строке
            // меню она превратилась бы в сплошной чёрный прямоугольник.
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/tray-template.png"
            ))?;

            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
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
