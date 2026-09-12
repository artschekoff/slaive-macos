use crate::ai::{self, AiRequest, ResolvedProvider};
use crate::audio::{self, Recorder};
use crate::macos;
use crate::model::{self, ModelEntry};
use crate::settings::{self, Settings};
use crate::state::AppState;
use crate::whisper::{Transcriber, MIN_SAMPLES};
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Service-имя записей Keychain — общее для всех провайдеров, account у
/// каждой записи свой (id провайдера), так переключение провайдера не
/// затирает чужой ключ. Совпадает с bundle id приложения по соглашению
/// Keychain, но это просто строка-неймспейс, не обязана быть валидным bundle id.
const AI_KEYCHAIN_SERVICE: &str = "net.slaive.app";

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

/// Ярлыки всех окон приложения. Непрозрачность ставится сразу всем трём:
/// отдельных значений на окно нет и не планируется (бриф), а список ярлыков
/// в одном месте избавляет от вопроса «этому окну тоже надо?» при добавлении
/// четвёртого.
const WINDOW_LABELS: [&str; 3] = ["overlay", "settings", "main"];

/// Сколько непрозрачности у материала панели ЕЩЁ ДО альфы окна.
///
/// Панель — единственное окно с `transparent: true`, и её корпус нарисован
/// полупрозрачным прямо в CSS: `.chassis` в styles.css кладёт градиент с
/// альфой 0.90…0.94 плюс тонкий слой текстуры (~0.03), что в сумме даёт
/// 1-(1-0.03)(1-0.92) ≈ 0.92. У главного окна и настроек тот же `.chassis`
/// лежит на НЕПРОЗРАЧНОЙ подложке системного окна, поэтому на экране они
/// сейчас непрозрачны целиком, и там поправлять нечего.
const OVERLAY_CSS_ALPHA: f64 = 0.92;

/// Какую альфу выставить окну, чтобы на экране оно вышло ровно той
/// непрозрачности, которую попросил пользователь.
///
/// Альфа окна УМНОЖАЕТСЯ на прозрачность содержимого, поэтому одно и то же
/// значение ползунка дало бы панели 0.9 × 0.92 ≈ 0.83 против ровных 0.9 у
/// остальных двух окон, а на нижнем краю ползунка — 0.46 при заявленном полу
/// в 0.5. Полом бриф не разрешает пренебрегать, и число на ползунке обязано
/// означать одно и то же для всех трёх окон, поэтому панели альфа достаётся
/// поделённой на её собственную прозрачность.
///
/// Сверху жёсткая единица: непрозрачнее, чем непрозрачное окно, не бывает.
/// Практический смысл потолка — ползунок на 1.0 возвращает панели ровно тот
/// вид, что был до появления настройки (материал остаётся полупрозрачным сам
/// по себе, это её оформление, а не настройка).
///
/// Побочный, но полезный эффект: дорожка уровня внутри панели нарисована
/// НЕпрозрачной (`.levels` в styles.css — сплошной #0a0d12), и поправка
/// достаётся ей тоже. На дефолтных 0.9 она остаётся практически глухой
/// (0.978), а на самом прозрачном краю — 0.54 вместо 0.5, то есть прибор,
/// по которому отличают отказ в доступе к микрофону от тишины в комнате,
/// нигде не бледнее текста в остальных окнах.
fn window_alpha(label: &str, opacity: f32) -> f64 {
    let opacity = settings::clamp_window_opacity(opacity) as f64;
    if label == "overlay" {
        (opacity / OVERLAY_CSS_ALPHA).min(1.0)
    } else {
        opacity
    }
}

/// Применяет непрозрачность ко всем окнам. Зовётся на старте и при каждом
/// изменении настройки — не в цикле и не по таймеру.
///
/// Окно, которого нет, пропускается молча: панель и главное окно объявлены в
/// tauri.conf.json скрытыми и могут ещё не быть созданы, а `run_on_main_thread`
/// вернёт ошибку, если окно уже уничтожено. Ни то ни другое не повод ронять
/// команду — настройку применяют, а не спрашивают о состоянии окон.
pub fn apply_window_opacity(app: &AppHandle, opacity: f32) {
    for label in WINDOW_LABELS {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        let alpha = window_alpha(label, opacity);
        let target = window.clone();
        // AppKit требует главного потока на любую работу с окном, а команды
        // Tauri приходят с других. Указатель берём ВНУТРИ замыкания: он не
        // `Send`, и протащить его через границу потока нельзя — а вот само
        // окно `Send`.
        let _ = window.run_on_main_thread(move || {
            if let Ok(ns_window) = target.ns_window() {
                // SAFETY: главный поток (мы внутри run_on_main_thread) и
                // указатель живого окна от самого Tauri — оба условия
                // `set_window_alpha` выполнены.
                unsafe { macos::set_window_alpha(ns_window, alpha) };
            }
        });
    }
}

/// Ползунок прозрачности применяется на лету, ещё до Save: настройка
/// визуальная, и цикл «выставил вслепую → сохранил → посмотрел → вернулся
/// править» для неё бессмысленен — глазу нужен результат под рукой в тот же
/// момент. На диск при этом ничего не пишется: значение сохраняется обычной
/// кнопкой Save вместе с остальными, и закрытые без сохранения настройки
/// вернут прежнюю прозрачность при следующем запуске, как и любое другое
/// поле формы.
#[tauri::command]
pub fn set_window_opacity(app: AppHandle, opacity: f32) {
    apply_window_opacity(&app, opacity);
}

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
    /// Признак «ключ задан» на провайдера — булево, НЕ сам ключ. Ключ из
    /// Keychain в эту структуру никогда не попадает: она уходит во фронтенд
    /// как есть, а значит и в devtools, и потенциально в логи.
    pub ai_key_set: BTreeMap<String, bool>,
    /// Пик последней записи ДО усиления — ориентир для ползунка Microphone
    /// gain: без него выбор значения это гадание. `None`, пока в этом запуске
    /// ещё ничего не записали. Пока окно настроек открыто, значение
    /// обновляется событием `rec:peak` (см. `end_recording`).
    pub last_peak: Option<f32>,
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> SettingsResponse {
    let ai_key_set = ai::PROVIDERS
        .iter()
        .map(|p| (p.id.to_string(), ai_key_is_set(p.id)))
        .collect();
    SettingsResponse {
        settings: state.settings.lock().unwrap().clone(),
        hotkey_ok: *state.hotkey_ok.lock().unwrap(),
        ai_key_set,
        last_peak: *state.last_peak.lock().unwrap(),
    }
}

/// Панель сообщает, пусто ли сейчас в редакторе. Только булево: сам текст
/// (личная речь пользователя) через границу команд не ходит и не логируется,
/// а единственный источник правды по содержимому — документ CodeMirror,
/// который правит пользователь. Вместе с видимостью окна overlay это правило
/// дозаписи целиком, см. `is_append_session`.
#[tauri::command]
pub fn set_overlay_has_text(state: State<'_, AppState>, has_text: bool) {
    *state.overlay_has_text.lock().unwrap() = has_text;
}

/// Keychain-доступ — единственное место в кодовой базе, где он происходит.
/// `ai.rs` намеренно ничего об этом не знает (см. его doc-комментарий):
/// `ResolvedProvider` собирается здесь же, из настроек плюс ключа отсюда.
fn ai_keychain_entry(provider: &str) -> anyhow::Result<keyring::Entry> {
    keyring::Entry::new(AI_KEYCHAIN_SERVICE, provider)
        .map_err(|e| anyhow::anyhow!("Couldn't access the system Keychain: {e}."))
}

/// Признак «ключ задан» — вот что уходит во фронтенд, никогда сам ключ.
fn ai_key_is_set(provider: &str) -> bool {
    match ai_keychain_entry(provider) {
        Ok(entry) => entry.get_password().is_ok(),
        Err(_) => false,
    }
}

/// Читает ключ из Keychain для сборки `ResolvedProvider` — вызывается ТОЛЬКО
/// из команд, которые сами делают сетевой запрос (`test_ai_connection`),
/// никогда не возвращается наружу как есть.
fn ai_read_key(provider: &str) -> Option<String> {
    match ai_keychain_entry(provider) {
        Ok(entry) => match entry.get_password() {
            Ok(key) => Some(key),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => {
                // Само значение ключа никогда не логируется — только факт сбоя.
                eprintln!("не удалось прочитать ключ из Keychain: {e}");
                None
            }
        },
        Err(e) => {
            eprintln!("keychain недоступен: {e}");
            None
        }
    }
}

/// Кладёт ключ в Keychain под записью, привязанной к id провайдера — у
/// каждого провайдера своя запись, они не затирают друг друга.
fn ai_store_key(provider: &str, key: &str) -> anyhow::Result<()> {
    let entry = ai_keychain_entry(provider)?;
    entry
        .set_password(key)
        .map_err(|e| anyhow::anyhow!("Couldn't save the key to Keychain: {e}."))
}

#[tauri::command]
pub fn list_ai_providers() -> Vec<ai::ProviderInfo> {
    ai::PROVIDERS.to_vec()
}

/// Кладёт ключ провайдера в Keychain. Ключ никогда не проходит через
/// `settings.json` и никогда не возвращается обратно во фронтенд — только
/// признак «задан» через `get_settings.aiKeySet`.
#[tauri::command]
pub fn set_ai_key(provider: String, key: String) -> Result<(), String> {
    if ai::provider_info(&provider).is_none() {
        return Err(format!("Unknown provider: {provider}."));
    }
    let key = key.trim();
    if key.is_empty() {
        return Err("API key can't be empty.".to_string());
    }
    ai_store_key(&provider, key).map_err(|e| e.to_string())
}

/// Резолвит текущего выбранного провайдера в `ResolvedProvider` — общий путь
/// для `test_ai_connection` (пробный запрос из настроек) и `run_ai_action`
/// (реальное действие меню главного окна): обоим нужен один и тот же набор
/// проверок (провайдер известен и реализован, для него сохранена
/// конфигурация) и одни и те же сообщения об ошибке — раньше это было
/// продублировано только в `test_ai_connection`, второй копии в `run_ai_action`
/// не заводим.
fn resolve_current_provider(state: &State<'_, AppState>) -> Result<ResolvedProvider, String> {
    let (provider_id, config) = {
        let s = state.settings.lock().unwrap();
        let id = s.ai.provider.clone();
        let config = s.ai.providers.get(&id).cloned();
        (id, config)
    };

    let info = ai::provider_info(&provider_id)
        .ok_or_else(|| format!("Unknown provider: {provider_id}."))?;
    if !info.implemented {
        return Err(format!("{} isn't implemented yet.", info.label));
    }
    let config = config.ok_or_else(|| {
        format!("No configuration saved for {}. Open Settings to configure it.", info.label)
    })?;

    Ok(ResolvedProvider {
        id: provider_id.clone(),
        model: config.model,
        base_url: config.base_url,
        api_key: ai_read_key(&provider_id),
    })
}

/// Кнопка «Проверить соединение» в настройках — единственное место, откуда
/// уходит реальный сетевой запрос к провайдеру, и только по явному нажатию
/// (см. бриф: никаких фоновых запросов). Короткий пробный запрос, ответ не
/// возвращается пользователю — важен только факт успеха/ошибки.
#[tauri::command]
pub async fn test_ai_connection(state: State<'_, AppState>) -> Result<String, String> {
    let resolved = resolve_current_provider(&state)?;
    let req = AiRequest {
        system: "You are a connectivity test.".to_string(),
        user: "Reply with a single word: pong.".to_string(),
    };

    ai::complete(&resolved, req)
        .await
        .map(|_| "Connected.".to_string())
        .map_err(|e| e.to_string())
}

/// Единственная сетевая точка входа для действий меню главного окна
/// (Translate/Ask AI/Fix/Shorten/Summarize) — уходит в сеть ТОЛЬКО когда её вызвали, то
/// есть только по явному нажатию действия во фронтенде (см. бриф: ни при
/// открытии окна, ни при получении текста запросов быть не должно). Дерево
/// действий, подписи и системные промпты целиком живут во фронтенде (см.
/// бриф: «уровни описывай данными»), сюда прилетают уже готовые system+user —
/// эта команда лишь резолвит провайдера (тем же путём, что и
/// `test_ai_connection`) и зовёт `ai::complete`.
///
/// Текст пользователя (`user`) нигде не логируется — ни здесь, ни ниже по
/// стеку в `ai.rs` (см. его doc-комментарий): при ошибке в лог уходит только
/// классифицирующая информация (код статуса, тип сетевого сбоя), не текст.
#[tauri::command]
pub async fn run_ai_action(
    state: State<'_, AppState>,
    system: String,
    user: String,
) -> Result<String, String> {
    let resolved = resolve_current_provider(&state)?;
    let req = AiRequest { system, user };
    let cancel = state.ai_cancel.clone();

    // Гонка запроса с сигналом отмены. Проигравшая ветка сбрасывается —
    // а сброшенная футура reqwest закрывает соединение, то есть запрос
    // действительно прекращается, а не доигрывает в фоне, списывая токены
    // за ответ, который никто не увидит.
    tokio::select! {
        result = ai::complete(&resolved, req) => result.map_err(|e| e.to_string()),
        _ = cancel.notified() => Err("Cancelled.".to_string()),
    }
}

/// Прерывает текущий запрос к ИИ. Безопасно вызывать, когда запроса нет:
/// `notify_waiters` никого не будит, если никто не ждёт.
#[tauri::command]
pub fn cancel_ai_action(state: State<'_, AppState>) {
    state.ai_cancel.notify_waiters();
}

/// Право на отправку синтетических нажатий — тот же самый источник правды,
/// что использует `paste_text` перед реальной попыткой (см.
/// `macos::has_accessibility_permission`). Фронтенд зовёт эту команду ДО
/// `paste_text`, чтобы решить, показывать ли блокирующий модальный слой, не
/// проходя вслепую через скрытие/показ панели и фиксированную паузу
/// (см. `paste_text`) ради попытки, которая заведомо провалится, если права
/// нет уже сейчас. Сам `paste_text` при этом свою проверку не теряет — это
/// разные вызовы, а не единственный путь: между этой проверкой и настоящей
/// попыткой вставки право теоретически может быть отозвано, и тот случай
/// по-прежнему ловит уже существующий путь `error:accessibility`.
#[tauri::command]
pub fn check_accessibility_permission() -> bool {
    macos::has_accessibility_permission()
}

/// Открывает окно настроек — та же логика, что в обработчике пункта трея
/// «Settings…» (main.rs), но доступная и как команда: кнопка «Open Settings»
/// в модальном слое главного окна и в баннере ошибки провайдера зовут её
/// напрямую, вместо того чтобы дублировать эти две строки в каждом месте,
/// откуда нужен путь в настройки.
#[tauri::command]
pub fn open_settings_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: Settings,
) -> Result<(), String> {
    // Приходит из формы, где ползунок уже ограничен, — но команду можно
    // позвать и мимо формы, а невидимое окно настроек не починишь из него же.
    settings.window_opacity = settings::clamp_window_opacity(settings.window_opacity);

    // C1: разобрать и зарегистрировать новый хоткей ДО того, как что-либо
    // запишется на диск или в состояние. Если регистрация упала — опечатка
    // или комбинация занята другим приложением — ничего не сохраняем, и
    // прежний рабочий хоткей остаётся на месте вместо того, чтобы быть
    // затёртым битой строкой.
    register_hotkey(&app, &settings.hotkey).map_err(|e| e.to_string())?;

    // Провайдер, который ещё не реализован (или неизвестен), не должен
    // осесть в settings.json как выбранный — интерфейс его показывает, но
    // выбрать нельзя (см. бриф). Проверка здесь, а не только на фронте:
    // фронт может отставать или его можно обойти прямым вызовом команды.
    if !ai::is_selectable(&settings.ai.provider) {
        return Err(format!(
            "\"{}\" isn't implemented yet — pick another provider.",
            settings.ai.provider
        ));
    }

    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    settings::save(&dir, &settings).map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings.clone();

    // Путь к модели или язык могли поменяться — перезагрузим модель при следующей записи.
    *state.transcriber.lock().unwrap() = None;

    // Ползунок применяет прозрачность на лету и сюда доходит уже применённой.
    // Повтор нужен для другого пути: значение могло поменяться мимо ползунка
    // (правка settings.json руками, откат формы), и тогда сохранённое и
    // показанное на экране разошлись бы до перезапуска.
    apply_window_opacity(&app, settings.window_opacity);

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

/// Забирает нативный фокус у панели. Зовётся ТОЛЬКО в момент, когда решение
/// по записи уже принято — транскрипт готов либо показана ошибка, — а не при
/// открытии панели: до этого момента исходное приложение должно оставаться
/// активным (см. `show_overlay`). К моменту вызова запись уже остановлена
/// (или не начиналась вовсе — I2/I8-ошибки из `begin_recording`), поэтому
/// забрать фокус здесь ничему не мешает: PID исходного приложения уже
/// запомнен в `prev_app_pid`, а Paste сам восстанавливает фокус на него перед
/// отправкой нажатия.
///
/// Взводит `overlay_took_focus` — по этому флагу `hide_overlay` решает,
/// нужно ли при закрытии панели (Escape/Close) явно возвращать фокус
/// исходному приложению: без явного возврата активным приложением остаётся
/// Slaive, а не то, откуда пользователь вызвал запись.
fn focus_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.set_focus();
    }
    *app.state::<AppState>().overlay_took_focus.lock().unwrap() = true;
}

#[tauri::command]
pub fn hide_overlay(app: AppHandle) {
    // Съедаем флаг сразу: одно закрытие — один возврат фокуса, даже если
    // Escape/Close по какой-то причине придут повторно, пока панель уже
    // скрыта.
    let took_focus = {
        let state = app.state::<AppState>();
        let mut flag = state.overlay_took_focus.lock().unwrap();
        std::mem::replace(&mut *flag, false)
    };
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
    if !took_focus {
        // Панель ни разу не забирала фокус в этом цикле (запись ещё шла или
        // расшифровывалась) — macOS ничего не переключала, возвращать нечего.
        return;
    }
    let pid = *app.state::<AppState>().prev_app_pid.lock().unwrap();
    if let Some(pid) = pid {
        // activate_pid — osascript, блокирует поток на ~100 мс (см. paste_text);
        // уводим в фон, чтобы не задерживать обработчик команды.
        std::thread::spawn(move || {
            if let Err(e) = macos::activate_pid(pid) {
                // Приложение могли закрыть, пока панель была открыта — ожидаемо.
                eprintln!("не удалось вернуть фокус при закрытии панели: {e}");
            }
        });
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

impl SourceAppPayload {
    /// Единственная точка сборки payload из платформенной структуры — её
    /// делят событие для оверлея (`emit_source_app`) и запрос главного окна
    /// (`get_source_app`). Шапка в двух окнах обязана показывать одно и то
    /// же приложение одними и теми же полями, а не два похожих набора.
    fn from_source(source: macos::SourceApp) -> Self {
        Self {
            name: source.name,
            icon: source
                .icon_png_base64
                .map(|b64| format!("data:image/png;base64,{b64}")),
        }
    }
}

/// Шлёт панели, из какого приложения вызвали запись. Зовётся с фонового
/// потока (см. `hotkey_pressed`) — к этому моменту запись уже идёт.
fn emit_source_app(app: &AppHandle, source: macos::SourceApp) {
    let _ = app.emit_to("overlay", "app:source", SourceAppPayload::from_source(source));
}

/// Приложение-источник для ШАПКИ главного окна и для решения, доступна ли в
/// нём кнопка Paste. Читает тот же `prev_app_pid`, что использует
/// `paste_text`, — второго понятия «куда вставлять» не заводится.
///
/// `None` значит ровно одно: цели нет — либо окно открыли без
/// предшествующей диктовки (`prev_app_pid` пуст), либо приложение с тех пор
/// закрылось и `resolve_app` не находит процесс. Фронтенд показывает оба
/// случая одинаково: шапка «No source app», кнопка Paste выключена с
/// объяснением.
///
/// Команда асинхронная и уводит работу в `spawn_blocking` не для красоты:
/// синхронная команда Tauri выполняется на главном потоке, а `resolve_app`
/// форкает до трёх системных инструментов (`ps`, `PlistBuddy`, `sips`) — на
/// главном потоке это заметное подвисание окна. Сама функция разрешения та
/// же, что у оверлея (`hotkey_pressed` зовёт её на своём фоновом потоке), а
/// не вторая: ни AppleScript, ни системного диалога прав здесь не возникает.
#[tauri::command]
pub async fn get_source_app(app: AppHandle) -> Option<SourceAppPayload> {
    let pid = {
        let state = app.state::<AppState>();
        let pid = *state.prev_app_pid.lock().unwrap();
        pid
    }?;
    tauri::async_runtime::spawn_blocking(move || macos::resolve_app(pid))
        .await
        .ok()
        .flatten()
        .map(SourceAppPayload::from_source)
}

/// Правило дозаписи целиком: **панель открыта и в ней есть текст** — запись
/// дописывается к тому, что есть; панель была закрыта — новая запись с
/// чистого листа. Отдельной кнопки «дописать» нет, поведение выводится из
/// состояния.
///
/// Оба условия читаются здесь, на бэкенде, и только здесь: решение обязано
/// быть ОДНО на текст, PCM и дорожку уровня — иначе они разъедутся по разным
/// режимам (текст накопленный, а `Play` играет только последний фрагмент).
/// Видимость окна — источник правды по «панель открыта»; `overlay_has_text`
/// сообщает фронтенд по изменению документа редактора (см.
/// `set_overlay_has_text`), потому что источник правды по тексту — сам
/// редактор, который пользователь правит руками.
///
/// Важно, ЧТО именно вызывается до этой проверки: в `hotkey_pressed`
/// `show_overlay` идёт ПОСЛЕ, так что «панель была закрыта» здесь ещё видно.
fn is_append_session(app: &AppHandle) -> bool {
    let visible = app
        .get_webview_window("overlay")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    visible && *app.state::<AppState>().overlay_has_text.lock().unwrap()
}

/// Какой PID запомнить как приложение-источник, когда начинается новая (не
/// дозапись) сессия. `current` — то, что уже запомнено, `frontmost` — то, что
/// отдал `macos::frontmost_pid()`, `own_pid` — PID самого Slaive.
///
/// Единственное правило, ради которого функция существует: **Slaive не может
/// быть целью вставки**. Хоткей глобальный, поэтому запись можно начать,
/// когда впереди сам Slaive — с открытым главным окном это уже не крайний
/// случай, а обычный ход событий (Follow → правки в главном окне → вспомнил,
/// что сказать ещё → зажал хоткей). Оверлей фокуса не забирает, но
/// `frontmost_pid()` в этот момент честно вернёт PID Slaive, и без этой
/// проверки прежняя цель была бы затёрта им: Paste после этого отправлял бы
/// Cmd+V в собственное окно приложения.
///
/// Во всех остальных случаях поведение прежнее, включая `None` от
/// `frontmost_pid()` (osascript не ответил): цель снимается, и `paste_text`
/// вставляет в то, что активно на момент вставки.
fn next_source_pid(current: Option<i32>, frontmost: Option<i32>, own_pid: i32) -> Option<i32> {
    match frontmost {
        Some(pid) if pid == own_pid => current,
        other => other,
    }
}

/// Хоткей зажат: показываем панель и начинаем запись.
pub fn hotkey_pressed(app: &AppHandle) {
    // Тот же вопрос, что задаёт себе begin_recording ниже, и с тем же
    // ответом: между этими двумя вызовами ничего не показывает панель и не
    // меняет текст (`show_overlay` идёт после), так что оба читают одно
    // состояние. Спрашиваем здесь отдельно, чтобы `begin_recording` осталась
    // общей точкой входа для хоткея и клика по микрофону без возвращаемого
    // значения, которое нужно было бы трактовать на каждой её ранней ветке.
    let append = is_append_session(app);

    // I4: порядок специально такой. begin_recording стартует запись первой
    // строкой. Раньше первым шагом был frontmost_pid() — первый Apple Events
    // вызов приложения, который на первом запуске блокирует поток до ответа
    // пользователя на системный диалог прав, и первое слово срезалось. Захват
    // pid и показ панели идут после: show_overlay намеренно не зовёт
    // set_focus, так что активное приложение к этому моменту всё ещё то самое.
    begin_recording(app);
    if !append {
        // Дозапись НЕ трогает ни pid, ни шапку источника — и это обязательно,
        // а не оптимизация. К моменту повторного нажатия панель уже забрала
        // фокус (готовый транскрипт, см. `focus_overlay`), поэтому активным
        // приложением сейчас является сам Slaive: перезапись `prev_app_pid`
        // тем, что вернёт `frontmost_pid()`, направила бы Paste в панель
        // вместо приложения, откуда пришла запись. Приложение-источник у
        // накопленного текста одно на всю сессию — то, где нажали хоткей в
        // первый раз.
        //
        // Вторая, отдельная защита — `next_source_pid`: даже при новой записи
        // Slaive не может стать целью вставки сам (см. её doc-комментарий).
        // frontmost_pid() — osascript, он блокирует поток; спрашиваем его ДО
        // взятия блокировки, а не под ней.
        let frontmost = crate::macos::frontmost_pid();
        let own_pid = std::process::id() as i32;
        let pid = {
            let state = app.state::<AppState>();
            let mut slot = state.prev_app_pid.lock().unwrap();
            *slot = next_source_pid(*slot, frontmost, own_pid);
            *slot
        };

        // Разрешение имени/иконки приложения-источника — три форка system-
        // инструментов (ps, PlistBuddy, при наличии иконки ещё и sips) — на
        // фоновом потоке, а не здесь: запись уже идёт (begin_recording — выше
        // по функции), и хот-путь записи не должен ждать этого. Шапка панели
        // появится на кадр позже, уже поверх идущей записи.
        if let Some(pid) = pid {
            let app = app.clone();
            std::thread::spawn(move || {
                if let Some(source) = macos::resolve_app(pid) {
                    emit_source_app(&app, source);
                }
            });
        }
    }
    show_overlay(app);
}

/// Хоткей отпущен: останавливаем запись и запускаем расшифровку.
pub fn hotkey_released(app: &AppHandle) {
    end_recording(app);
}

/// Общая логика старта записи — используется и хоткеем, и кликом по микрофону.
pub fn begin_recording(app: &AppHandle) {
    // Решение «дозапись или заново» принимается ровно здесь и запоминается на
    // всю запись: `end_recording` (склейка PCM), панель (текст и дорожка
    // уровня) и `hotkey_pressed` (фокус, шапка источника) обязаны действовать
    // в одном режиме. Читать состояние повторно в конце записи было бы
    // ошибкой: пользователь может успеть очистить текст, пока говорит, и
    // тогда звук склеился бы, а текст — нет.
    //
    // Спрашиваем ДО взятия блокировки recorder: `is_visible()` у окна — это
    // круг через главный поток, и держать на нём чужой мьютекс незачем.
    let append = is_append_session(app);

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
    // Устройство выбирается один раз, на старте записи. Менять его посреди
    // записи нельзя — выбор применяется к следующей (см. бриф).
    let preferred = state.settings.lock().unwrap().input_device.clone();
    match Recorder::start(preferred) {
        Ok(rec) => {
            // Сохранённого устройства не нашлось — пишем с умолчания, но
            // молчать об этом нельзя: человек будет думать, что диктует в
            // iPhone. Событие отдельное от `error`: запись идёт, и панель не
            // должна свалиться в фазу ошибки.
            if let Some(missing) = rec.fell_back_from() {
                let _ = app.emit_to(
                    "overlay",
                    "rec:device-fallback",
                    format!(
                        "\"{missing}\" isn't connected — recording with the system default microphone instead."
                    ),
                );
            }
            *slot = Some(rec);
            *state.appending.lock().unwrap() = append;

            if !append {
                // Новый цикл записи начинается «с чистого листа» по фокусу:
                // если предыдущий цикл его забирал (готовый транскрипт/
                // ошибка), этот факт не должен пережить повторное нажатие
                // хоткея — иначе hide_overlay могла бы попытаться вернуть
                // фокус ещё до того, как эта запись вообще что-то показала.
                // При дозаписи всё наоборот: панель фокус УЖЕ забрала, и
                // сбросить флаг значило бы потерять возврат фокуса
                // исходному приложению при закрытии по Escape.
                *state.overlay_took_focus.lock().unwrap() = false;
                // Панель сейчас очистит редактор (см. обработчик `rec:start`),
                // и её `set_overlay_has_text(false)` придёт следом. Не ждём
                // этого круга: следующее нажатие хоткея не должно попасть на
                // ещё не обновлённое «текст есть» и посчитать себя дозаписью.
                *state.overlay_has_text.lock().unwrap() = false;
            }

            // Флаг публикуем, ЕЩЁ держа блокировку `state.recorder` (слот
            // жив до `drop(slot)` ниже). Пока лок держим мы, end_recording
            // не может забрать recorder — а значит не может проскочить мимо
            // ещё не записанного флага и остаться с потоком без адресата
            // остановки. Обоснование через happens-before — в отчёте.
            let stop = Arc::new(AtomicBool::new(false));
            *state.level_emitter_stop.lock().unwrap() = Some(stop.clone());
            spawn_level_emitter(app.clone(), stop);

            drop(slot);
            // Режим едет вместе с событием, а не выводится панелью
            // самостоятельно: одно решение — один источник (см.
            // `is_append_session`).
            let _ = app.emit_to("overlay", "rec:start", RecStartPayload { append });
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

/// Старт записи: панели важно, дозапись это или новая запись — от этого
/// зависит, чистить ли текст и дорожку уровня.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecStartPayload {
    pub append: bool,
}

/// Готовая расшифровка. `append` дублирует режим из `rec:start` намеренно:
/// событие самодостаточно, панели не приходится помнить режим между двумя
/// событиями и рисковать разъездом, если одно из них потеряется.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPayload {
    pub text: String,
    pub append: bool,
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
                emit_error(&app, "Recording failed. Try again.");
                // Панель уже показана (show_overlay отработал в hotkey_pressed
                // ДО того, как эта запись вообще начала останавливаться) — тут
                // и далее по функции забираем фокус на каждом терминальном
                // исходе (успех и ошибка одинаково), чтобы Escape/Close и
                // Paste/Copy работали без клика. См. focus_overlay.
                return focus_overlay(&app);
            }
        };
        // `state` берём здесь же, от уже переехавшего в поток владения `app` —
        // внешний `state` из начала функции жив только до
        // `std::thread::spawn` и не может быть захвачен `move`-замыканием.
        let state = app.state::<AppState>();
        // Режим зафиксирован в `begin_recording` и с тех пор не пересматривается.
        let append = *state.appending.lock().unwrap();

        // Пиковая амплитуда — диагностика ради которой всё затевалось: если
        // отказано в доступе к микрофону, macOS отдаёт поток нулей вместо
        // ошибки, и пик остаётся 0.0000 при любой длине записи. Число — не
        // содержимое речи, логировать можно. Считается по СЫРОМУ сигналу, до
        // усиления: это ориентир для ползунка Microphone gain, и подниматься
        // вместе с ним он не должен, иначе перестанет что-либо значить.
        let peak = audio::peak_amplitude(&pcm);
        *state.last_peak.lock().unwrap() = Some(peak);
        // Окно настроек, если оно открыто, показывает пик последней записи
        // рядом с ползунком — иначе выбор значения это гадание вслепую.
        let _ = app.emit_to("settings", "rec:peak", peak);

        let (model_path, language, vad_model_path, mic_gain, vad_threshold, dictionary) = {
            let s = state.settings.lock().unwrap();
            (
                s.model_path.clone(),
                s.language.clone(),
                s.vad_model_path.clone(),
                s.mic_gain,
                s.vad_threshold,
                s.dictionary.clone(),
            )
        };
        // Затравка собирается ровно здесь и не логируется: словарь — тоже
        // личные данные пользователя, как и сама расшифровка.
        let initial_prompt = crate::whisper::initial_prompt(&dictionary);

        // Усиление применяется здесь и только здесь — к копии PCM, которая
        // уходит в VAD и whisper (`transcribe` получает уже усиленное). Ни
        // дорожка уровня, ни `Play` его не видят: дорожка рисуется из пиков,
        // посчитанных в колбэке микрофона внутри `audio::Recorder`, а в
        // `last_recording` ниже кладётся сырая запись.
        let boosted = audio::apply_gain(&pcm, mic_gain);
        let boosted_peak = audio::peak_amplitude(&boosted);
        // Оба пика в лог — так видно, работает ли настройка. Оба числа,
        // содержимое речи по-прежнему не логируется.
        eprintln!(
            "записано сэмплов: {}, пик до усиления: {peak:.4}, усиление: {mic_gain:.2}x, пик после: {boosted_peak:.4}, дозапись: {append}",
            pcm.len()
        );

        // Кладём PCM в состояние для воспроизведения независимо от исхода
        // расшифровки ниже — короткую или беззвучную запись тоже полезно
        // прослушать, чтобы понять, что произошло. При дозаписи новый
        // фрагмент ПРОДОЛЖАЕТ предыдущий, а не заменяет его: иначе текст был
        // бы накопленным, а `Play` играл бы только последний кусок.
        // Сохраняем сырое, до усиления: это запись как она есть, а усиление —
        // параметр распознавания, а не свойство записи.
        {
            let mut slot = state.last_recording.lock().unwrap();
            let combined = match slot.as_ref() {
                Some(prev) if append => audio::concat_pcm(prev, &pcm),
                _ => pcm.clone(),
            };
            *slot = Some(combined);
        }

        // I7: случайный тап по хоткею — самая частая ошибка первого запуска,
        // и она же самый медленный путь, если сначала грузить модель.
        // Проверяем длину записи до обращения к транскриберу. При дозаписи
        // проверяется ДОБАВКА, а не накопленное: слишком короткий фрагмент
        // ведёт себя как при первой записи — сообщение, прежний текст цел
        // (панель трогает документ только по событию `transcript`).
        if pcm.len() < MIN_SAMPLES {
            emit_error(
                &app,
                "Recording too short — hold the hotkey and speak longer.",
            );
            return focus_overlay(&app);
        }

        let Some(model_path) = model_path else {
            emit_error(&app, "No model selected. Open Settings and download one.");
            return focus_overlay(&app);
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
                    emit_error(&app, e.to_string());
                    return focus_overlay(&app);
                }
            }
        }
        // В whisper (и в VAD внутри него) уходит УСИЛЕННАЯ копия, а не сырая:
        // на тихом входе VAD с порогом вероятности может не увидеть речи
        // вовсе и вырезать всё, а whisper распознаёт хуже.
        let result = slot.as_ref().unwrap().transcribe(
            &boosted,
            &language,
            vad_model_path.as_deref(),
            vad_threshold,
            initial_prompt.as_deref(),
        );
        drop(slot);

        match result {
            Ok(text) if text.is_empty() => {
                emit_error(&app, "Nothing was transcribed. Try again and speak clearly.");
                focus_overlay(&app);
            }
            Ok(text) => {
                // Фокус берём СРАЗУ ПОСЛЕ эмиссии transcript, в этом же потоке
                // и в этом же порядке — гарантирует, что к моменту, когда
                // фронтенд получит событие и оживит Enter/Cmd+C, окно уже
                // нативно в фокусе. Если бы это делал фронтенд по получении
                // события, пришлось бы просить фокус через Tauri API вторым
                // отдельным вызовом — тот же результат, но без гарантии
                // порядка относительно самого события.
                // При дозаписи здесь уходит ТОЛЬКО новый фрагмент: панель
                // приклеит его к текущему содержимому редактора сама (см.
                // appendTranscript в transcript-editor.ts). Накопленный текст
                // на бэкенде не хранится и не пересобирается — иначе он
                // затёр бы правки, которые пользователь уже внёс руками.
                let _ = app.emit_to("overlay", "transcript", TranscriptPayload { text, append });
                focus_overlay(&app);
            }
            Err(e) => {
                // Тот же приём: верхнее сообщение из .context(...) уже
                // по-английски и полезно пользователю («recording too
                // short…»), а полную цепочку — в лог, без содержимого записи.
                eprintln!("расшифровка не удалась: {e:?}");
                emit_error(&app, e.to_string());
                focus_overlay(&app);
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

/// Строка VAD в разделе Models: тот же артефакт, что и модели транскрипции,
/// но без выбора размера — ровно один файл (см. `model.rs`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VadEntry {
    pub label: &'static str,
    pub note: &'static str,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub disk_bytes: Option<u64>,
}

/// Всё, что показывает раздел Models: список моделей с состоянием, строка
/// VAD и суммарно занятое место.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalog {
    pub models: Vec<ModelEntry>,
    pub vad: VadEntry,
    /// Сколько занимает папка моделей целиком, байт.
    pub disk_bytes: u64,
    /// Папка, где всё это лежит — чтобы «занято N ГБ» можно было проверить
    /// в Finder, а не поверить на слово.
    pub models_dir: String,
}

/// Список моделей со СНЯТЫМ С ДИСКА состоянием. Скачанность определяется по
/// наличию файла, а не по записи в настройках: файл могли удалить снаружи.
#[tauri::command]
pub fn list_models(app: AppHandle, state: State<'_, AppState>) -> Result<ModelCatalog, String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let models_dir = model::models_dir(&dir);
    let active = state.settings.lock().unwrap().model_path.clone();

    let vad_path = models_dir.join(model::VAD_MODEL_FILE_NAME);
    let vad_disk = std::fs::metadata(&vad_path).ok().filter(|m| m.is_file());

    Ok(ModelCatalog {
        models: model::catalog_state(&models_dir, active.as_deref()),
        vad: VadEntry {
            label: model::VAD_MODEL_LABEL,
            note: model::VAD_MODEL_NOTE,
            size_bytes: model::VAD_MODEL_SIZE_BYTES,
            downloaded: vad_disk.is_some(),
            disk_bytes: vad_disk.map(|m| m.len()),
        },
        disk_bytes: model::disk_usage(&models_dir),
        models_dir: models_dir.to_string_lossy().to_string(),
    })
}

/// Делает скачанную модель активной — подставляет её путь в настройки.
/// Ручного редактирования пути больше нет: это тот же путь, что прописывает
/// `download_model`, включая сброс транскрибера.
#[tauri::command]
pub fn use_model(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<String, String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let models_dir = model::models_dir(&dir);
    // Путь к файлу собирается только для id из каталога — та же защита от
    // подстановки произвольного пути, что и у `url_for`/`delete`.
    if !model::is_known(&id) {
        return Err(format!("Unknown model: {id}."));
    }
    if model::state_of(&models_dir, &id, None) == model::ModelState::Missing {
        return Err(format!("{id} isn't downloaded yet."));
    }
    let path = models_dir.join(model::file_name(&id));
    apply_model_path(&state, &dir, path.clone())?;
    Ok(path.to_string_lossy().to_string())
}

/// Удаляет скачанную модель. Подтверждения не спрашиваем — модель качается
/// заново одной кнопкой; активную удалить нельзя (см. `model::delete`).
#[tauri::command]
pub fn delete_model(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let models_dir = model::models_dir(&dir);
    let active = state.settings.lock().unwrap().model_path.clone();
    model::delete(&models_dir, &id, active.as_deref()).map_err(|e| e.to_string())
}

/// Список устройств записи для выпадающего списка настроек. Строится по
/// кнопке, а не один раз при старте: iPhone появляется и исчезает, и
/// требовать перезапуска приложения ради этого нельзя.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputDevices {
    pub devices: Vec<String>,
    /// Имя нынешнего системного умолчания — только подпись рядом с пунктом
    /// «System default». Выбором оно не становится: выбравший «по умолчанию»
    /// хочет следовать за системой, а не прикрепиться к сегодняшнему выбору.
    pub default_device: Option<String>,
}

#[tauri::command]
pub fn list_input_devices() -> InputDevices {
    InputDevices {
        devices: audio::list_input_devices(),
        default_device: audio::default_input_device_name(),
    }
}

/// Прописывает путь к модели в настройки: сохранение на диск, обновление
/// состояния и сброс транскрибера — одна критическая секция.
///
/// Общий путь для `download_model` и `use_model`: обе меняют `model_path` в
/// обход `save_settings`, и обе обязаны делать тот же сброс транскрибера —
/// без него пользователь продолжал бы получать результаты прежней модели
/// без единого признака того, что переключение не сработало (см. I1).
fn apply_model_path(
    state: &State<'_, AppState>,
    dir: &std::path::Path,
    path: std::path::PathBuf,
) -> Result<(), String> {
    let mut guard = state.settings.lock().unwrap();
    let mut candidate = guard.clone();
    candidate.model_path = Some(path);
    settings::save(dir, &candidate).map_err(|e| e.to_string())?;
    *guard = candidate;
    *state.transcriber.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn download_model(app: AppHandle, id: String) -> Result<String, String> {
    let dir = data_dir(&app).map_err(|e| e.to_string())?;
    let path = model::download(&app, &dir, &id)
        .await
        .map_err(|e| e.to_string())?;

    // Сразу прописываем путь в настройки — скачал значит выбрал.
    // Чтение, запись на диск и обновление состояния — одна критическая секция
    // внутри `apply_model_path`: иначе между чтением клона и записью обратно
    // можно потерять правку, которую пользователь успел сохранить через
    // save_settings, пока модель качалась.
    let state = app.state::<AppState>();
    apply_model_path(&state, &dir, path.clone())?;

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
    // Съедаем флаг здесь же: если ниже панель придётся показать заново из-за
    // отказа (права/сбой вставки), она начинает без фокуса, как и положено —
    // его выставит focus_overlay в этих же ветках, а не унаследует от цикла,
    // который уже успешно завершился этой вставкой.
    *app.state::<AppState>().overlay_took_focus.lock().unwrap() = false;

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
            // Панель снова на экране с ошибкой, которую нужно уметь закрыть
            // Escape — та же логика, что и в end_recording.
            focus_overlay(&app);
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
                focus_overlay(&app);
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
                focus_overlay(&app);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn open_privacy_pane(pane: macos::PrivacyPane) {
    macos::open_privacy_pane(pane);
}

/// Текст, который Follow передаёт из оверлея в главное окно. Отдельное
/// событие, а не переиспользование `transcript`: то слушает только оверлей и
/// означает «запись только что расшифрована», а не «открой этот текст в
/// другом окне» — смысл разный, даже когда текст один и тот же.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FollowPayload {
    pub text: String,
}

/// Показывает главное окно и поднимает его наверх. На macOS временно
/// переключает activation policy в `Regular`: без этого окно не «живёт в
/// доке», как просит бриф, а остаётся окном accessory-приложения — у
/// Accessory нет ни иконки в доке, ни обычного переключения по Cmd+Tab.
/// Обратный переход — на закрытие окна, см. обработчик `on_window_event` в
/// main.rs.
pub fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Убирает главное окно и возвращает приложению политику Accessory —
/// ЕДИНСТВЕННОЕ место, которое знает, как главное окно уходит с экрана.
/// Зовётся из двух мест, и оба обязаны делать одно и то же: обработчик
/// `CloseRequested` в main.rs (крестик окна) и фронтенд после успешной
/// вставки (см. onPaste в MainWindow.tsx). Без возврата политики в
/// Accessory в доке оставалась бы иконка приложения, у которого больше нет
/// ни одного открытого окна.
///
/// Окно не уничтожается, а прячется — оно синглтон, объявленный в
/// tauri.conf.json, и `follow_to_main_window` обязан найти его снова.
#[tauri::command]
pub fn hide_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Follow из оверлея: главное окно получает текущий текст расшифровки и
/// поднимается наверх, оверлей прячется. Окно — синглтон, объявленный
/// статически в tauri.conf.json (как overlay/settings), поэтому «поднять уже
/// открытое» и «открыть новое» — один и тот же путь: `get_webview_window`
/// всегда возвращает одно и то же окно, второго не создаётся (см. бриф).
///
/// Оверлей прячем напрямую через `w.hide()`, а не через `hide_overlay()`: та
/// команда, если `overlay_took_focus` взведён, в фоновом потоке возвращает
/// нативный фокус ИСХОДНОМУ приложению (см. её doc-комментарий) — здесь же
/// фокус должен уйти в главное окно, а не туда, откуда пришла запись, так что
/// этот путь restore-логики тут не нужен и был бы ошибкой.
#[tauri::command]
pub fn follow_to_main_window(app: AppHandle, text: String) -> Result<(), String> {
    app.emit_to("main", "follow:text", FollowPayload { text })
        .map_err(|e| e.to_string())?;
    show_main_window(&app);
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
    Ok(())
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

    /// Число на ползунке обязано означать одно и то же для всех трёх окон.
    /// Панель — единственная, чей материал полупрозрачен сам по себе, и без
    /// поправки она выходила бы на экране заметно прозрачнее остальных: 0.9 у
    /// ползунка превращались бы в 0.83 на экране, а нижний край ползунка —
    /// в 0.46 при заявленном полу в 0.5, то есть пол переставал бы быть полом
    /// ровно у того окна, где на прозрачность смотрят чаще всего.
    /// `f32` из настроек не переводится в `f64` точно (0.9f32 → 0.899999976…),
    /// поэтому сравниваем с допуском, а не побитово: проверяем поправку, а не
    /// представление чисел с плавающей точкой.
    fn close(actual: f64, expected: f64) -> bool {
        (actual - expected).abs() < 1e-6
    }

    #[test]
    fn the_panel_gets_the_alpha_corrected_for_its_own_translucency() {
        // Окна с непрозрачным содержимым получают значение как есть.
        assert!(close(window_alpha("settings", 0.9), 0.9));
        assert!(close(window_alpha("main", 0.5), 0.5));

        // Панели — поделённое на прозрачность её собственного корпуса, чтобы
        // произведение дало ровно то, что просили.
        let alpha = window_alpha("overlay", 0.9);
        assert!(alpha > 0.9, "поправка должна поднимать альфу, а не опускать");
        assert!(
            close(alpha * OVERLAY_CSS_ALPHA, 0.9),
            "на экране должно получиться ровно 0.9, вышло {}",
            alpha * OVERLAY_CSS_ALPHA
        );

        // На нижнем краю ползунка панель не проваливается под пол: дорожка
        // уровня внутри неё нарисована непрозрачной, и с поправкой ей
        // достаётся даже чуть больше, чем 0.5 у соседних окон.
        assert!(window_alpha("overlay", 0.5) > 0.5);
    }

    /// Непрозрачнее непрозрачного не бывает: на 1.0 панель возвращается ровно
    /// к тому виду, что был до появления настройки, а не пытается «догнать»
    /// единицу за счёт своего же CSS.
    #[test]
    fn corrected_alpha_never_exceeds_one() {
        assert_eq!(window_alpha("overlay", 1.0), 1.0);
        assert_eq!(window_alpha("settings", 1.0), 1.0);
    }

    /// Мусор из файла или из вызова мимо формы не должен доезжать до AppKit:
    /// невидимое окно настроек не починить из него же.
    #[test]
    fn alpha_is_clamped_before_it_reaches_appkit() {
        assert!(close(window_alpha("settings", 0.0), 0.5));
        assert!(close(window_alpha("settings", 9.0), 1.0));
        assert!(close(window_alpha("settings", f32::NAN), 0.9));
    }

    /// Дефолтный хоткей — Cmd+T. Фронтенд собирает акселератор из
    /// `KeyboardEvent.code` ("KeyT" для клавиши T) и имени модификатора
    /// ("Super" для Cmd), так что строка по умолчанию должна быть именно
    /// такой формы — иначе `Settings::default().hotkey` не разберётся тем
    /// же парсером, что и хоткей, записанный руками в настройках.
    /// Главное окно фокус забирает (в отличие от оверлея), поэтому в момент
    /// нажатия хоткея впереди может стоять сам Slaive. Запомнить его PID
    /// значило бы направить Paste в собственное окно приложения — и из
    /// панели, и из главного окна сразу, потому что цель у них одна.
    #[test]
    fn own_pid_never_becomes_the_paste_target() {
        assert_eq!(next_source_pid(Some(42), Some(777), 777), Some(42));
        // Цели ещё не было — Slaive впереди её и не создаёт.
        assert_eq!(next_source_pid(None, Some(777), 777), None);
    }

    /// Всё остальное — прежнее поведение, менять его эта проверка не должна.
    #[test]
    fn foreign_pid_replaces_the_previous_target() {
        assert_eq!(next_source_pid(Some(42), Some(99), 777), Some(99));
        // osascript не ответил: цель снимается, как и раньше — вставка
        // уйдёт в то, что активно на момент нажатия Paste.
        assert_eq!(next_source_pid(Some(42), None, 777), None);
    }

    #[test]
    fn default_hotkey_accelerator_parses() {
        assert!(validate_hotkey("Super+KeyT".to_string()).is_ok());
        assert_eq!(
            "Super+KeyT".to_string(),
            crate::settings::Settings::default().hotkey
        );
    }
}
