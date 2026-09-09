use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
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

/// Отправляет Cmd+V активному приложению.
pub fn send_paste() -> anyhow::Result<()> {
    osascript("tell application \"System Events\" to keystroke \"v\" using command down").map(|_| ())
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
    let url = match pane {
        PrivacyPane::Automation => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        }
        PrivacyPane::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    };
    let _ = Command::new("/usr/bin/open").arg(url).status();
}

/// Определяет, какого раздела «Конфиденциальность и безопасность» не хватает
/// по тексту ошибки osascript. `-1743` (`errAEEventNotPermitted`) — это отказ
/// в Automation (Slaive не разрешили посылать Apple-события System Events).
/// `not allowed assistive` и `-25211` — отказ в Accessibility (не разрешили
/// посылать синтетические нажатия клавиш). У этих отказов разные разделы
/// настроек, и раньше оба вели в Accessibility, где для Automation нет нужного
/// переключателя.
pub fn permission_pane(message: &str) -> Option<PrivacyPane> {
    if message.contains("-1743") {
        Some(PrivacyPane::Automation)
    } else if message.contains("not allowed assistive") || message.contains("-25211") {
        Some(PrivacyPane::Accessibility)
    } else {
        None
    }
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
}
