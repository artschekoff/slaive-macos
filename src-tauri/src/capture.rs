//! Последовательность захвата выделенного текста из чужого приложения.
//!
//! Прочитать выделение напрямую на macOS нечем, поэтому порядок действий
//! вынужденный: запомнить буфер обмена, послать Cmd+C, дождаться подтверждения,
//! прочитать, вернуть буфер на место. Здесь живёт именно порядок и решения о
//! сроках — то, что можно проверить без рабочего стола; сами примитивы
//! (нажатие, счётчик, буфер) приходят снаружи через `CaptureOps`.

use anyhow::anyhow;
use std::time::Duration;

/// Шаг опроса счётчика. Мельче — лишняя нагрузка без выигрыша: событие
/// клавиатуры доходит до приложения и обратно за десятки миллисекунд.
pub const POLL_INTERVAL: Duration = Duration::from_millis(15);

/// Сколько всего ждём подтверждения. Половины секунды хватает даже медленному
/// приложению; дольше — и пользователь решит, что хоткей не сработал.
pub const POLL_DEADLINE: Duration = Duration::from_millis(500);

/// Примитивы, которыми пользуется захват. Трейт нужен ради тестов: настоящие
/// нажатия и настоящий буфер обмена трогают рабочий стол пользователя, и
/// проверять на них порядок действий нельзя.
pub trait CaptureOps {
    fn change_count(&self) -> i64;
    fn send_copy(&self) -> anyhow::Result<()>;
    fn read_text(&self) -> Option<String>;
    fn write_text(&self, text: &str) -> anyhow::Result<()>;
    fn sleep(&self, d: Duration);
}

/// Что получилось у захвата.
#[derive(Debug)]
pub struct CaptureOutcome {
    /// Выделенный текст, уже обрезанный по краям.
    pub text: String,
    /// Удалось ли вернуть прежнее содержимое буфера обмена. `false` означает,
    /// что возвращать было нечего либо там лежал не текст.
    pub restored_clipboard: bool,
}

/// Захватывает выделенный текст.
///
/// Ошибка «No text selected» — не сбой, а нормальный исход: пользователь мог
/// нажать хоткей, ничего не выделив.
pub fn capture_selection<O: CaptureOps>(ops: &O) -> anyhow::Result<CaptureOutcome> {
    let previous = ops.read_text();
    let before = ops.change_count();

    ops.send_copy()?;

    // Опрос до подтверждения. Ждать фиксированную паузу и затем читать буфер
    // нельзя: при пустом выделении Cmd+C не делает ничего, и «старое значение
    // на месте» невозможно отличить от «ещё не успело».
    let mut waited = Duration::ZERO;
    let mut copied = false;
    while waited < POLL_DEADLINE {
        // Последний шаг укорачиваем до остатка: POLL_DEADLINE не обязано
        // делиться на POLL_INTERVAL нацело, а суммарный сон не должен
        // превышать заявленный предел.
        let step = std::cmp::min(POLL_INTERVAL, POLL_DEADLINE - waited);
        ops.sleep(step);
        waited += step;
        if ops.change_count() != before {
            copied = true;
            break;
        }
    }

    if !copied {
        // Ничего не писали в буфер — возвращать нечего. Запись того же
        // значения обратно сдвинула бы счётчик для всех остальных
        // наблюдателей в системе на ровном месте.
        return Err(anyhow!(
            "No text selected. Select some text first, then press the capture hotkey."
        ));
    }

    let captured = ops.read_text().unwrap_or_default();
    let text = captured.trim().to_string();

    // Буфер возвращаем ДО проверки на пустоту: выделение могло оказаться
    // одними пробелами, но чужое содержимое всё равно наше не по праву.
    let restored_clipboard = match &previous {
        Some(old) => {
            ops.write_text(old)?;
            true
        }
        None => false,
    };

    if text.is_empty() {
        return Err(anyhow!(
            "No text selected. Select some text first, then press the capture hotkey."
        ));
    }

    Ok(CaptureOutcome { text, restored_clipboard })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::time::Duration;

    /// Подставной буфер обмена: считает вызовы и позволяет задать, на каком
    /// опросе счётчик «дрогнет». Настоящий буфер обмена и настоящие нажатия
    /// в тестах недопустимы — они трогают рабочий стол пользователя.
    struct Fake {
        /// На каком по счёту опросе changeCount должен вырасти.
        /// `None` — не вырастет никогда (пользователь ничего не выделил).
        bump_at_poll: Option<usize>,
        polls: RefCell<usize>,
        clipboard: RefCell<Option<String>>,
        /// Что окажется в буфере после «копирования».
        copied: Option<String>,
        writes: RefCell<Vec<String>>,
        slept: RefCell<Duration>,
    }

    impl Fake {
        fn new(bump_at_poll: Option<usize>, before: Option<&str>, copied: Option<&str>) -> Self {
            Self {
                bump_at_poll,
                polls: RefCell::new(0),
                clipboard: RefCell::new(before.map(String::from)),
                copied: copied.map(String::from),
                writes: RefCell::new(Vec::new()),
                slept: RefCell::new(Duration::ZERO),
            }
        }
    }

    impl CaptureOps for Fake {
        fn change_count(&self) -> i64 {
            let n = *self.polls.borrow();
            match self.bump_at_poll {
                Some(at) if n >= at => 1,
                _ => 0,
            }
        }

        fn send_copy(&self) -> anyhow::Result<()> {
            if let Some(text) = &self.copied {
                *self.clipboard.borrow_mut() = Some(text.clone());
            }
            Ok(())
        }

        fn read_text(&self) -> Option<String> {
            self.clipboard.borrow().clone()
        }

        fn write_text(&self, text: &str) -> anyhow::Result<()> {
            self.writes.borrow_mut().push(text.to_string());
            *self.clipboard.borrow_mut() = Some(text.to_string());
            Ok(())
        }

        fn sleep(&self, d: Duration) {
            *self.polls.borrow_mut() += 1;
            *self.slept.borrow_mut() += d;
        }
    }

    #[test]
    fn returns_the_copied_text_when_the_counter_moves() {
        let ops = Fake::new(Some(1), Some("старое"), Some("выделенное"));
        let out = capture_selection(&ops).unwrap();
        assert_eq!(out.text, "выделенное");
    }

    #[test]
    fn restores_the_previous_clipboard() {
        // Главное обязательство: буфер обмена пользователя нельзя себе
        // забирать. После захвата в нём должно лежать то же, что и до.
        let ops = Fake::new(Some(1), Some("старое"), Some("выделенное"));
        capture_selection(&ops).unwrap();
        assert_eq!(ops.clipboard.borrow().as_deref(), Some("старое"));
        assert_eq!(ops.writes.borrow().last().map(String::as_str), Some("старое"));
    }

    #[test]
    fn errors_when_nothing_was_selected() {
        // Счётчик не двигается — значит Cmd+C ничего не скопировал.
        let ops = Fake::new(None, Some("старое"), None);
        let err = capture_selection(&ops).unwrap_err().to_string();
        assert!(
            err.contains("No text selected"),
            "сообщение должно объяснять, что выделения не было, получено: {err}"
        );
    }

    #[test]
    fn does_not_touch_the_clipboard_when_nothing_was_selected() {
        // Неудачный захват не должен ничего писать в буфер: писать туда то
        // же самое значение — лишний сдвиг changeCount для всех остальных
        // наблюдателей в системе.
        let ops = Fake::new(None, Some("старое"), None);
        let _ = capture_selection(&ops);
        assert!(ops.writes.borrow().is_empty(), "в буфер писали при пустом выделении");
    }

    #[test]
    fn gives_up_at_the_deadline() {
        let ops = Fake::new(None, Some("старое"), None);
        let _ = capture_selection(&ops);
        assert!(
            *ops.slept.borrow() <= POLL_DEADLINE,
            "опрос длился дольше предельного времени"
        );
    }

    #[test]
    fn survives_an_empty_clipboard_before_capture() {
        // Восстанавливать нечего — и это не ошибка.
        let ops = Fake::new(Some(1), None, Some("выделенное"));
        let out = capture_selection(&ops).unwrap();
        assert_eq!(out.text, "выделенное");
        assert!(!out.restored_clipboard);
    }

    #[test]
    fn rejects_a_selection_of_only_whitespace() {
        // Пробелы и переводы строк — не текст, с которым есть что делать.
        let ops = Fake::new(Some(1), Some("старое"), Some("   \n\t  "));
        let err = capture_selection(&ops).unwrap_err().to_string();
        assert!(err.contains("No text selected"), "получено: {err}");
    }
}
