# Slaive v1 — голосовой оверлей (whisper.cpp) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Меню-бар приложение для macOS: удерживаешь `Ctrl+Space` — поверх любого окна появляется панель и пишет голос; отпустил — whisper.cpp локально расшифровывает речь, показывает текст, кнопка «Вставить» вставляет его в то приложение, из которого вызвали.

**Architecture:** Tauri 2 (Rust-бэкенд + React-фронтенд). Приложение живёт в статус-баре без иконки в доке (`ActivationPolicy::Accessory`). Глобальный хоткей регистрируется через `tauri-plugin-global-shortcut`, который на macOS отдаёт и `Pressed`, и `Released` — на этом строится hold-to-talk. Аудио пишется через `cpal` на выделенном потоке (`cpal::Stream` не `Send`), сводится в моно и ресемплится до 16 кГц. Транскрипция — `whisper-rs` (whisper.cpp слинкован в бинарь, ускорение Metal). Возврат текста в чужое окно — буфер обмена + `osascript` (восстановить фокус по PID + `Cmd+V`), это требует разрешения «Универсальный доступ».

**Tech Stack:** Rust (edition 2021), Tauri 2.x, React 18 + TypeScript + Vite, `whisper-rs` 0.14 (feature `metal`), `cpal` 0.15, `reqwest` 0.12, `anyhow`, `serde`/`serde_json`.

**Spec:** этот документ, раздел «Спецификация v1» ниже.

---

## Спецификация v1

Что делает приложение:

1. Запускается, показывает иконку в статус-баре. Иконки в доке нет.
2. Пользователь работает в любом приложении (Slack, Notion, редактор). **Зажимает `Ctrl+Space`.**
3. Поверх текущего окна появляется небольшая панель Slaive с индикатором записи. Запись микрофона стартует немедленно. Фокус у исходного приложения не отбирается.
4. Пользователь говорит. **Отпускает `Ctrl+Space`** — запись останавливается, панель показывает «Расшифровываю…».
5. Аудио уходит в whisper.cpp (локально, без сети). Через 1–5 секунд в панели появляется распознанный текст.
6. Пользователь жмёт **«Вставить»** — текст попадает в буфер обмена, фокус возвращается исходному приложению, отправляется `Cmd+V`, панель скрывается.
7. Альтернативы: **«Копировать»** (только буфер), `Esc` (закрыть без действия).
8. Кнопка микрофона в панели дублирует хоткей кликом (старт/стоп) — на случай длинной диктовки.

Настройки (отдельное окно из меню статус-бара):

- Хоткей (по умолчанию `Ctrl+Space`, редактируемый текстом в формате Tauri: `Ctrl+Space`, `Alt+Space`, `CommandOrControl+Shift+D`).
- Путь к модели `ggml-*.bin` — можно указать вручную (поле + кнопка «Обзор» не делаем, просто текстовое поле с путём), либо нажать **«Скачать»**: выбор модели из списка, загрузка с прогрессом в служебную папку приложения, путь прописывается автоматически.
- Язык распознавания: `auto` / `ru` / `en`.
- Предупреждение о конфликте `Ctrl+Space` со штатным переключением раскладки в macOS.

Чего в v1 **нет** (сознательно): работы с выделенным текстом, LLM-обработки, действий/пресетов, истории, стриминга частичной транскрипции, Windows/Linux, подписи и нотаризации для распространения.

---

## Global Constraints

- Целевая платформа: **macOS 12+**, основная сборка `aarch64-apple-darwin` (Apple Silicon). Intel — не проверяем в v1.
- Bundle identifier: `net.slaive.app`. Product name: `Slaive`.
- Весь пользовательский текст в UI — **на русском**.
- Аудио, подаваемое в whisper: **`f32`, 16 000 Гц, моно**. Любой другой формат — ошибка.
- Сетевые запросы разрешены **только** к `https://huggingface.co` для скачивания модели. Больше никуда.
- Файл настроек: `~/Library/Application Support/net.slaive.app/settings.json`. Модели: `~/Library/Application Support/net.slaive.app/models/`. Путь берётся через `app.path().app_data_dir()`, не хардкодится.
- Ошибки Rust внутри модулей — `anyhow::Result`. На границе `#[tauri::command]` конвертируются в `Result<T, String>` через `.map_err(|e| e.to_string())`.
- Никогда не логировать содержимое транскрипции — это личная речь пользователя. Логировать можно длительность записи, количество сэмплов, код ошибки.
- Коммиты: conventional commits (`feat:`, `fix:`, `chore:`, `test:`). Шаги «Commit» в плане выполняются исполнителем без дополнительного согласования — они часть плана.
- Осознанные упрощения помечаются комментарием `// ponytail: <что упрощено>, <когда усложнять>`.

### Предварительные требования окружения

На машине сейчас **нет Rust** (`cargo`/`rustc` не найдены). До Task 1 нужно:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
brew install cmake            # нужен whisper-rs для сборки whisper.cpp
xcode-select --install        # libclang для bindgen (если ещё не стоит)
```

Проверка: `rustc -V && cargo -V && cmake --version && node -v` — все четыре команды должны отработать.

---

## File Structure

```
slaive/
├── CLAUDE.md                       # ЗАМЕНИТЬ: сейчас там инструкции чужого проекта (Juna API)
├── AGENTS.md                       # ЗАМЕНИТЬ: то же самое
├── package.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── src/                            # React-фронтенд
│   ├── main.tsx                    # точка входа, выбор компонента по label окна
│   ├── Overlay.tsx                 # панель: микрофон, состояние, текст, кнопки
│   ├── Settings.tsx                # окно настроек: хоткей, модель, язык
│   ├── api.ts                      # типизированные обёртки над invoke/listen
│   └── styles.css
└── src-tauri/
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── Info.plist                  # NSMicrophoneUsageDescription
    ├── capabilities/default.json
    ├── icons/
    └── src/
        ├── main.rs                 # setup: tray, activation policy, хоткей, состояние
        ├── state.rs                # AppState
        ├── settings.rs             # чтение/запись settings.json
        ├── model.rs                # каталог моделей + скачивание с прогрессом
        ├── audio.rs                # cpal-запись, to_mono, resample_to_16k
        ├── whisper.rs              # загрузка модели, транскрипция
        ├── macos.rs                # frontmost PID, восстановление фокуса, Cmd+V
        └── commands.rs             # весь #[tauri::command]-слой
```

Ответственность жёсткая: `commands.rs` не содержит бизнес-логики (только оркестрация + конвертация ошибок), `audio.rs` ничего не знает про whisper, `whisper.rs` ничего не знает про Tauri, `macos.rs` — единственное место с `osascript` и платформенными вызовами.

---

## Task 1: Каркас — tray-приложение без иконки в доке

**Files:**
- Create: `package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/styles.css`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/src/main.rs`, `src-tauri/capabilities/default.json`
- Modify: `CLAUDE.md`, `AGENTS.md` (заменить содержимое целиком)
- Create: `.gitignore` (дополнить)

**Interfaces:**
- Consumes: ничего (первая задача)
- Produces: рабочий `npm run tauri dev`; окна `overlay` и `settings` объявлены в конфиге и скрыты; трей с пунктами «Настройки» и «Выход»

- [ ] **Step 1: Инициализировать git и заменить чужие инструкции**

```bash
cd /Users/artschekoff/Documents/slaive
git init
```

Полностью перезаписать `CLAUDE.md` (и скопировать его же в `AGENTS.md`):

```markdown
# Slaive

Меню-бар приложение для macOS: голосовой ввод поверх любого окна.
Tauri 2 + React + TypeScript (фронтенд) + Rust (бэкенд), whisper.cpp через whisper-rs.

## Архитектура
- `src-tauri/src/commands.rs` — единственный слой `#[tauri::command]`, без бизнес-логики
- `src-tauri/src/audio.rs` — запись с микрофона, ничего не знает про whisper
- `src-tauri/src/whisper.rs` — транскрипция, ничего не знает про Tauri
- `src-tauri/src/macos.rs` — единственное место с платформенными вызовами (osascript)
- `src/` — React, два окна: `overlay` и `settings`, выбираются по label окна

## Жёсткие правила
- Аудио для whisper: f32, 16 000 Гц, моно. Ничего другого не подавать.
- Никогда не логировать текст транскрипции — это личная речь пользователя.
- Пути к данным только через `app.path().app_data_dir()`, не хардкодить.
- Сеть — только huggingface.co для скачивания модели.
- Ошибки: `anyhow::Result` внутри модулей, `Result<T, String>` на границе команд.
- Весь UI-текст на русском.
- Осознанные упрощения помечать `// ponytail: <что>, <когда усложнять>`.

## Команды
- `npm run tauri dev` — запуск
- `cd src-tauri && cargo test` — юнит-тесты Rust
- `npm run tauri build` — сборка .app
```

- [ ] **Step 2: Создать фронтенд-каркас**

`package.json`:

```json
{
  "name": "slaive",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.1.1",
    "@tauri-apps/plugin-global-shortcut": "^2.2.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.1.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "typescript": "^5.6.3",
    "vite": "^6.0.3"
  }
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
})
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true
  },
  "include": ["src"]
}
```

`index.html`:

```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <title>Slaive</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/main.tsx` (пока заглушка, компоненты появятся в Task 2 и 3):

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="placeholder">Slaive</div>
  </React.StrictMode>
)
```

`src/styles.css`:

```css
* { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  color: #f2f2f7;
  background: transparent;
  user-select: none;
}

.placeholder { padding: 16px; }
```

- [ ] **Step 3: Создать Rust-каркас**

`src-tauri/Cargo.toml`:

```toml
[package]
name = "slaive"
version = "0.1.0"
edition = "2021"

[lib]
name = "slaive_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = ["tray-icon", "macos-private-api"] }
tauri-plugin-global-shortcut = "2"
tauri-plugin-clipboard-manager = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"

[profile.release]
strip = true
lto = true
```

`src-tauri/build.rs`:

```rust
fn main() {
    tauri_build::build()
}
```

`src-tauri/tauri.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Slaive",
  "version": "0.1.0",
  "identifier": "net.slaive.app",
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "macOSPrivateApi": true,
    "withGlobalTauri": false,
    "windows": [
      {
        "label": "overlay",
        "url": "index.html",
        "title": "Slaive",
        "width": 440,
        "height": 240,
        "resizable": false,
        "decorations": false,
        "transparent": true,
        "shadow": false,
        "alwaysOnTop": true,
        "skipTaskbar": true,
        "center": true,
        "focus": false,
        "visible": false
      },
      {
        "label": "settings",
        "url": "index.html",
        "title": "Настройки Slaive",
        "width": 560,
        "height": 480,
        "resizable": false,
        "visible": false
      }
    ],
    "security": { "csp": null }
  },
  "bundle": {
    "active": true,
    "targets": ["app", "dmg"],
    "icon": ["icons/icon.icns"],
    "macOS": { "minimumSystemVersion": "12.0" }
  }
}
```

`src-tauri/capabilities/default.json`:

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "Права для окон overlay и settings",
  "windows": ["overlay", "settings"],
  "permissions": [
    "core:default",
    "core:window:allow-hide",
    "core:window:allow-show",
    "core:event:default"
  ]
}
```

`src-tauri/src/main.rs`:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Manager,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
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
```

- [ ] **Step 4: Сгенерировать иконки и запустить**

```bash
cd /Users/artschekoff/Documents/slaive
npm install
npx tauri icon   # создаст src-tauri/icons/* из дефолтного шаблона; свою иконку подложим позже
npm run tauri dev
```

Ожидается: первая сборка Rust идёт несколько минут. Затем в статус-баре появляется иконка. Никаких окон не открывается, в доке приложения нет.

- [ ] **Step 5: Проверить вручную**

- Иконки Slaive в доке **нет**.
- Клик по иконке в статус-баре открывает меню с «Настройки…» и «Выход».
- «Настройки…» открывает пустое окно с надписью «Slaive».
- «Выход» закрывает приложение.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: каркас Tauri-приложения с иконкой в статус-баре"
```

---

## Task 2: Настройки — хранение и окно

**Files:**
- Create: `src-tauri/src/settings.rs`
- Create: `src-tauri/src/state.rs`
- Create: `src-tauri/src/commands.rs`
- Create: `src/Settings.tsx`, `src/api.ts`
- Modify: `src-tauri/src/main.rs`, `src/main.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: каркас из Task 1
- Produces:
  - `settings::Settings { hotkey: String, model_path: Option<PathBuf>, language: String }`
  - `settings::load(dir: &Path) -> Settings`, `settings::save(dir: &Path, s: &Settings) -> anyhow::Result<()>`
  - `state::AppState { settings: Mutex<Settings>, recorder: Mutex<Option<audio::Recorder>>, transcriber: Mutex<Option<whisper::Transcriber>>, prev_app_pid: Mutex<Option<i32>> }` — поля `recorder`/`transcriber` появляются в Task 4/6, здесь объявляем только `settings` и `prev_app_pid`
  - команды `get_settings() -> Settings`, `save_settings(settings: Settings) -> ()`
  - TS-тип `Settings { hotkey: string; modelPath: string | null; language: string }`

- [ ] **Step 1: Написать падающие тесты для settings.rs**

Создать `src-tauri/src/settings.rs` **только с тестами и объявлениями** — тесты должны не компилироваться/падать:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("slaive-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_when_file_missing() {
        let dir = tmp();
        let s = load(&dir);
        assert_eq!(s.hotkey, "Ctrl+Space");
        assert_eq!(s.model_path, None);
        assert_eq!(s.language, "auto");
    }

    #[test]
    fn round_trip() {
        let dir = tmp();
        let s = Settings {
            hotkey: "Alt+Space".into(),
            model_path: Some(std::path::PathBuf::from("/tmp/ggml-small.bin")),
            language: "ru".into(),
        };
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
    }

    #[test]
    fn defaults_when_file_corrupt() {
        let dir = tmp();
        std::fs::write(dir.join("settings.json"), "{ это не json").unwrap();
        assert_eq!(load(&dir), Settings::default());
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(dir.join("settings.json"), r#"{"language":"en"}"#).unwrap();
        let s = load(&dir);
        assert_eq!(s.language, "en");
        assert_eq!(s.hotkey, "Ctrl+Space");
    }
}
```

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

```bash
cd src-tauri && cargo test settings
```

Ожидается: ошибка компиляции — `cannot find type Settings in this scope`.

- [ ] **Step 3: Реализовать settings.rs**

Дописать **в начало** `src-tauri/src/settings.rs`:

```rust
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Строка хоткея в формате Tauri, например "Ctrl+Space".
    pub hotkey: String,
    /// Абсолютный путь к файлу модели ggml-*.bin.
    pub model_path: Option<PathBuf>,
    /// "auto" | "ru" | "en"
    pub language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            hotkey: "Ctrl+Space".to_string(),
            model_path: None,
            language: "auto".to_string(),
        }
    }
}

/// Битый или отсутствующий файл — не ошибка: возвращаем дефолты, чтобы
/// приложение всегда стартовало.
/// ponytail: без резервных копий и версионирования схемы, добавить когда полей станет много
pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).context("не удалось создать папку настроек")?;
    let raw = serde_json::to_string_pretty(s)?;
    std::fs::write(dir.join(FILE_NAME), raw).context("не удалось записать настройки")?;
    Ok(())
}
```

- [ ] **Step 4: Запустить тесты — должны пройти**

```bash
cd src-tauri && cargo test settings
```

Ожидается: `test result: ok. 4 passed`.

- [ ] **Step 5: Добавить состояние приложения**

`src-tauri/src/state.rs`:

```rust
use crate::settings::Settings;
use std::sync::Mutex;

pub struct AppState {
    pub settings: Mutex<Settings>,
    /// PID приложения, которое было активным в момент нажатия хоткея.
    pub prev_app_pid: Mutex<Option<i32>>,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Mutex::new(settings),
            prev_app_pid: Mutex::new(None),
        }
    }
}
```

- [ ] **Step 6: Добавить слой команд**

`src-tauri/src/commands.rs`:

```rust
use crate::settings::{self, Settings};
use crate::state::AppState;
use tauri::{AppHandle, Manager, State};

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
    Ok(())
}
```

- [ ] **Step 7: Подключить модули и состояние в main.rs**

Добавить в начало `src-tauri/src/main.rs` (после `#![cfg_attr...]`):

```rust
mod commands;
mod settings;
mod state;
```

И внутри `.setup(|app| {` **первой строкой**:

```rust
let dir = commands::data_dir(app.handle())?;
let loaded = settings::load(&dir);
app.manage(state::AppState::new(loaded));
```

А в билдер добавить обработчик команд — перед `.setup(`:

```rust
.invoke_handler(tauri::generate_handler![
    commands::get_settings,
    commands::save_settings,
])
```

- [ ] **Step 8: Написать типизированный фронтенд-API**

`src/api.ts`:

```ts
import { invoke } from '@tauri-apps/api/core'

export type Settings = {
  hotkey: string
  modelPath: string | null
  language: 'auto' | 'ru' | 'en'
}

export const getSettings = () => invoke<Settings>('get_settings')
export const saveSettings = (settings: Settings) => invoke<void>('save_settings', { settings })
```

- [ ] **Step 9: Сделать окно настроек**

`src/Settings.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { getSettings, saveSettings, type Settings as S } from './api'

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getSettings().then(setS)
  }, [])

  if (!s) return <div className="settings">Загрузка…</div>

  const patch = (p: Partial<S>) => {
    setS({ ...s, ...p })
    setSaved(false)
  }

  const onSave = async () => {
    await saveSettings(s)
    setSaved(true)
  }

  return (
    <div className="settings">
      <h1>Настройки</h1>

      <label>
        Горячая клавиша
        <input value={s.hotkey} onChange={(e) => patch({ hotkey: e.target.value })} />
      </label>
      <p className="hint">
        Держи эту комбинацию, чтобы записывать голос. По умолчанию <code>Ctrl+Space</code> —
        в macOS она может быть занята переключением раскладки. Отключи её в
        «Системные настройки → Клавиатура → Сочетания клавиш → Источники ввода»
        или выбери другую комбинацию.
      </p>

      <label>
        Язык распознавания
        <select
          value={s.language}
          onChange={(e) => patch({ language: e.target.value as S['language'] })}
        >
          <option value="auto">Определять автоматически</option>
          <option value="ru">Русский</option>
          <option value="en">Английский</option>
        </select>
      </label>

      <label>
        Путь к модели whisper (ggml-*.bin)
        <input
          value={s.modelPath ?? ''}
          placeholder="/путь/к/ggml-small.bin"
          onChange={(e) => patch({ modelPath: e.target.value || null })}
        />
      </label>

      <button className="primary" onClick={onSave}>
        Сохранить
      </button>
      {saved && <span className="ok">Сохранено</span>}
    </div>
  )
}
```

- [ ] **Step 10: Роутинг по окнам и стили**

Заменить `src/main.tsx`:

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Settings } from './Settings'
import './styles.css'

const label = getCurrentWebviewWindow().label

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {label === 'settings' ? <Settings /> : <div className="placeholder">Slaive</div>}
  </React.StrictMode>
)
```

Дописать в `src/styles.css`:

```css
.settings {
  background: #1c1c1e;
  min-height: 100vh;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  user-select: text;
}

.settings h1 { font-size: 18px; font-weight: 600; }

.settings label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: #a1a1a6;
}

.settings input,
.settings select {
  background: #2c2c2e;
  border: 1px solid #3a3a3c;
  border-radius: 6px;
  padding: 8px 10px;
  color: #f2f2f7;
  font-size: 13px;
}

.hint { font-size: 12px; color: #8e8e93; line-height: 1.4; }
.hint code { background: #2c2c2e; padding: 1px 4px; border-radius: 3px; }

button.primary {
  align-self: flex-start;
  background: #0a84ff;
  border: none;
  border-radius: 6px;
  color: #fff;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}

.ok { color: #30d158; font-size: 12px; }
```

- [ ] **Step 11: Проверить вручную**

```bash
npm run tauri dev
```

Открыть «Настройки…» из трея: поля заполнены дефолтами. Изменить язык на «Русский», нажать «Сохранить», закрыть и переоткрыть окно — значение сохранилось. Проверить файл:

```bash
cat ~/Library/Application\ Support/net.slaive.app/settings.json
```

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "feat: настройки приложения с сохранением в app data"
```

---

## Task 3: Оверлей и hold-to-talk хоткей (без звука)

**Files:**
- Create: `src/Overlay.tsx`
- Modify: `src-tauri/src/main.rs`, `src-tauri/src/commands.rs`, `src-tauri/Cargo.toml`, `src/main.tsx`, `src/api.ts`, `src/styles.css`

**Interfaces:**
- Consumes: `AppState`, `get_settings`/`save_settings` из Task 2
- Produces:
  - `commands::hotkey_pressed(app: &AppHandle)` и `commands::hotkey_released(app: &AppHandle)` — обычные функции, не команды
  - `commands::register_hotkey(app: &AppHandle, hotkey: &str) -> anyhow::Result<()>`
  - команда `hide_overlay(app: AppHandle)`
  - события в окно `overlay`: `rec:start` (без payload), `rec:stop` (без payload), `error` (payload `String`)

- [ ] **Step 1: Добавить плагин глобального хоткея**

В `src-tauri/Cargo.toml` он уже объявлен в Task 1. Подключить плагин в `main.rs` в цепочку билдера:

```rust
.plugin(tauri_plugin_global_shortcut::Builder::new().build())
```

- [ ] **Step 2: Реализовать показ оверлея и обработчики хоткея**

Дописать в `src-tauri/src/commands.rs`:

```rust
use tauri::Emitter;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

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

/// Хоткей зажат: показываем панель и начинаем запись.
pub fn hotkey_pressed(app: &AppHandle) {
    show_overlay(app);
    let _ = app.emit_to("overlay", "rec:start", ());
}

/// Хоткей отпущен: останавливаем запись и запускаем расшифровку.
pub fn hotkey_released(app: &AppHandle) {
    let _ = app.emit_to("overlay", "rec:stop", ());
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
```

- [ ] **Step 3: Регистрировать хоткей на старте и при сохранении настроек**

В `main.rs` внутри `.setup(...)` после `app.manage(...)` добавить:

```rust
let hotkey = app.state::<state::AppState>().settings.lock().unwrap().hotkey.clone();
if let Err(e) = commands::register_hotkey(app.handle(), &hotkey) {
    eprintln!("хоткей не зарегистрирован: {e}");
}
```

В `save_settings` перед `Ok(())` добавить перерегистрацию:

```rust
// Клонируем строку и сразу отпускаем мьютекс — register_hotkey не должен
// вызываться с удерживаемой блокировкой настроек.
let hotkey = state.settings.lock().unwrap().hotkey.clone();
register_hotkey(&app, &hotkey).map_err(|e| e.to_string())?;
```

Добавить `commands::hide_overlay` в `generate_handler!`.

- [ ] **Step 4: Сделать компонент оверлея**

`src/Overlay.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { hideOverlay } from './api'

type Phase = 'idle' | 'recording' | 'transcribing' | 'ready' | 'error'

const LABEL: Record<Phase, string> = {
  idle: 'Зажми хоткей и говори',
  recording: 'Записываю…',
  transcribing: 'Расшифровываю…',
  ready: 'Готово',
  error: 'Ошибка',
}

export function Overlay() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    const subs = [
      listen('rec:start', () => {
        setPhase('recording')
        setText('')
        setError('')
      }),
      listen('rec:stop', () => setPhase('transcribing')),
      listen<string>('transcript', (e) => {
        setText(e.payload)
        setPhase('ready')
      }),
      listen<string>('error', (e) => {
        setError(e.payload)
        setPhase('error')
      }),
    ]
    return () => {
      subs.forEach((p) => p.then((un) => un()))
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hideOverlay()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="overlay">
      <div className="row">
        <div className={`mic ${phase === 'recording' ? 'live' : ''}`}>🎤</div>
        <div className="status">{phase === 'error' ? error : LABEL[phase]}</div>
      </div>
      <div className="transcript">{text || <span className="dim">—</span>}</div>
      <div className="actions">
        <button onClick={() => hideOverlay()}>Закрыть</button>
      </div>
    </div>
  )
}
```

Дописать в `src/api.ts`:

```ts
export const hideOverlay = () => invoke<void>('hide_overlay')
```

Подключить в `src/main.tsx`:

```tsx
import { Overlay } from './Overlay'
// …
{label === 'settings' ? <Settings /> : <Overlay />}
```

- [ ] **Step 5: Стили оверлея**

Дописать в `src/styles.css`:

```css
.overlay {
  background: rgba(28, 28, 30, 0.92);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  height: 100vh;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.overlay .row { display: flex; align-items: center; gap: 10px; }

.overlay .mic {
  width: 32px;
  height: 32px;
  border-radius: 16px;
  background: #2c2c2e;
  display: grid;
  place-items: center;
  font-size: 16px;
  cursor: pointer;
  flex-shrink: 0;
}

.overlay .mic.live {
  background: #ff453a;
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  50% { opacity: 0.55; }
}

.overlay .status { font-size: 13px; color: #a1a1a6; }

.overlay .transcript {
  flex: 1;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.45;
  user-select: text;
}

.overlay .dim { color: #636366; }

.overlay .actions { display: flex; gap: 8px; }

.overlay button {
  background: #2c2c2e;
  border: none;
  border-radius: 6px;
  color: #f2f2f7;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}

.overlay button.primary { background: #0a84ff; color: #fff; }
.overlay button:disabled { opacity: 0.4; cursor: default; }
```

- [ ] **Step 6: Проверить вручную**

```bash
npm run tauri dev
```

Переключиться в другое приложение (например, Notes). Зажать `Ctrl+Space`:

- Панель появляется поверх окна, микрофон краснеет, статус «Записываю…».
- Курсор остаётся в Notes — можно продолжать печатать, фокус не украден.
- Отпустить хоткей: статус меняется на «Расшифровываю…» (текста пока не будет — это Task 7).
- `Esc` не сработает, пока панель не в фокусе — это ожидаемо; кнопка «Закрыть» скрывает панель.

Если `Ctrl+Space` перехватывается системой (меняется раскладка) — отключить системный шорткат в «Системные настройки → Клавиатура → Сочетания клавиш → Источники ввода» и перезапустить проверку.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: оверлей-панель и hold-to-talk глобальный хоткей"
```

---

## Task 4: Запись с микрофона

**Files:**
- Create: `src-tauri/src/audio.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/state.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `AppState` из Task 2
- Produces:
  - `audio::WHISPER_SAMPLE_RATE: u32` (= 16000)
  - `audio::to_mono(interleaved: &[f32], channels: u16) -> Vec<f32>`
  - `audio::resample_to_16k(input: &[f32], from_rate: u32) -> Vec<f32>`
  - `audio::Recorder` с `audio::Recorder::start() -> anyhow::Result<Recorder>` и `Recorder::stop(self) -> anyhow::Result<Vec<f32>>` (возвращает f32 моно 16 кГц)
  - поле `AppState::recorder: Mutex<Option<audio::Recorder>>`

- [ ] **Step 1: Добавить cpal**

В `src-tauri/Cargo.toml` в `[dependencies]`:

```toml
cpal = "0.15"
```

- [ ] **Step 2: Написать падающие тесты для чистых функций**

Создать `src-tauri/src/audio.rs` с одними тестами:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_passthrough() {
        let input = [0.1_f32, 0.2, 0.3];
        assert_eq!(to_mono(&input, 1), vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn stereo_averages_channels() {
        // L=0.0 R=1.0 -> 0.5 ; L=-1.0 R=1.0 -> 0.0
        let input = [0.0_f32, 1.0, -1.0, 1.0];
        assert_eq!(to_mono(&input, 2), vec![0.5, 0.0]);
    }

    #[test]
    fn mono_handles_empty() {
        assert!(to_mono(&[], 2).is_empty());
    }

    #[test]
    fn resample_noop_at_target_rate() {
        let input = vec![0.5_f32; 100];
        assert_eq!(resample_to_16k(&input, 16_000), input);
    }

    #[test]
    fn resample_48k_shrinks_threefold() {
        let input = vec![0.25_f32; 48_000]; // ровно 1 секунда
        let out = resample_to_16k(&input, 48_000);
        assert_eq!(out.len(), 16_000);
        // Постоянный сигнал должен пережить ресемплинг без искажений.
        assert!(out.iter().all(|s| (s - 0.25).abs() < 1e-6));
    }

    #[test]
    fn resample_44k_gives_expected_length() {
        let input = vec![0.0_f32; 44_100];
        assert_eq!(resample_to_16k(&input, 44_100).len(), 16_000);
    }

    #[test]
    fn resample_handles_empty() {
        assert!(resample_to_16k(&[], 48_000).is_empty());
    }
}
```

- [ ] **Step 3: Запустить тесты и убедиться, что они падают**

```bash
cd src-tauri && cargo test audio
```

Ожидается: ошибка компиляции — `cannot find function to_mono`.

- [ ] **Step 4: Реализовать чистые функции**

Дописать **в начало** `src-tauri/src/audio.rs`:

```rust
use anyhow::{anyhow, Context};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

/// whisper.cpp принимает только 16 кГц моно f32.
pub const WHISPER_SAMPLE_RATE: u32 = 16_000;

/// Сводит чередующиеся каналы в моно усреднением.
pub fn to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    let ch = channels as usize;
    interleaved
        .chunks_exact(ch)
        .map(|frame| frame.iter().sum::<f32>() / ch as f32)
        .collect()
}

/// Понижает частоту дискретизации до 16 кГц усреднением по окну — грубый
/// низкочастотный фильтр, которого достаточно для речи.
/// ponytail: box-фильтр вместо нормального polyphase FIR; при повышении
/// частоты (from_rate < 16k, редкий случай) вырождается в ближайшего соседа.
/// Если появятся жалобы на качество — заменить на rubato::FftFixedIn.
pub fn resample_to_16k(input: &[f32], from_rate: u32) -> Vec<f32> {
    if input.is_empty() || from_rate == WHISPER_SAMPLE_RATE {
        return input.to_vec();
    }
    let ratio = from_rate as f64 / WHISPER_SAMPLE_RATE as f64;
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let start = (i as f64 * ratio) as usize;
        let end = ((((i + 1) as f64) * ratio) as usize)
            .min(input.len())
            .max(start + 1);
        let sum: f32 = input[start..end].iter().sum();
        out.push(sum / (end - start) as f32);
    }
    out
}
```

- [ ] **Step 5: Запустить тесты — должны пройти**

```bash
cd src-tauri && cargo test audio
```

Ожидается: `test result: ok. 7 passed`.

- [ ] **Step 6: Реализовать Recorder**

Дописать в `src-tauri/src/audio.rs` (перед блоком `#[cfg(test)]`):

```rust
/// Пишет с микрофона на выделенном потоке: `cpal::Stream` не `Send`,
/// поэтому он не может жить в состоянии Tauri напрямую.
pub struct Recorder {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<Vec<f32>>,
}

impl Recorder {
    pub fn start() -> anyhow::Result<Self> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<Vec<f32>>();
        let (init_tx, init_rx) = mpsc::channel::<anyhow::Result<()>>();

        std::thread::spawn(move || {
            let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

            let built = (|| -> anyhow::Result<(cpal::Stream, u32, u16)> {
                let device = cpal::default_host()
                    .default_input_device()
                    .ok_or_else(|| anyhow!("микрофон не найден"))?;
                let config = device
                    .default_input_config()
                    .context("не удалось получить настройки микрофона")?;
                let sample_rate = config.sample_rate().0;
                let channels = config.channels();
                let sink = buffer.clone();
                let stream = device
                    .build_input_stream(
                        &config.into(),
                        move |data: &[f32], _| {
                            if let Ok(mut b) = sink.lock() {
                                b.extend_from_slice(data);
                            }
                        },
                        |err| eprintln!("ошибка потока микрофона: {err}"),
                        None,
                    )
                    .context("не удалось открыть поток микрофона")?;
                stream.play().context("не удалось запустить запись")?;
                Ok((stream, sample_rate, channels))
            })();

            let (stream, sample_rate, channels) = match built {
                Ok(v) => {
                    let _ = init_tx.send(Ok(()));
                    v
                }
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };

            // Блокируемся, пока не попросят остановиться (или пока отправитель не умрёт).
            let _ = stop_rx.recv();
            drop(stream);

            let raw = buffer.lock().map(|b| b.clone()).unwrap_or_default();
            let mono = to_mono(&raw, channels);
            let _ = done_tx.send(resample_to_16k(&mono, sample_rate));
        });

        init_rx.recv().context("поток записи не запустился")??;
        Ok(Self { stop_tx, done_rx })
    }

    /// Останавливает запись и отдаёт 16 кГц моно f32.
    pub fn stop(self) -> anyhow::Result<Vec<f32>> {
        let _ = self.stop_tx.send(());
        self.done_rx
            .recv()
            .context("поток записи завершился без результата")
    }
}
```

Замечание про `build_input_stream`: он типизирован под `f32`. Если системный микрофон отдаёт `i16`/`u16`, вызов вернёт ошибку формата. На macOS CoreAudio по умолчанию отдаёт `f32`, поэтому этого достаточно.
`// ponytail: поддерживаем только f32-вход, добавить ветки i16/u16 если появится устройство, которое падает`

- [ ] **Step 7: Добавить recorder в состояние**

В `src-tauri/src/state.rs`:

```rust
use crate::audio::Recorder;
// …
pub struct AppState {
    pub settings: Mutex<Settings>,
    pub prev_app_pid: Mutex<Option<i32>>,
    pub recorder: Mutex<Option<Recorder>>,
}
```

И в `AppState::new`: `recorder: Mutex::new(None),`.

Добавить `mod audio;` в `main.rs`.

- [ ] **Step 8: Проверить компиляцию и тесты целиком**

```bash
cd src-tauri && cargo test
```

Ожидается: все тесты проходят, предупреждений о неиспользуемом `Recorder` может не быть (он используется в state).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: запись с микрофона с приведением к 16 кГц моно"
```

---

## Task 5: Скачивание модели whisper

**Files:**
- Create: `src-tauri/src/model.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/api.ts`, `src/Settings.tsx`, `src/styles.css`

**Interfaces:**
- Consumes: `commands::data_dir` из Task 2
- Produces:
  - `model::CATALOG: &[ModelInfo]` где `ModelInfo { id: &str, label: &str, size_mb: u32 }`
  - `model::url_for(id: &str) -> Option<String>`
  - `model::file_name(id: &str) -> String`
  - `model::download(app: &AppHandle, dir: &Path, id: &str) -> anyhow::Result<PathBuf>` (async)
  - команда `download_model(app, state, id: String) -> Result<String, String>` (возвращает путь и сразу сохраняет его в настройки)
  - команда `list_models() -> Vec<ModelInfo>`
  - событие `model:progress` с payload `{ downloaded: u64, total: u64 }` в окно `settings`

- [ ] **Step 1: Добавить reqwest и futures**

В `src-tauri/Cargo.toml`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
futures-util = "0.3"
```

- [ ] **Step 2: Написать падающие тесты каталога моделей**

Создать `src-tauri/src/model.rs` с одними тестами:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_not_empty_and_has_small() {
        assert!(CATALOG.iter().any(|m| m.id == "small"));
    }

    #[test]
    fn file_name_follows_ggml_convention() {
        assert_eq!(file_name("small"), "ggml-small.bin");
        assert_eq!(file_name("large-v3-turbo"), "ggml-large-v3-turbo.bin");
    }

    #[test]
    fn url_points_at_huggingface_for_known_ids() {
        assert_eq!(
            url_for("small").unwrap(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
        );
    }

    #[test]
    fn url_rejects_unknown_ids() {
        // Защита от подстановки произвольного пути в URL.
        assert!(url_for("../../etc/passwd").is_none());
        assert!(url_for("не-существует").is_none());
    }
}
```

- [ ] **Step 3: Запустить тесты и убедиться, что они падают**

```bash
cd src-tauri && cargo test model
```

Ожидается: ошибка компиляции — `cannot find value CATALOG`.

- [ ] **Step 4: Реализовать каталог и загрузку**

Дописать **в начало** `src-tauri/src/model.rs`:

```rust
use anyhow::{anyhow, Context};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub size_mb: u32,
}

/// Мультиязычные модели: английские (.en) не понимают русский.
pub const CATALOG: &[ModelInfo] = &[
    ModelInfo { id: "base", label: "Base — быстрая, слабее на русском", size_mb: 148 },
    ModelInfo { id: "small", label: "Small — рекомендуется", size_mb: 488 },
    ModelInfo { id: "large-v3-turbo", label: "Large v3 Turbo — лучшее качество", size_mb: 1620 },
];

pub fn file_name(id: &str) -> String {
    format!("ggml-{id}.bin")
}

/// Возвращает URL только для моделей из каталога — произвольный id
/// в URL не подставляется.
pub fn url_for(id: &str) -> Option<String> {
    CATALOG
        .iter()
        .find(|m| m.id == id)
        .map(|m| format!("{BASE_URL}/{}", file_name(m.id)))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: u64,
}

/// Качает модель в `dir/models/`, отдавая прогресс событием `model:progress`.
/// Пишет во временный `.part` и переименовывает только после успеха —
/// прерванная загрузка не оставит битый файл, который выглядит как рабочий.
pub async fn download(app: &AppHandle, dir: &Path, id: &str) -> anyhow::Result<PathBuf> {
    let url = url_for(id).ok_or_else(|| anyhow!("неизвестная модель: {id}"))?;
    let models_dir = dir.join("models");
    tokio::fs::create_dir_all(&models_dir).await?;

    let final_path = models_dir.join(file_name(id));
    let part_path = models_dir.join(format!("{}.part", file_name(id)));

    let response = reqwest::get(&url)
        .await
        .context("не удалось связаться с huggingface.co")?
        .error_for_status()
        .context("сервер вернул ошибку при скачивании модели")?;

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let mut file = tokio::fs::File::create(&part_path).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("обрыв соединения при скачивании")?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        // Событие не чаще, чем раз на мегабайт — иначе UI захлебнётся.
        if downloaded - last_emitted > 1_000_000 {
            last_emitted = downloaded;
            let _ = app.emit_to("settings", "model:progress", Progress { downloaded, total });
        }
    }
    file.flush().await?;
    drop(file);

    tokio::fs::rename(&part_path, &final_path).await?;
    let _ = app.emit_to(
        "settings",
        "model:progress",
        Progress { downloaded, total: downloaded },
    );
    Ok(final_path)
}
```

Добавить в `Cargo.toml`: `tokio = { version = "1", features = ["fs", "io-util"] }`.

- [ ] **Step 5: Запустить тесты — должны пройти**

```bash
cd src-tauri && cargo test model
```

Ожидается: `test result: ok. 4 passed`.

- [ ] **Step 6: Добавить команды**

Дописать в `src-tauri/src/commands.rs`:

```rust
use crate::model::{self, ModelInfo};

#[tauri::command]
pub fn list_models() -> Vec<ModelInfo> {
    model::CATALOG.to_vec()
}

#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    id: String,
) -> Result<String, String> {
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
```

`ModelInfo` должен быть `Clone` — он уже помечен `#[derive(Clone)]`.

Зарегистрировать `commands::list_models` и `commands::download_model` в `generate_handler!`, добавить `mod model;` в `main.rs`.

- [ ] **Step 7: Добавить UI загрузки в настройки**

Дописать в `src/api.ts`:

```ts
export type ModelInfo = { id: string; label: string; sizeMb: number }
export type Progress = { downloaded: number; total: number }

export const listModels = () => invoke<ModelInfo[]>('list_models')
export const downloadModel = (id: string) => invoke<string>('download_model', { id })
```

В `src/Settings.tsx` добавить импорты и состояние:

```tsx
import { listen } from '@tauri-apps/api/event'
import { listModels, downloadModel, type ModelInfo, type Progress } from './api'
```

Порядок в компоненте важен: состояние и `useEffect` идут **до** строки
`if (!s) return …` (иначе нарушим правила хуков), а `onDownload` — **после**
объявления `patch`, потому что использует его.

Состояние и эффект — сразу под существующим `useEffect`, до guard-строки:

```tsx
const [models, setModels] = useState<ModelInfo[]>([])
const [choice, setChoice] = useState('small')
const [progress, setProgress] = useState<Progress | null>(null)
const [busy, setBusy] = useState(false)
const [downloadError, setDownloadError] = useState('')

useEffect(() => {
  listModels().then(setModels)
  const un = listen<Progress>('model:progress', (e) => setProgress(e.payload))
  return () => {
    un.then((f) => f())
  }
}, [])
```

Обработчик — после объявления `patch`:

```tsx
const onDownload = async () => {
  setBusy(true)
  setDownloadError('')
  setProgress(null)
  try {
    const path = await downloadModel(choice)
    patch({ modelPath: path })
  } catch (e) {
    setDownloadError(String(e))
  } finally {
    setBusy(false)
  }
}
```

И блок разметки сразу после поля с путём к модели:

```tsx
<div className="download">
  <select value={choice} onChange={(e) => setChoice(e.target.value)} disabled={busy}>
    {models.map((m) => (
      <option key={m.id} value={m.id}>
        {m.label} · {m.sizeMb} МБ
      </option>
    ))}
  </select>
  <button onClick={onDownload} disabled={busy}>
    {busy ? 'Скачиваю…' : 'Скачать'}
  </button>
</div>
{progress && progress.total > 0 && (
  <progress value={progress.downloaded} max={progress.total} />
)}
{downloadError && <span className="err">{downloadError}</span>}
```

Дописать в `src/styles.css`:

```css
.download { display: flex; gap: 8px; align-items: center; }
.download select { flex: 1; }
.download button {
  background: #2c2c2e;
  border: none;
  border-radius: 6px;
  color: #f2f2f7;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}
.settings progress { width: 100%; height: 6px; }
.err { color: #ff453a; font-size: 12px; }
```

- [ ] **Step 8: Проверить вручную**

```bash
npm run tauri dev
```

Открыть настройки, выбрать «Base» (самая маленькая — быстрее проверять), нажать «Скачать». Прогресс-бар двигается, по завершении поле пути заполняется автоматически. Проверить файл:

```bash
ls -lh ~/Library/Application\ Support/net.slaive.app/models/
```

Ожидается: `ggml-base.bin` примерно 148 МБ, файлов `.part` не осталось.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: каталог и загрузка моделей whisper с прогрессом"
```

---

## Task 6: Транскрипция через whisper.cpp

**Files:**
- Create: `src-tauri/src/whisper.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/state.rs`, `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `audio::WHISPER_SAMPLE_RATE` из Task 4
- Produces:
  - `whisper::Transcriber::load(model_path: &Path) -> anyhow::Result<Transcriber>`
  - `whisper::Transcriber::transcribe(&self, pcm: &[f32], language: &str) -> anyhow::Result<String>`
  - `whisper::join_segments(segments: &[String]) -> String`
  - `whisper::MIN_SAMPLES: usize` — минимум сэмплов, ниже которого запись отбрасывается
  - поле `AppState::transcriber: Mutex<Option<whisper::Transcriber>>`

- [ ] **Step 1: Добавить whisper-rs**

В `src-tauri/Cargo.toml`:

```toml
whisper-rs = { version = "0.14", features = ["metal"] }
```

- [ ] **Step 2: Написать падающие тесты чистой логики**

Создать `src-tauri/src/whisper.rs` с одними тестами:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_trims_and_single_spaces() {
        let segments = vec![
            " Привет, ".to_string(),
            "как  дела".to_string(),
            " ?".to_string(),
        ];
        assert_eq!(join_segments(&segments), "Привет, как  дела ?");
    }

    #[test]
    fn join_drops_empty_segments() {
        let segments = vec!["Раз".to_string(), "   ".to_string(), "два".to_string()];
        assert_eq!(join_segments(&segments), "Раз два");
    }

    #[test]
    fn join_of_nothing_is_empty() {
        assert_eq!(join_segments(&[]), "");
    }

    #[test]
    fn min_samples_is_half_a_second() {
        assert_eq!(MIN_SAMPLES, 8_000);
    }
}
```

- [ ] **Step 3: Запустить тесты и убедиться, что они падают**

```bash
cd src-tauri && cargo test whisper
```

Ожидается: ошибка компиляции — `cannot find function join_segments`. Первая сборка whisper-rs соберёт whisper.cpp через cmake, это займёт несколько минут.

- [ ] **Step 4: Реализовать Transcriber**

Дописать **в начало** `src-tauri/src/whisper.rs`:

```rust
use anyhow::{anyhow, Context};
use std::path::Path;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::audio::WHISPER_SAMPLE_RATE;

/// Полсекунды. Более короткие записи whisper превращает в галлюцинации
/// вроде «Спасибо за просмотр», поэтому отбрасываем их сразу.
pub const MIN_SAMPLES: usize = (WHISPER_SAMPLE_RATE / 2) as usize;

pub struct Transcriber {
    ctx: WhisperContext,
}

pub fn join_segments(segments: &[String]) -> String {
    segments
        .iter()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn thread_count() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .clamp(1, 8)
}

impl Transcriber {
    /// Загружает модель в память. Занимает 1–3 секунды, поэтому вызывается
    /// один раз и кэшируется в состоянии приложения.
    pub fn load(model_path: &Path) -> anyhow::Result<Self> {
        if !model_path.exists() {
            return Err(anyhow!(
                "модель не найдена: {}",
                model_path.to_string_lossy()
            ));
        }
        let ctx = WhisperContext::new_with_params(
            &model_path.to_string_lossy(),
            WhisperContextParameters::default(),
        )
        .context("не удалось загрузить модель whisper")?;
        Ok(Self { ctx })
    }

    /// `pcm` должен быть f32, 16 кГц, моно. `language` — "auto", "ru" или "en".
    pub fn transcribe(&self, pcm: &[f32], language: &str) -> anyhow::Result<String> {
        if pcm.len() < MIN_SAMPLES {
            return Err(anyhow!("слишком короткая запись — говори дольше"));
        }

        // `lang` объявлен до `params`, потому что FullParams заимствует эту строку.
        let lang = language.to_string();
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        if lang == "auto" {
            params.set_detect_language(true);
        } else {
            params.set_language(Some(lang.as_str()));
        }
        params.set_n_threads(thread_count());
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        let mut state = self.ctx.create_state().context("не удалось создать состояние whisper")?;
        state.full(params, pcm).context("не удалось расшифровать запись")?;

        let n = state.full_n_segments().context("не удалось получить сегменты")?;
        let mut segments = Vec::with_capacity(n as usize);
        for i in 0..n {
            segments.push(state.full_get_segment_text(i).unwrap_or_default());
        }
        Ok(join_segments(&segments))
    }
}
```

- [ ] **Step 5: Запустить тесты — должны пройти**

```bash
cd src-tauri && cargo test whisper
```

Ожидается: `test result: ok. 4 passed`.

- [ ] **Step 6: Добавить transcriber в состояние**

В `src-tauri/src/state.rs`:

```rust
use crate::whisper::Transcriber;
// …
pub transcriber: Mutex<Option<Transcriber>>,
```

И в `AppState::new`: `transcriber: Mutex::new(None),`.

Добавить `mod whisper;` в `main.rs`.

- [ ] **Step 7: Проверить загрузку модели вручную**

Добавить временный интеграционный тест в конец `src-tauri/src/whisper.rs` (внутри `mod tests`):

```rust
    /// Проверка на живой модели. Запуск:
    /// SLAIVE_MODEL=~/Library/Application\ Support/net.slaive.app/models/ggml-base.bin \
    ///   cargo test loads_real_model -- --ignored --nocapture
    #[test]
    #[ignore]
    fn loads_real_model() {
        let path = std::env::var("SLAIVE_MODEL").expect("задай SLAIVE_MODEL");
        let t = Transcriber::load(std::path::Path::new(&path)).unwrap();
        // Тишина: модель должна отработать без паники и вернуть строку.
        let silence = vec![0.0_f32; 16_000 * 2];
        let text = t.transcribe(&silence, "ru").unwrap();
        println!("на тишине получили: {text:?}");
    }
```

Запустить:

```bash
cd src-tauri && SLAIVE_MODEL="$HOME/Library/Application Support/net.slaive.app/models/ggml-base.bin" \
  cargo test loads_real_model -- --ignored --nocapture
```

Ожидается: тест проходит, модель грузится, whisper.cpp печатает в stderr информацию о Metal-бэкенде. Текст на тишине может быть пустым или мусорным — это нормально, проверяем только что пайплайн не падает.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: транскрипция через whisper.cpp с ускорением Metal"
```

---

## Task 7: Сборка пайплайна — от хоткея до текста в панели

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/Overlay.tsx`, `src/api.ts`

**Interfaces:**
- Consumes: `audio::Recorder` (Task 4), `whisper::Transcriber` (Task 6), `hotkey_pressed`/`hotkey_released` (Task 3)
- Produces:
  - команды `start_recording(app) -> Result<(), String>` и `stop_recording(app) -> Result<(), String>` — для клика по микрофону
  - событие `transcript` с payload `String` в окно `overlay`
  - `commands::begin_recording(app: &AppHandle)` и `commands::end_recording(app: &AppHandle)` — общая логика для хоткея и кнопки

- [ ] **Step 1: Реализовать старт и стоп записи**

Дописать в `src-tauri/src/commands.rs`:

```rust
use crate::audio::Recorder;
use crate::whisper::Transcriber;

pub fn begin_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let mut slot = state.recorder.lock().unwrap();
    if slot.is_some() {
        return; // уже пишем — повторное нажатие игнорируем
    }
    match Recorder::start() {
        Ok(rec) => {
            *slot = Some(rec);
            let _ = app.emit_to("overlay", "rec:start", ());
        }
        Err(e) => emit_error(app, format!("Микрофон недоступен: {e}")),
    }
}

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
```

- [ ] **Step 2: Подключить к хоткею**

Заменить тела `hotkey_pressed` и `hotkey_released` в `commands.rs`:

```rust
pub fn hotkey_pressed(app: &AppHandle) {
    show_overlay(app);
    begin_recording(app);
}

pub fn hotkey_released(app: &AppHandle) {
    end_recording(app);
}
```

Зарегистрировать `commands::start_recording` и `commands::stop_recording` в `generate_handler!`.

- [ ] **Step 3: Сбрасывать кэш модели при смене настроек**

В `save_settings`, после записи новых настроек в состояние, добавить:

```rust
// Путь к модели или язык могли поменяться — перезагрузим модель при следующей записи.
*state.transcriber.lock().unwrap() = None;
```

- [ ] **Step 4: Оживить кнопку микрофона в панели**

Дописать в `src/api.ts`:

```ts
export const startRecording = () => invoke<void>('start_recording')
export const stopRecording = () => invoke<void>('stop_recording')
```

В `src/Overlay.tsx` импортировать их и повесить обработчик на микрофон:

```tsx
const toggleMic = () => {
  if (phase === 'recording') stopRecording()
  else startRecording()
}
```

```tsx
<div className={`mic ${phase === 'recording' ? 'live' : ''}`} onClick={toggleMic}>
  🎤
</div>
```

- [ ] **Step 5: Проверить вручную**

```bash
npm run tauri dev
```

Первый запуск запросит доступ к микрофону — разрешить (если запроса нет, см. Task 9, там добавляется `NSMicrophoneUsageDescription`).

- Зажать `Ctrl+Space`, сказать «раз два три проверка связи», отпустить.
- Панель: «Записываю…» → «Расшифровываю…» → распознанный текст.
- Повторить, но зажать и сразу отпустить: должно появиться «слишком короткая запись — говори дольше».
- Кликнуть по микрофону: запись стартует, клик ещё раз — останавливается и расшифровывается.
- Убрать путь к модели в настройках, сохранить, попробовать записать: «Модель не выбрана — открой настройки и скачай её».

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: полный путь от хоткея до распознанного текста в панели"
```

---

## Task 8: Вставка текста в исходное приложение

**Files:**
- Create: `src-tauri/src/macos.rs`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/main.rs`, `src/Overlay.tsx`, `src/api.ts`

**Interfaces:**
- Consumes: `AppState::prev_app_pid` (Task 2), `hotkey_pressed` (Task 7)
- Produces:
  - `macos::frontmost_pid() -> Option<i32>`
  - `macos::activate_pid(pid: i32) -> anyhow::Result<()>`
  - `macos::send_paste() -> anyhow::Result<()>`
  - `macos::open_accessibility_settings()`
  - команды `paste_text(app, text: String) -> Result<(), String>`, `copy_text(app, text: String) -> Result<(), String>`, `open_accessibility_settings()`

- [ ] **Step 1: Реализовать macos.rs**

Создать `src-tauri/src/macos.rs`:

```rust
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
```

- [ ] **Step 2: Написать тест на распознавание ошибки прав**

Дописать в конец `src-tauri/src/macos.rs`:

```rust
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
```

- [ ] **Step 3: Запустить тесты**

```bash
cd src-tauri && cargo test macos
```

Ожидается: `test result: ok. 2 passed`.

- [ ] **Step 4: Запоминать активное приложение при открытии панели**

В `commands.rs` в `hotkey_pressed`, **первой строкой** (до `show_overlay`, пока фокус ещё точно у чужого окна):

```rust
pub fn hotkey_pressed(app: &AppHandle) {
    // Запоминаем, куда потом возвращать текст.
    *app.state::<AppState>().prev_app_pid.lock().unwrap() = crate::macos::frontmost_pid();
    show_overlay(app);
    begin_recording(app);
}
```

- [ ] **Step 5: Реализовать команды вставки и копирования**

Дописать в `src-tauri/src/commands.rs`:

```rust
use crate::macos;
use tauri_plugin_clipboard_manager::ClipboardExt;

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

    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }

    // osascript блокирует поток на ~100 мс — уводим в фон, чтобы UI не подвисал.
    std::thread::spawn(move || {
        if let Some(pid) = pid {
            if let Err(e) = macos::activate_pid(pid) {
                // Приложение могли закрыть — вставляем в то, что активно сейчас.
                eprintln!("не удалось вернуть фокус: {e}");
            }
            // Даём macOS домигать переключением фокуса.
            std::thread::sleep(std::time::Duration::from_millis(120));
        }
        if let Err(e) = macos::send_paste() {
            let msg = e.to_string();
            if macos::is_permission_error(&msg) {
                show_overlay(&app);
                emit_error(
                    &app,
                    "Нет доступа к управлению приложениями. Разреши Slaive в «Универсальном доступе».",
                );
            } else {
                show_overlay(&app);
                emit_error(&app, format!("Не удалось вставить: {msg}"));
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn open_accessibility_settings() {
    macos::open_accessibility_settings();
}
```

Зарегистрировать все три в `generate_handler!` и добавить `mod macos;` в `main.rs`.

- [ ] **Step 6: Добавить кнопки в панель**

Дописать в `src/api.ts`:

```ts
export const pasteText = (text: string) => invoke<void>('paste_text', { text })
export const copyText = (text: string) => invoke<void>('copy_text', { text })
export const openAccessibilitySettings = () => invoke<void>('open_accessibility_settings')
```

В `src/Overlay.tsx` заменить блок `.actions`:

```tsx
<div className="actions">
  <button className="primary" disabled={!text} onClick={() => pasteText(text)}>
    Вставить
  </button>
  <button disabled={!text} onClick={() => copyText(text)}>
    Копировать
  </button>
  <button onClick={() => hideOverlay()}>Закрыть</button>
  {phase === 'error' && error.includes('Универсальном доступе') && (
    <button onClick={() => openAccessibilitySettings()}>Открыть настройки</button>
  )}
</div>
```

Не забыть импорты `pasteText`, `copyText`, `openAccessibilitySettings`.

- [ ] **Step 7: Проверить вручную**

```bash
npm run tauri dev
```

- Открыть Notes (или Slack), поставить курсор в текстовое поле.
- Зажать `Ctrl+Space`, сказать фразу, отпустить, дождаться текста.
- Нажать «Вставить»: панель скрывается, фокус возвращается в Notes, текст вставляется в позицию курсора.
- Первый раз macOS покажет запрос на управление System Events — разрешить. Если случайно отказали — панель покажет ошибку и кнопку «Открыть настройки».
- Повторить в другом приложении (браузер, терминал) — вставка должна работать везде.
- Проверить «Копировать»: панель остаётся, `Cmd+V` вручную вставляет тот же текст.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: вставка распознанного текста в исходное приложение"
```

---

## Task 9: Первый запуск и сборка приложения

**Files:**
- Create: `src-tauri/Info.plist`
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/src/commands.rs`, `src/Overlay.tsx`, `README.md` (создать)

**Interfaces:**
- Consumes: всё из Task 1–8
- Produces: собранный `Slaive.app`, запрос доступа к микрофону с внятным текстом, понятный первый запуск без модели

- [ ] **Step 1: Добавить Info.plist с описанием доступа к микрофону**

Создать `src-tauri/Info.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>NSMicrophoneUsageDescription</key>
    <string>Slaive записывает голос, чтобы расшифровать его в текст локально на этом компьютере.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>Slaive вставляет распознанный текст в приложение, из которого его вызвали.</string>
</dict>
</plist>
```

Больше ничего менять не нужно: Tauri автоматически находит `src-tauri/Info.plist`
и мержит его в бандл. Блок `bundle.macOS` в `tauri.conf.json` остаётся таким же,
как в Task 1:

```json
"macOS": { "minimumSystemVersion": "12.0" }
```

Важно: в режиме `npm run tauri dev` бинарь запускается не как бандл, и строки
из `Info.plist` могут не подхватиться — тогда macOS покажет системный запрос
доступа к микрофону без нашего текста. Это нормально, в собранном `.app`
текст будет.

- [ ] **Step 2: Открывать настройки при первом запуске без модели**

В `main.rs` внутри `.setup(...)`, после регистрации хоткея:

```rust
// Без модели приложение бесполезно — сразу показываем настройки.
if app.state::<state::AppState>().settings.lock().unwrap().model_path.is_none() {
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}
```

- [ ] **Step 3: Показать подсказку в пустой панели**

В `src/Overlay.tsx` заменить строку статуса для `idle`:

```tsx
const LABEL: Record<Phase, string> = {
  idle: 'Зажми хоткей и говори',
  recording: 'Записываю…',
  transcribing: 'Расшифровываю…',
  ready: 'Готово — «Вставить» вернёт текст в исходное окно',
  error: 'Ошибка',
}
```

- [ ] **Step 4: Написать README**

Создать `README.md`:

~~~~markdown
# Slaive

Голосовой ввод поверх любого приложения на macOS. Локально, без облака.

Зажми `Ctrl+Space`, говори, отпусти — текст появится в панели.
Кнопка «Вставить» вернёт его в то приложение, из которого ты вызвал Slaive.

## Требования

- macOS 12+
- Rust, cmake (`brew install cmake`), Node.js 20+

## Запуск

```bash
npm install
npm run tauri dev
```

При первом запуске откроются настройки: выбери модель и нажми «Скачать».
Для русского языка бери `small` или `large-v3-turbo` — модели с суффиксом `.en`
русский не понимают.

## Разрешения macOS

Приложению нужны два доступа:

- **Микрофон** — запрашивается автоматически при первой записи.
- **Универсальный доступ** — чтобы вставлять текст в чужие окна.
  Системные настройки → Конфиденциальность и безопасность → Универсальный доступ.

## Конфликт хоткея

`Ctrl+Space` в macOS по умолчанию переключает раскладку. Либо отключи это в
«Клавиатура → Сочетания клавиш → Источники ввода», либо задай другую комбинацию
в настройках Slaive.

## Сборка

```bash
npm run tauri build
```

Готовое приложение — в `src-tauri/target/release/bundle/macos/Slaive.app`.
Сборка не подписана: при первом открытии macOS попросит подтвердить запуск через
контекстное меню → «Открыть».
~~~~

- [ ] **Step 5: Собрать приложение**

```bash
npm run tauri build
```

Ожидается: сборка проходит, появляется `src-tauri/target/release/bundle/macos/Slaive.app`.

- [ ] **Step 6: Проверить собранное приложение**

```bash
open src-tauri/target/release/bundle/macos/Slaive.app
```

Пройти сценарий целиком на чистой сборке:

1. Иконка появилась в статус-баре, в доке её нет.
2. Настройки открылись сами (модели ещё нет в свежем профиле — либо временно переименуй `~/Library/Application Support/net.slaive.app/settings.json`).
3. Скачать модель, закрыть настройки.
4. Открыть любое приложение с текстовым полем.
5. Зажать `Ctrl+Space`, сказать «проверка один два три», отпустить.
6. Дождаться текста, нажать «Вставить» — текст в поле.
7. «Выход» из трея закрывает приложение полностью.

- [ ] **Step 7: Прогнать все тесты**

```bash
cd src-tauri && cargo test
```

Ожидается: 21 тест проходит (settings 4, audio 7, model 4, whisper 4, macos 2),
`loads_real_model` пропущен как `ignored`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: онбординг первого запуска, Info.plist и сборка приложения"
```

---

## Известные ограничения v1

Фиксируем сознательно, чтобы не выглядело как недосмотр:

- **Приложение не подписано и не нотаризовано.** Распространять пока нельзя, только запускать у себя.
- **Только Apple Silicon проверен.** Intel-сборка должна работать (whisper.cpp упадёт на CPU без Metal), но не тестируется.
- **Задержка вставки ~250 мс** — цена AppleScript вместо CGEvent. Апгрейд описан комментарием в `macos.rs`.
- **Ресемплинг box-фильтром**, а не polyphase FIR. Для речи достаточно; апгрейд — `rubato`.
- **Нет стриминга** — текст появляется только после окончания записи. Для длинных диктовок это заметно.
- **Транскрипция не отменяется.** Начатую расшифровку нельзя прервать, только дождаться.
- **`Ctrl+Space` конфликтует со сменой раскладки в macOS** — решается вручную пользователем.
- **Работа с выделенным текстом и LLM (главная фича Kerlig) не начата** — это v2.

## Что дальше (v2, отдельный план)

1. Захват выделенного текста из активного приложения (Accessibility API или `Cmd+C` + чтение буфера) как контекст.
2. Действия над текстом через LLM: «исправить», «сократить», «перевести», «ответить» + пользовательские пресеты.
3. Замена выделенного текста результатом (`Cmd+V` поверх выделения) в дополнение к вставке.
4. Настоящая NSPanel (`tauri-nspanel`) вместо обычного окна — панель, которая физически не может украсть фокус.
