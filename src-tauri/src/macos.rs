use anyhow::{anyhow, Context};
use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
use core_foundation::string::CFString;
use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, KeyCode};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Взаимодействие с чужими окнами идёт через osascript.
/// ponytail: AppleScript вместо objc2 + CGEvent — примерно 100 мс задержки на
/// вызов, но ноль unsafe-кода и ноль возни с версиями objc-биндингов.
/// Если задержка станет заметна — переписать на CGEventPost.
fn osascript(script: &str) -> anyhow::Result<String> {
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(script)
        .output()
        .context("couldn't run osascript")?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(anyhow!(err));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// PID приложения, активного прямо сейчас.
pub fn frontmost_pid() -> Option<i32> {
    osascript("tell application \"System Events\" to get unix id of first process whose frontmost is true")
        .ok()
        .and_then(|s| s.parse().ok())
}

/// Возвращает фокус приложению по его PID.
pub fn activate_pid(pid: i32) -> anyhow::Result<()> {
    osascript(&format!(
        "tell application \"System Events\" to set frontmost of (first process whose unix id is {pid}) to true"
    ))
    .map(|_| ())
}

/// Отправляет Cmd+V активному приложению через `CGEventPost` — сами
/// синтезируем нажатие, без посредников (было: наш процесс → osascript →
/// System Events → нажатие). Три раунда правок не помогли именно из-за
/// посредников: macOS проверяет право на отправку нажатий у «ответственного
/// процесса», а для бинарника, запущенного из терминала, это терминал, а не
/// Slaive — право, выданное Slaive, проверялось не для того процесса, и
/// поэтому `AXIsProcessTrusted()` показывал состояние, не совпадающее с
/// реально применяемым. `CGEventPost` убирает оба хопа: событие рождается в
/// нашем же процессе, и его же право проверяется.
pub fn send_paste() -> anyhow::Result<()> {
    // HIDSystemState — источник, эмулирующий физическое устройство ввода;
    // это то же самое место входа, что и у настоящего нажатия клавиши.
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow!("couldn't create a CGEventSource"))?;

    // ANSI_V = 9 — код физической позиции клавиши, а не буквы «V»: раскладка
    // клавиатуры тут ни при чём, сочетание Cmd+V должно сработать на любой
    // раскладке ровно там, где физически находится эта клавиша.
    let key_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_V, true)
        .map_err(|_| anyhow!("couldn't create the Cmd+V key-down event"))?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);

    let key_up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_V, false)
        .map_err(|_| anyhow!("couldn't create the Cmd+V key-up event"))?;
    // Флаг Cmd нужен и на key-up: без него в некоторых приложениях модификатор
    // «залипает» нажатым до следующего настоящего нажатия Cmd.
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);

    // HID, а не Session/AnnotatedSession: только этот тап ведёт себя как
    // нажатие настоящей клавиатуры и доходит до активного приложения, а не
    // только до нашего же процесса или текущей сессии.
    key_down.post(CGEventTapLocation::HID);
    key_up.post(CGEventTapLocation::HID);

    // ponytail: `CGEventPost` ничего не возвращает и не сообщает об ошибке —
    // без права Accessibility событие просто молча отбрасывается системой.
    // Поэтому единственный способ узнать об отказе заранее —
    // `has_accessibility_permission()` перед вызовом (см. `paste_text` в
    // commands.rs); эта функция физически не может вернуть ошибку из-за
    // отсутствия прав, только из-за сбоя создания source/event. Там же,
    // в `paste_text`, фиксированная пауза в 120 мс перед отправкой (после
    // возврата фокуса) — по-прежнему угадывание, что целевое приложение уже
    // готово принять нажатие, а не подтверждение этого; усложнить — опросом
    // `frontmost_pid()` в цикле до совпадения с запомненным PID вместо сна
    // фиксированной длины.
    Ok(())
}

// Единственный достоверный способ узнать, есть ли право на отправку нажатий.
// Разбор текста ошибки уже подвёл: реальное сообщение macOS оказалось
// "not allowed to send keystrokes (1002)" и не совпало ни с одним из
// шаблонов, которые мы проверяли.
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> u8;
}

/// Проверка без побочных эффектов: не показывает диалогов, не трогает
/// список Accessibility. `AXIsProcessTrusted` возвращает C-`Boolean` — это
/// байт, а не гарантированно `0`/`1`, поэтому сравниваем с нулём вручную, а
/// не связываем результат как `bool` напрямую (это было бы неопределённым
/// поведением при любом другом ненулевом байте).
pub fn has_accessibility_permission() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// `kAXTrustedCheckOptionPrompt` — просит систему показать свой диалог и
/// внести приложение в список. Без этого пользователь открывает раздел
/// Accessibility и не находит там Slaive, потому что добавить его может
/// только сама система либо он сам через «+» и поиск бинарника внутри
/// бандла. Дорогая операция с видимым системным UI — вызывать только в
/// ответ на явное действие пользователя (кнопка «Open Settings»), никогда
/// на каждую попытку вставки.
///
/// Ключ передан строковым литералом, а не привязкой к символу
/// `kAXTrustedCheckOptionPrompt` из фреймворка: это официальное,
/// задокументированное Apple имя ключа, а `CFDictionary` сверяет ключи по
/// содержимому (`CFEqual`), а не по адресу — литерал работает так же, как
/// импортированная константа, без лишнего unsafe-символа.
pub fn request_accessibility_permission() -> bool {
    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let value = CFBoolean::true_value();
    let options: CFDictionary<CFString, CFBoolean> = CFDictionary::from_CFType_pairs(&[(key, value)]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0 }
}

/// Раздел «Конфиденциальность и безопасность», который нужно открыть, чтобы
/// пользователь мог выдать недостающее разрешение.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PrivacyPane {
    Automation,
    Accessibility,
}

pub fn open_privacy_pane(pane: PrivacyPane) {
    match pane {
        PrivacyPane::Automation => {
            // Для Automation нет системного API запроса — просто открываем раздел,
            // добавить себя в список пользователь может только вручную.
            let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation";
            let _ = Command::new("/usr/bin/open").arg(url).status();
        }
        PrivacyPane::Accessibility => {
            // `AXIsProcessTrustedWithOptions` с промптом показывает системный
            // диалог не больше одного раза за жизнь приложения — macOS
            // запоминает, что уже спрашивала. Пользователь, однажды закрывший
            // этот диалог, нажимает «Open Settings» и не видит вообще ничего:
            // кнопка выглядит сломанной, хотя технически отработала (просто
            // молча). Поэтому дополнительно, как и раньше, открываем сам
            // раздел настроек — в худшем случае пользователь увидит и диалог,
            // и раздел System Settings, а это строго лучше, чем кнопка без
            // видимой реакции. Результат диалога не проверяем: отказ
            // пользователя в нём — обычный исход, не ошибка.
            request_accessibility_permission();
            let url = "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
            let _ = Command::new("/usr/bin/open").arg(url).status();
        }
    }
}

/// Определяет, какого раздела «Конфиденциальность и безопасность» не хватает
/// по тексту ошибки osascript. Это резервная классификация — основной путь
/// теперь спрашивает систему напрямую через `has_accessibility_permission`
/// ДО попытки вставки; сюда падают случаи, когда право отозвали между
/// проверкой и вызовом, либо любой другой формой отказа, который проверка
/// не покрывает.
///
/// `-1743` (`errAEEventNotPermitted`) — отказ в Automation (Slaive не
/// разрешили посылать Apple-события System Events). `not allowed assistive`,
/// `-25211`, `not allowed to send keystrokes` и `(1002)` — варианты отказа в
/// Accessibility (не разрешили посылать синтетические нажатия клавиш).
/// Последние два добавлены по реальному сообщению, пойманному на машине
/// пользователя: `System Events got an error: osascript is not allowed to
/// send keystrokes. (1002)` — оно не совпадало ни с одним прежним шаблоном,
/// и отказ классифицировался как неизвестная ошибка без кнопки «Open
/// Settings». У Automation и Accessibility разные разделы настроек, и
/// раньше оба вели в Accessibility, где для Automation нет нужного
/// переключателя.
pub fn permission_pane(message: &str) -> Option<PrivacyPane> {
    if message.contains("-1743") {
        Some(PrivacyPane::Automation)
    } else if message.contains("not allowed assistive")
        || message.contains("-25211")
        || message.contains("not allowed to send keystrokes")
        || message.contains("(1002)")
    {
        Some(PrivacyPane::Accessibility)
    } else {
        None
    }
}

/// Приложение, из которого пользователь вызвал Slaive: имя и (если удалось)
/// иконка в виде PNG-base64. Модуль не знает про Tauri — это чистая
/// структура, событие в панель собирает вызывающая сторона (`commands.rs`).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceApp {
    pub name: String,
    pub icon_png_base64: Option<String>,
}

/// Определяет приложение-источник по PID: имя и иконку — без AppleScript и
/// без единого системного диалога разрешений. Не должно вызываться на
/// хот-пути записи (см. `hotkey_pressed` в commands.rs, который зовёт это на
/// фоновом потоке уже после `begin_recording`) — раньше блокирующий
/// osascript-вызов на этом самом месте срезал первое слово каждой записи.
/// ponytail: три форка system-инструментов (`ps`, `PlistBuddy`, `sips`)
/// вместо CoreFoundation FFI (NSRunningApplication) — на порядок меньше
/// unsafe-кода ценой пары лишних процессов, не критично на фоновом потоке.
pub fn resolve_app(pid: i32) -> Option<SourceApp> {
    let exe_path = process_executable_path(pid)?;
    let bundle_path = PathBuf::from(bundle_path_from_exe(&exe_path)?);
    let plist_path = bundle_path.join("Contents/Info.plist");

    let display_name = plist_string(&plist_path, "CFBundleDisplayName");
    let bundle_name = plist_string(&plist_path, "CFBundleName");
    let dir_stem = bundle_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown");
    let name = resolve_display_name(display_name.as_deref(), bundle_name.as_deref(), dir_stem);

    let icon_png_base64 = plist_string(&plist_path, "CFBundleIconFile")
        .and_then(|icon_file| bundle_icon_png_base64(&bundle_path, &icon_file));

    Some(SourceApp { name, icon_png_base64 })
}

/// `ps -p <pid> -o comm=` — путь к исполняемому файлу процесса. `None`, если
/// процесс уже завершился (гонка между захватом PID и разрешением имени) или
/// `ps` недоступен — в этом случае шапка панели просто не появится.
fn process_executable_path(pid: i32) -> Option<String> {
    let out = Command::new("/bin/ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Путь к бандлу `.app`, вырезанный из пути исполняемого файла по ПЕРВОМУ
/// вхождению `.app`. Процесс может жить внутри чужого бандла — например
/// `.../Setapp.app/Contents/PlugIns/FinderSyncExt.appex/Contents/MacOS/FinderSyncExt`
/// — резка по первому `.app` отдаёт путь к приложению-хосту (Setapp), а не к
/// расширению: пользователь на экране видел хост, а не его плагин.
pub fn bundle_path_from_exe(exe_path: &str) -> Option<String> {
    let idx = exe_path.find(".app")?;
    Some(exe_path[..idx + 4].to_string())
}

/// Порядок предпочтения имени: `CFBundleDisplayName` (то, что видит
/// пользователь) → `CFBundleName` (иногда техническое — например
/// `SetappAgent`, где реальное отображаемое имя другое) → имя каталога
/// `.app` без расширения, если Info.plist вообще не прочитать.
fn resolve_display_name(display_name: Option<&str>, bundle_name: Option<&str>, dir_stem: &str) -> String {
    display_name
        .or(bundle_name)
        .map(str::to_string)
        .unwrap_or_else(|| dir_stem.to_string())
}

/// Имя файла иконки в Info.plist иногда уже с расширением `.icns`, иногда
/// без — дописываем, если его нет, чтобы дальше просто читать файл по пути.
fn icon_file_name(bundle_icon_file: &str) -> String {
    if bundle_icon_file.to_lowercase().ends_with(".icns") {
        bundle_icon_file.to_string()
    } else {
        format!("{bundle_icon_file}.icns")
    }
}

/// Читает строковое значение ключа Info.plist через `PlistBuddy` — без
/// парсера plist в зависимостях. `None`, если ключа нет, файла нет или
/// значение пустое.
fn plist_string(plist_path: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print :{key}"))
        .arg(plist_path)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Конвертирует `.icns` в PNG 64×64 через `sips` и кодирует в base64 через
/// системный `base64` — `.icns` не рендерится в WebView, а тянуть crate ради
/// разовой конвертации иконки незачем. `None` при любой неудаче на этом
/// пути: шапка панели должна деградировать до одного текста, а не до битой
/// картинки или пустой полосы.
fn bundle_icon_png_base64(bundle_path: &Path, icon_file: &str) -> Option<String> {
    let icon_path = bundle_path
        .join("Contents/Resources")
        .join(icon_file_name(icon_file));
    if !icon_path.exists() {
        return None;
    }

    // Нонс во временном имени — чтобы параллельные разрешения (быстро идущие
    // подряд хоткеи) не затирали временный файл друг друга.
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_png = std::env::temp_dir().join(format!("slaive-source-icon-{nonce}.png"));

    let converted = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png", "-Z", "64"])
        .arg(&icon_path)
        .arg("--out")
        .arg(&tmp_png)
        .output()
        .ok()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let result = if converted {
        Command::new("/usr/bin/base64")
            .arg("-i")
            .arg(&tmp_png)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else {
        None
    };

    let _ = std::fs::remove_file(&tmp_png);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_permission_denials() {
        assert_eq!(
            permission_pane("execution error: Slaive is not allowed to send Apple events to System Events. (-1743)"),
            Some(PrivacyPane::Automation)
        );
        assert_eq!(
            permission_pane("not allowed assistive access"),
            Some(PrivacyPane::Accessibility)
        );
    }

    /// Сообщение из брифа дословно — реальный отказ, пойманный на машине
    /// пользователя, ни с одним прежним шаблоном (`-1743`, `-25211`,
    /// `not allowed assistive`) не совпадал и классифицировался как
    /// неизвестная ошибка. Эта строка не должна снова проскользнуть мимо.
    #[test]
    fn detects_the_real_world_1002_keystrokes_denial() {
        assert_eq!(
            permission_pane(
                "36:68: execution error: System Events got an error: osascript is not allowed to send keystrokes. (1002)"
            ),
            Some(PrivacyPane::Accessibility)
        );
    }

    #[test]
    fn detects_keystrokes_denial_by_wording_alone() {
        assert_eq!(
            permission_pane("osascript is not allowed to send keystrokes."),
            Some(PrivacyPane::Accessibility)
        );
    }

    #[test]
    fn detects_keystrokes_denial_by_code_alone() {
        assert_eq!(permission_pane("some other wording. (1002)"), Some(PrivacyPane::Accessibility));
    }

    #[test]
    fn ordinary_errors_have_no_pane() {
        assert_eq!(
            permission_pane("execution error: Can't get process 999. (-1728)"),
            None
        );
    }

    /// C2 / T3: -1743 (Automation) и -25211 (Accessibility) — два разных
    /// отказа с двумя разными разделами настроек, их нельзя путать.
    #[test]
    fn automation_and_accessibility_denials_map_to_different_panes() {
        let automation = permission_pane("execution error: not permitted. (-1743)");
        let accessibility = permission_pane("execution error: not permitted. (-25211)");
        assert_eq!(automation, Some(PrivacyPane::Automation));
        assert_eq!(accessibility, Some(PrivacyPane::Accessibility));
        assert_ne!(automation, accessibility);
    }

    #[test]
    fn bundle_path_cuts_at_first_dot_app() {
        assert_eq!(
            bundle_path_from_exe("/Applications/Notes.app/Contents/MacOS/Notes"),
            Some("/Applications/Notes.app".to_string())
        );
    }

    /// Верифицированная ловушка из брифа: процесс расширения `.appex`
    /// живёт внутри бандла хост-приложения. Резка по ПЕРВОМУ `.app` обязана
    /// вернуть путь к хосту (Setapp), а не к самому расширению.
    #[test]
    fn bundle_path_uses_host_app_for_nested_appex() {
        let exe = "/Users/x/Library/Application Support/Setapp/LaunchAgents/Setapp.app/Contents/PlugIns/FinderSyncExt.appex/Contents/MacOS/FinderSyncExt";
        assert_eq!(
            bundle_path_from_exe(exe),
            Some(
                "/Users/x/Library/Application Support/Setapp/LaunchAgents/Setapp.app"
                    .to_string()
            )
        );
    }

    #[test]
    fn bundle_path_none_without_app_extension() {
        assert_eq!(bundle_path_from_exe("/usr/bin/true"), None);
    }

    #[test]
    fn display_name_prefers_bundle_display_name() {
        assert_eq!(
            resolve_display_name(Some("Notes"), Some("com.apple.Notes"), "Notes"),
            "Notes"
        );
    }

    /// Реально наблюдаемый случай из брифа: CFBundleName отдаёт техническое
    /// имя (`SetappAgent`), которое пользователь не узнает — но это всё
    /// равно лучше, чем ничего, когда DisplayName отсутствует.
    #[test]
    fn display_name_falls_back_to_bundle_name() {
        assert_eq!(
            resolve_display_name(None, Some("SetappAgent"), "Setapp"),
            "SetappAgent"
        );
    }

    #[test]
    fn display_name_falls_back_to_dir_stem_when_plist_unreadable() {
        assert_eq!(resolve_display_name(None, None, "Setapp"), "Setapp");
    }

    #[test]
    fn icon_file_name_appends_extension_when_missing() {
        assert_eq!(icon_file_name("AppIcon"), "AppIcon.icns");
    }

    #[test]
    fn icon_file_name_keeps_existing_extension() {
        assert_eq!(icon_file_name("AppIcon.icns"), "AppIcon.icns");
    }

    #[test]
    fn icon_file_name_is_case_insensitive_about_existing_extension() {
        assert_eq!(icon_file_name("AppIcon.ICNS"), "AppIcon.ICNS");
    }

    /// Не юнит-тест: `resolve_app` форкает `ps`/`PlistBuddy`/`sips` и требует
    /// реального живого процесса на машине — как и `whisper::tests`, которым
    /// нужна реальная модель, это ручная проверка, не CI. Notes.app — родное
    /// системное приложение, для проверки его обычно проще всего найти или
    /// открыть; если не запущено, тест сам себя пропускает, а не падает.
    #[test]
    #[ignore]
    fn resolve_app_against_a_real_process() {
        let pid = Command::new("/usr/bin/pgrep")
            .args(["-x", "Notes"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(|s| s.lines().next().map(str::to_string))
            .and_then(|s| s.trim().parse::<i32>().ok());
        let Some(pid) = pid else {
            eprintln!("Notes.app isn't running — open it and re-run to check manually");
            return;
        };
        let result = resolve_app(pid);
        println!("resolve_app({pid}) = {result:?}");
        assert!(result.is_some());
        assert!(!result.unwrap().name.is_empty());
    }
}
