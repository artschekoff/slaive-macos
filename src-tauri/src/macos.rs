use anyhow::{anyhow, Context};
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
        .context("не удалось запустить osascript")?;

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

pub fn open_accessibility_settings() {
    let _ = Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status();
}

/// Ошибка -1743 означает, что macOS не пустила нас управлять другими
/// приложениями — нужно разрешение в «Универсальном доступе».
pub fn is_permission_error(message: &str) -> bool {
    message.contains("-1743") || message.contains("not allowed assistive")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_accessibility_denial() {
        assert!(is_permission_error(
            "execution error: Slaive is not allowed to send keystrokes. (-1743)"
        ));
        assert!(is_permission_error("not allowed assistive access"));
    }

    #[test]
    fn ordinary_errors_are_not_permission_errors() {
        assert!(!is_permission_error("execution error: Can't get process 999. (-1728)"));
    }
}
