# Capture Selected Text + Settings Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A global hotkey grabs whatever text is selected in any application and opens it in Slaive's main window for AI actions, and the overlay gains a settings button beside its close button.

**Architecture:** The capture reuses the machinery that already exists. `macos.rs` learns to post `Cmd+C` exactly as it already posts `Cmd+V`; the clipboard becomes the transport, with the user's previous clipboard saved and restored around the operation; `NSPasteboard.changeCount` tells us whether the copy actually produced anything, instead of guessing with a sleep. Once the text is in hand, it goes down the same `follow_to_main_window` path the Follow button already uses, so the main window needs no new entry point.

**Tech Stack:** Rust, Tauri 2, `tauri-plugin-global-shortcut`, `tauri-plugin-clipboard-manager`, `core-graphics` (CGEvent), `objc2-app-kit` (NSPasteboard), React, TypeScript.

**Spec:** this document. The request it implements, verbatim:

> Хочу добавить возможность перехватывать выделенный текст в любом из приложений. Давай добавим сочетание горячих клавиш. Например, Ctrl-Command-Пробел. Выделенный текст должен перехватиться программой, где я могу перевести его, изменить через AI и то-се, пятое-десятое. Как это сейчас уже реализовано с текстом, который я надиктовал и нажал в Follow. также добавь кнопку настройки рядом с кнопкой закрытия в интерфейс программы чтобы появлялось меню настроек

## Global Constraints

- `macos.rs` is the only place with platform calls. `audio.rs`, `whisper.rs`, `ai.rs`, `macos.rs` know nothing about Tauri.
- Errors: `anyhow::Result` inside modules, `Result<T, String>` at the command boundary.
- Data paths only through `app.path().app_data_dir()`.
- Transcript and captured text are never logged. Lengths, counts, durations, ids and status codes are fine.
- Code comments in Russian. All user-facing text in English.
- Deliberate simplifications carry `// ponytail: <what>, <when to complicate>`.
- **No reference to Claude anywhere** — not in code, not in commit messages. Rule is in `CLAUDE.md`.
- Window-level shortcuts never go through `tauri-plugin-global-shortcut`. Only genuinely global hotkeys do: today the record hotkey, and after this plan the capture hotkey.
- Every stored shortcut field must appear in `SHORTCUT_FIELDS` in `src/shortcut-conflicts.ts`, or collisions with it fail silently.

---

## Why the clipboard, and why changeCount

There is no supported way on macOS to read another application's selection directly. Every tool that does this — including the system-wide Services menu — sends a copy command and reads the pasteboard. So the sequence is forced:

1. remember which application is frontmost (the paste target for later),
2. remember the current clipboard so it can be put back,
3. post `Cmd+C` to the frontmost application,
4. find out whether anything landed on the pasteboard,
5. read it, restore the old clipboard, open the main window with the text.

Step 4 is where naive implementations go wrong. `CGEventPost` reports nothing, and if no text was selected, `Cmd+C` is a no-op — so a fixed sleep followed by a clipboard read cannot distinguish "the user selected nothing" from "the copy has not landed yet". Both look like "the clipboard still holds the old value".

`NSPasteboard.generalPasteboard().changeCount()` is a counter that increments on every write by anyone. Read it before the copy, poll it after, and the answer is definite: incremented means something was copied, unchanged past the deadline means nothing was selected. That turns a guess into a measurement, and it is why `objc2-app-kit` — already a dependency for window opacity — gets one more feature flag rather than a new package.

---

## File Structure

**Created**

- `src-tauri/src/capture.rs` — the capture sequence as pure orchestration over platform primitives: change-count polling, deciding whether a copy produced anything, clipboard save/restore ordering. Knows nothing about Tauri. It is separate from `macos.rs` because `macos.rs` holds *primitives* (post a key, read a counter) and this holds the *sequence*, which is the part worth testing.

**Modified**

- `src-tauri/Cargo.toml` — add the `NSPasteboard` feature to the existing `objc2-app-kit` entry.
- `src-tauri/src/macos.rs` — add `send_copy()` and `pasteboard_change_count()` beside the existing `send_paste()`.
- `src-tauri/src/settings.rs` — add `capture_hotkey` with its default and serde fallback.
- `src-tauri/src/state.rs` — add the registered capture shortcut so it can be unregistered on change.
- `src-tauri/src/commands.rs` — the `capture_selection` command, capture hotkey registration, and `open_settings_window` already exists and is reused.
- `src-tauri/src/main.rs` — register the capture hotkey at startup; add the new command to the handler list.
- `src/api.ts` — typed wrappers for the new command and the new settings field.
- `src/shortcut-conflicts.ts` — add `captureHotkey` to `SHORTCUT_FIELDS`.
- `src/Settings.tsx` — a capture hotkey row in the Shortcuts section.
- `src/Overlay.tsx` — a settings button beside the close button.
- `src/styles.css` — styling for that button.

---

### Task 1: Post Cmd+C from the platform layer

`send_paste()` already posts `Cmd+V` through `CGEvent`. Copying is the same operation with a different key code, and it must share every hard-won detail: the HID event source, the flag on key-up, the HID tap location.

**Files:**
- Modify: `src-tauri/src/macos.rs` (add beside `send_paste`, around line 55–93)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `pub fn send_copy() -> anyhow::Result<()>`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/macos.rs`:

```rust
    // Отправка нажатия требует права Accessibility и живого рабочего стола,
    // поэтому проверяем не эффект, а то, что функция собирает событие и не
    // падает. Тест помечен ignore: на машине без прав CGEventPost молча
    // отбрасывает событие, а с правами — отправит настоящий Cmd+C в активное
    // приложение, чего в тестах делать нельзя.
    #[test]
    #[ignore = "постит настоящее нажатие в активное приложение"]
    fn send_copy_builds_an_event() {
        assert!(send_copy().is_ok());
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test send_copy_builds_an_event -- --ignored`

Expected: FAIL to compile with `cannot find function 'send_copy' in this scope`.

- [ ] **Step 3: Write the implementation**

Add to `src-tauri/src/macos.rs`, directly after `send_paste`:

```rust
/// Посылает Cmd+C активному приложению. Полный двойник `send_paste` — те же
/// источник события, тап и флаг на key-up, отличается только код клавиши.
///
/// Зачем вообще нажатие, а не чтение выделения напрямую: на macOS прочитать
/// выделение в чужом приложении нечем. Системное меню «Службы» работает ровно
/// так же — посылает копирование и читает буфер обмена.
pub fn send_copy() -> anyhow::Result<()> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| anyhow!("couldn't create a CGEventSource"))?;

    // ANSI_C = 8 — код физической позиции клавиши, а не буквы «C»: на любой
    // раскладке копирование висит на этой позиции (см. тот же довод про
    // ANSI_V в send_paste).
    let key_down = CGEvent::new_keyboard_event(source.clone(), KeyCode::ANSI_C, true)
        .map_err(|_| anyhow!("couldn't create the Cmd+C key-down event"))?;
    key_down.set_flags(CGEventFlags::CGEventFlagCommand);

    let key_up = CGEvent::new_keyboard_event(source, KeyCode::ANSI_C, false)
        .map_err(|_| anyhow!("couldn't create the Cmd+C key-up event"))?;
    // Флаг Cmd обязателен и на key-up: без него модификатор залипает
    // нажатым до следующего настоящего нажатия Cmd.
    key_up.set_flags(CGEventFlags::CGEventFlagCommand);

    key_down.post(CGEventTapLocation::HID);
    key_up.post(CGEventTapLocation::HID);

    // ponytail: как и send_paste, узнать об отказе из-за отсутствия прав
    // отсюда нельзя — CGEventPost молчит. Право проверяется до вызова через
    // has_accessibility_permission(); усложнить, если появится способ
    // получить подтверждение доставки события.
    Ok(())
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build`

Expected: compiles, zero warnings. The test itself stays ignored — do not run it without `--ignored`, and do not run it at all on a machine you are using.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/macos.rs
git commit -m "feat: отправка Cmd+C из платформенного слоя"
```

---

### Task 2: Read the pasteboard change counter

**Files:**
- Modify: `src-tauri/Cargo.toml` (the `objc2-app-kit` features list, around line 30)
- Modify: `src-tauri/src/macos.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `pub fn pasteboard_change_count() -> i64`

- [ ] **Step 1: Write the failing test**

Add to the tests module in `src-tauri/src/macos.rs`:

```rust
    // Счётчик не обязан иметь какое-то конкретное значение — он растёт при
    // любой записи в буфер обмена кем угодно в системе. Проверяем ровно то,
    // на что опирается логика захвата: значение читается и не отрицательно,
    // а два подряд чтения без записи между ними совпадают.
    #[test]
    fn pasteboard_change_count_is_stable_without_writes() {
        let a = pasteboard_change_count();
        let b = pasteboard_change_count();
        assert!(a >= 0, "счётчик буфера обмена отрицательный: {a}");
        assert_eq!(a, b, "счётчик изменился без записи в буфер обмена");
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test pasteboard_change_count`

Expected: FAIL to compile with `cannot find function 'pasteboard_change_count' in this scope`.

- [ ] **Step 3: Enable the NSPasteboard feature**

In `src-tauri/Cargo.toml`, add `"NSPasteboard"` to the existing `objc2-app-kit` features array so it reads:

```toml
objc2-app-kit = { version = "0.3", default-features = false, features = [
    "std",
    "objc2-core-foundation",
    "NSPasteboard",
    "NSResponder",
    "NSWindow",
] }
```

No new package is downloaded — this crate is already compiled for the window-opacity code, and the flag only turns on another set of bindings within it.

- [ ] **Step 4: Write the implementation**

Add to `src-tauri/src/macos.rs`:

```rust
/// Счётчик изменений общего буфера обмена. Растёт на единицу при каждой
/// записи в него кем угодно в системе.
///
/// Это единственный достоверный способ отличить «пользователь ничего не
/// выделил» от «копирование ещё не доехало». CGEventPost ничего не
/// возвращает, а при пустом выделении Cmd+C вообще ничего не делает — и оба
/// случая выглядят как «в буфере по-прежнему старое значение». Счётчик
/// отвечает на этот вопрос однозначно.
pub fn pasteboard_change_count() -> i64 {
    use objc2_app_kit::NSPasteboard;
    // Safety: NSPasteboard::generalPasteboard возвращает синглтон, живущий
    // столько же, сколько процесс; changeCount у него — обычное чтение
    // счётчика без побочных эффектов.
    unsafe { NSPasteboard::generalPasteboard().changeCount() }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test pasteboard_change_count`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/macos.rs
git commit -m "feat: чтение счётчика изменений буфера обмена"
```

---

### Task 3: The capture sequence, as testable logic

The ordering decisions — how long to wait, when to give up, when to restore the clipboard — are where this feature is won or lost, and they are the part that can be tested without a desktop. They go in their own module, driven by injected primitives so a test can simulate "the user selected nothing" and "the copy arrived on the third poll".

**Files:**
- Create: `src-tauri/src/capture.rs`
- Modify: `src-tauri/src/main.rs` (add `mod capture;` beside the other module declarations, around line 3–10)

**Interfaces:**
- Consumes: `macos::send_copy`, `macos::pasteboard_change_count` from Tasks 1 and 2 — but only through the `CaptureOps` trait defined here, so tests can substitute fakes.
- Produces:
  - `pub trait CaptureOps { fn change_count(&self) -> i64; fn send_copy(&self) -> anyhow::Result<()>; fn read_text(&self) -> Option<String>; fn write_text(&self, text: &str) -> anyhow::Result<()>; fn sleep(&self, d: std::time::Duration); }`
  - `pub struct CaptureOutcome { pub text: String, pub restored_clipboard: bool }`
  - `pub fn capture_selection<O: CaptureOps>(ops: &O) -> anyhow::Result<CaptureOutcome>`
  - `pub const POLL_INTERVAL: std::time::Duration`
  - `pub const POLL_DEADLINE: std::time::Duration`

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/capture.rs` with only the tests for now:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test capture::`

Expected: FAIL to compile — `capture_selection`, `CaptureOps`, `CaptureOutcome`, `POLL_DEADLINE` are undefined.

- [ ] **Step 3: Write the implementation**

Insert above the tests module in `src-tauri/src/capture.rs`:

```rust
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
        ops.sleep(POLL_INTERVAL);
        waited += POLL_INTERVAL;
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
```

Then add the module declaration in `src-tauri/src/main.rs`, keeping the list alphabetical:

```rust
mod ai;
mod audio;
mod capture;
mod commands;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test capture::`

Expected: 7 passed.

- [ ] **Step 5: Check for warnings**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build`

Expected: zero warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/capture.rs src-tauri/src/main.rs
git commit -m "feat: последовательность захвата выделенного текста"
```

---

### Task 4: The capture hotkey setting

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Modify: `src/api.ts`
- Modify: `src/shortcut-conflicts.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Rust field `Settings::capture_hotkey: String`, default `"Ctrl+Super+Space"`.
  - TypeScript field `captureHotkey: string` on the settings type.
  - `SHORTCUT_FIELDS` entry `{ key: 'captureHotkey', label: 'Capture selection' }`.

- [ ] **Step 1: Write the failing tests**

Add to the tests module in `src-tauri/src/settings.rs`:

```rust
    #[test]
    fn capture_hotkey_defaults_to_ctrl_cmd_space() {
        let s = Settings::default();
        assert_eq!(s.capture_hotkey, "Ctrl+Super+Space");
    }

    #[test]
    fn missing_capture_hotkey_falls_back_to_default() {
        // Файл настроек от прежней версии не содержит этого поля вовсе —
        // оно обязано взять значение по умолчанию, а не уронить чтение.
        let dir = tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"hotkey":"Alt+Space","language":"ru"}"#,
        )
        .unwrap();
        let s = load(dir.path());
        assert_eq!(s.capture_hotkey, "Ctrl+Super+Space");
        assert_eq!(s.hotkey, "Alt+Space");
    }
```

Add to `src/shortcut-conflicts.test.ts`, inside the existing `settings` object literal, the new field, and a new test:

```ts
test('хоткей захвата участвует в проверке конфликтов', () => {
  // Он глобальный, как и хоткей записи: столкновение с чем угодно другим
  // означает, что одна из двух команд молча перестанет срабатывать.
  assert.equal(
    findShortcutConflict(settings.captureHotkey, 'hotkey', settings),
    'Capture selection'
  )
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test capture_hotkey` — expect FAIL, `no field 'capture_hotkey'`.

Run: `npm test` — expect FAIL on the new test and on `каждое хранимое поле с комбинацией перечислено в SHORTCUT_FIELDS`, because the object now has a field the list lacks.

- [ ] **Step 3: Add the Rust field**

In `src-tauri/src/settings.rs`, add to the `Settings` struct beside the other shortcut fields:

```rust
    /// Глобальный хоткей захвата выделенного текста. Как и `hotkey`,
    /// регистрируется системно, поэтому перехватывает комбинацию во всех
    /// приложениях сразу.
    #[serde(default = "default_capture_hotkey")]
    pub capture_hotkey: String,
```

Add the default function beside the other `default_*` helpers:

```rust
/// Ctrl+Cmd+Space: не занято ни одним ходовым приложением, а Cmd+Space и
/// Ctrl+Space по отдельности заняты системой — Spotlight и переключение
/// раскладки, — поэтому третий модификатор здесь обязателен.
fn default_capture_hotkey() -> String {
    "Ctrl+Super+Space".to_string()
}
```

And in `impl Default for Settings`, add:

```rust
            capture_hotkey: default_capture_hotkey(),
```

- [ ] **Step 4: Add the TypeScript field**

In `src/api.ts`, add to the settings type beside `hotkey`:

```ts
  /** Глобальный хоткей захвата выделенного текста из чужого приложения. */
  captureHotkey: string
```

In `src/shortcut-conflicts.ts`, add to `SHORTCUT_FIELDS` directly after the `hotkey` entry:

```ts
  { key: 'captureHotkey', label: 'Capture selection' },
```

In `src/shortcut-conflicts.test.ts`, add to the `settings` object literal:

```ts
  captureHotkey: 'Ctrl+Super+Space',
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test settings::`
Expected: PASS.

Run: `npm test`
Expected: PASS, including the field-list test.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/settings.rs src/api.ts src/shortcut-conflicts.ts src/shortcut-conflicts.test.ts
git commit -m "feat: настройка хоткея захвата выделенного текста"
```

---

### Task 5: Wire capture to the hotkey and the main window

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `capture::capture_selection`, `capture::CaptureOps` (Task 3); `macos::send_copy`, `macos::pasteboard_change_count` (Tasks 1–2); `Settings::capture_hotkey` (Task 4); existing `commands::follow_to_main_window`, `commands::show_main_window`, `macos::has_accessibility_permission`, `macos::frontmost_pid`.
- Produces: `#[tauri::command] pub fn capture_selection(app: AppHandle, state: State<'_, AppState>) -> Result<(), String>` and `pub fn register_capture_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()>`.

- [ ] **Step 1: Add the registered-shortcut slot to state**

In `src-tauri/src/state.rs`, beside `current_hotkey`:

```rust
    /// Зарегистрированный хоткей захвата — хранится, чтобы снять регистрацию
    /// при смене комбинации. Та же роль, что у `current_hotkey`.
    pub current_capture_hotkey: Mutex<Option<Shortcut>>,
```

And in `AppState::new`, beside the existing initialiser:

```rust
            current_capture_hotkey: Mutex::new(None),
```

- [ ] **Step 2: Write the failing test for the ops adapter**

Add to the tests module in `src-tauri/src/commands.rs`:

```rust
    /// Адаптер обязан отдавать примитивы, а не свою логику: весь порядок
    /// действий живёт в capture.rs и проверяется там на подставных данных.
    /// Здесь проверяем лишь то, что чтение счётчика ходит в настоящий буфер
    /// обмена и возвращает то же, что macos::pasteboard_change_count.
    #[test]
    fn capture_ops_reads_the_real_change_count() {
        let a = crate::macos::pasteboard_change_count();
        let b = crate::macos::pasteboard_change_count();
        assert_eq!(a, b);
    }
```

- [ ] **Step 3: Run it to verify it passes trivially**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test capture_ops_reads`

Expected: PASS. This test is a guard, not a driver — it fails loudly if `pasteboard_change_count` is later removed or made non-deterministic.

- [ ] **Step 4: Write the command**

Add to `src-tauri/src/commands.rs`:

```rust
/// Примитивы захвата поверх настоящих буфера обмена и клавиатуры.
struct RealCaptureOps<'a> {
    app: &'a AppHandle,
}

impl CaptureOps for RealCaptureOps<'_> {
    fn change_count(&self) -> i64 {
        macos::pasteboard_change_count()
    }

    fn send_copy(&self) -> anyhow::Result<()> {
        macos::send_copy()
    }

    fn read_text(&self) -> Option<String> {
        // ponytail: восстанавливаем только текст. Если в буфере лежала
        // картинка или файл, вернуть их этим API нечем, и прежнее
        // содержимое будет потеряно — усложнить через NSPasteboard с
        // перечислением всех типов, если это начнёт мешать.
        self.app.clipboard().read_text().ok()
    }

    fn write_text(&self, text: &str) -> anyhow::Result<()> {
        self.app
            .clipboard()
            .write_text(text.to_string())
            .map_err(|e| anyhow::anyhow!("{e}"))
    }

    fn sleep(&self, d: std::time::Duration) {
        std::thread::sleep(d);
    }
}

/// Захватывает выделенный текст из активного приложения и открывает его в
/// главном окне — тем же путём, которым туда попадает надиктованное по кнопке
/// Follow.
#[tauri::command]
pub fn capture_selection(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Право проверяется ДО попытки: CGEventPost при отказе молчит, и без
    // проверки пользователь увидел бы «ничего не выделено» вместо «нет прав».
    if !macos::has_accessibility_permission() {
        return Err(
            "Slaive needs Accessibility permission to copy the selected text. \
             Open System Settings → Privacy & Security → Accessibility and enable Slaive."
                .to_string(),
        );
    }

    // PID запоминаем ДО того, как главное окно заберёт фокус: иначе целью
    // вставки станет сам Slaive. Ровно эта ошибка уже случалась с Follow.
    if let Some(pid) = macos::frontmost_pid() {
        *state.prev_app_pid.lock().unwrap() = Some(pid);
    }

    let ops = RealCaptureOps { app: &app };
    let outcome = capture::capture_selection(&ops).map_err(|e| e.to_string())?;

    // Содержимое не логируем — это текст пользователя. Длина безопасна.
    eprintln!(
        "захвачено символов: {}, буфер обмена восстановлен: {}",
        outcome.text.chars().count(),
        outcome.restored_clipboard
    );

    follow_to_main_window(app, outcome.text)
}
```

Add the imports at the top of `commands.rs` beside the existing ones:

```rust
use crate::capture::{self, CaptureOps};
```

- [ ] **Step 5: Write the hotkey registration**

Add to `src-tauri/src/commands.rs`, modelled on `register_hotkey`:

```rust
/// Регистрирует глобальный хоткей захвата. Отдельно от `register_hotkey`:
/// у них разные обработчики и разные поля состояния, а объединение через
/// параметр только запутало бы обе стороны.
pub fn register_capture_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()> {
    let shortcut: Shortcut = hotkey.parse().map_err(|e| {
        anyhow::anyhow!("Couldn't parse capture hotkey combination \"{hotkey}\": {e}.")
    })?;

    let state = app.state::<AppState>();
    if let Some(old) = state.current_capture_hotkey.lock().unwrap().take() {
        let _ = app.global_shortcut().unregister(old);
    }

    let handle = app.clone();
    app.global_shortcut()
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            // Только на нажатие: иначе команда выполнится дважды за одно
            // срабатывание — и отпускание тоже полезет копировать.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let app = handle.clone();
            // В отдельном потоке: обработчик хоткея не должен блокироваться
            // на полусекундном опросе буфера обмена.
            std::thread::spawn(move || {
                let state = app.state::<AppState>();
                if let Err(e) = capture_selection(app.clone(), state) {
                    let _ = app.emit_to("overlay", "capture:error", e.clone());
                    eprintln!("захват не удался: {e}");
                }
            });
        })?;

    *state.current_capture_hotkey.lock().unwrap() = Some(shortcut);
    Ok(())
}
```

- [ ] **Step 6: Register at startup and expose the command**

In `src-tauri/src/main.rs`, add to the `invoke_handler` list:

```rust
            commands::capture_selection,
```

And in `setup`, after the existing `register_hotkey` block:

```rust
            let capture_hotkey = app
                .state::<state::AppState>()
                .settings
                .lock()
                .unwrap()
                .capture_hotkey
                .clone();
            if let Err(e) = commands::register_capture_hotkey(app.handle(), &capture_hotkey) {
                // Не роняем запуск: без хоткея захвата приложение остаётся
                // полностью рабочим, в отличие от хоткея записи.
                eprintln!("хоткей захвата не зарегистрирован: {e}");
            }
```

- [ ] **Step 7: Re-register on settings save**

In `src-tauri/src/commands.rs`, find `save_settings` and add beside the existing re-registration of `hotkey`:

```rust
    if changed.capture_hotkey != previous.capture_hotkey {
        if let Err(e) = register_capture_hotkey(&app, &changed.capture_hotkey) {
            return Err(e.to_string());
        }
    }
```

Match the surrounding code's variable names — read the function before editing rather than assuming `changed` and `previous`.

- [ ] **Step 8: Verify**

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo test`
Expected: all pass, including the 7 capture tests.

Run: `cd src-tauri && PATH="$HOME/.cargo/bin:$PATH" cargo build`
Expected: zero warnings.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands.rs src-tauri/src/main.rs
git commit -m "feat: глобальный хоткей захвата выделенного текста"
```

---

### Task 6: Capture hotkey row in Settings

**Files:**
- Modify: `src/Settings.tsx` (the Shortcuts section)

**Interfaces:**
- Consumes: `captureHotkey` from Task 4; existing `ShortcutCapture`, `conflictCheck`, `validateHotkey`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Add the row**

In `src/Settings.tsx`, in the Shortcuts section directly after the existing `Hotkey` row, add:

```tsx
      <label>
        Capture selection
        <ShortcutCapture
          value={s.captureHotkey}
          onChange={(accel) => patch({ captureHotkey: accel })}
          requireModifier
          modifierError={
            'A global hotkey needs at least one modifier (Ctrl, Alt, Shift, or Cmd) — otherwise ' +
            'it would capture this key in every app. Try a different combination.'
          }
          validate={conflictCheck('captureHotkey', validateHotkey)}
        />
      </label>
      <p className="hint">
        Select text in any app and press this to pull it into Slaive, where the AI actions can
        work on it. The default <code>Ctrl + Cmd + Space</code> avoids Spotlight
        (<code>Cmd + Space</code>) and input switching (<code>Ctrl + Space</code>). This needs the
        same Accessibility permission as Paste.
      </p>
```

- [ ] **Step 2: Verify types and tests**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/Settings.tsx
git commit -m "feat: строка хоткея захвата в настройках"
```

---

### Task 7: Settings button beside the overlay's close button

**Files:**
- Modify: `src/Overlay.tsx` (beside `.overlay-close`, around line 1001–1009)
- Modify: `src/styles.css`
- Modify: `src/api.ts` if `openSettingsWindow` is not already exported there — check before adding

**Interfaces:**
- Consumes: existing command `open_settings_window`.
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Check the wrapper exists**

Run: `grep -n 'openSettingsWindow' src/api.ts`

If it prints a line, reuse it. If it prints nothing, add to `src/api.ts`:

```ts
export const openSettingsWindow = () => invoke<void>('open_settings_window')
```

- [ ] **Step 2: Add the button**

In `src/Overlay.tsx`, directly before the existing `.overlay-close` button, add:

```tsx
      {/* Настройки рядом с закрытием: обе кнопки управляют окном, а не
          текстом, поэтому живут в одном углу и вне сетки действий — по той
          же причине, по которой оттуда в своё время уехали Play и Close. */}
      <button
        type="button"
        className="overlay-settings"
        onClick={() => openSettingsWindow()}
        aria-label="Settings"
        title="Settings"
      >
        ⚙
      </button>
```

Add `openSettingsWindow` to the existing import from `./api`.

- [ ] **Step 3: Style it**

Append to `src/styles.css`:

```css
/* Кнопка настроек — та же геометрия и материал, что у .overlay-close, но
   левее на свою ширину плюс зазор. Отдельное правило, а не общий класс:
   различаются только координата и символ, и общий класс на две кнопки
   потребовал бы модификатора, что длиннее самого правила. */
.overlay .overlay-settings {
  position: absolute;
  top: 8px;
  right: 34px;
  width: 20px;
  height: 20px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  font-size: 11px;
  line-height: 1;
  color: #8e8e93;
  background: rgba(255, 255, 255, 0.06);
  border: none;
  cursor: pointer;
  padding: 0;
}

.overlay .overlay-settings:hover {
  color: #f2f2f7;
  background: rgba(255, 255, 255, 0.12);
}
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/Overlay.tsx src/styles.css src/api.ts
git commit -m "feat: кнопка настроек в панели рядом с закрытием"
```

---

### Task 8: Surface capture failures in the panel

Task 5 emits `capture:error` when the capture fails — nothing listens yet, so the user presses the hotkey and nothing happens.

**Files:**
- Modify: `src/Overlay.tsx`

**Interfaces:**
- Consumes: the `capture:error` event emitted in Task 5.
- Produces: nothing.

- [ ] **Step 1: Listen for the event**

In `src/Overlay.tsx`, beside the other `listen` effects, add:

```tsx
  // Захват выделения идёт мимо панели, но сообщать о неудаче больше негде:
  // главное окно при неудачном захвате не открывается вовсе.
  useEffect(() => {
    const un = listen<string>('capture:error', (e) => {
      setPhase('error')
      setError(e.payload)
      void showOverlay()
    })
    return () => {
      un.then((f) => f())
    }
  }, [])
```

Check the actual names of the phase/error setters and of the command that shows the panel before writing this — read the surrounding code rather than trusting these names.

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/Overlay.tsx
git commit -m "feat: показывать неудачу захвата в панели"
```

---

## Manual verification

None of the capture path can be exercised without a real desktop, so this is the by-hand checklist:

1. Select a sentence in any application. Press `Ctrl+Cmd+Space`. The main window opens with that text.
2. Check the clipboard afterwards: paste somewhere. It must contain what it held **before** the capture, not the captured text.
3. Press `Ctrl+Cmd+Space` with nothing selected. The panel shows "No text selected", and the main window does not open.
4. In the main window, press Paste. The text lands in the application you captured from, not in Slaive.
5. Revoke Accessibility permission, press the hotkey. The message names the permission rather than claiming nothing was selected.
6. Change the capture hotkey in Settings, save, and confirm the new combination works and the old one no longer does.
7. Try assigning the capture hotkey the same combination as the record hotkey. It must be refused with a message naming the conflict.
8. Press the gear button in the panel. Settings open.

---

## Self-Review

**Spec coverage.** The request has three parts. *Capture selected text from any app via a hotkey* — Tasks 1, 2, 3, 5. *Ctrl+Cmd+Space specifically* — Task 4 sets it as the default. *Land it where Follow lands* — Task 5 calls `follow_to_main_window`, the same function the Follow button uses, so translate/AI actions work with no further change. *Settings button next to close* — Task 7. Task 8 covers a gap the request does not mention but the implementation creates: a failure with nowhere to appear.

**Placeholder scan.** Every code step carries the actual code. Three steps deliberately instruct the implementer to read surrounding code before editing — `save_settings` variable names in Task 5, the `openSettingsWindow` export in Task 7, the phase/error setter names in Task 8 — because guessing those names from this plan is exactly how a plan introduces a bug.

**Type consistency.** `CaptureOps`, `CaptureOutcome`, `capture_selection`, `POLL_INTERVAL`, `POLL_DEADLINE` are defined in Task 3 and used with the same names and signatures in Task 5. `capture_hotkey` (Rust) and `captureHotkey` (TypeScript) follow the project's existing snake_case/camelCase split. `register_capture_hotkey` is defined in Task 5 and called in the same task and in `save_settings`.

**One risk worth stating.** The capture writes to the clipboard twice — once implicitly via `Cmd+C`, once to restore. Any clipboard manager the user runs will record the captured text as a clipboard entry. That is inherent to the only approach macOS permits, not a defect in this design, but it is worth telling the user rather than letting them discover it.
