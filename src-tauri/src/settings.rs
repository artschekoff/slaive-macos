use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "settings.json";

/// Настройки одного ИИ-провайдера. Ключ сюда НЕ входит — он в Keychain (см.
/// `ai.rs`/`commands.rs`), а этот файл лежит в Application Support открытым
/// текстом и читается любым процессом от имени пользователя.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub model: String,
    /// Пусто/`None` = адрес по умолчанию для этого провайдера.
    pub base_url: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            base_url: None,
        }
    }
}

/// Настройки ИИ-слоя. У каждого провайдера своя запись в `providers`,
/// ключ — id провайдера (см. `ai::PROVIDERS`) — переключение между ними не
/// затирает соседние настройки, каждая пара модель+адрес живёт отдельно.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// id выбранного провайдера.
    pub provider: String,
    /// Настройки по каждому провайдеру, ключ — id.
    pub providers: BTreeMap<String, ProviderConfig>,
}

impl Default for AiSettings {
    fn default() -> Self {
        let mut providers = BTreeMap::new();
        // OpenAI — единственный реализованный провайдер, поэтому он же
        // выбран по умолчанию и получает готовую модель-подсказку; ключ
        // пользователь всё равно должен добавить сам — без него запрос не
        // уйдёт (см. `ai::require_api_key`).
        providers.insert(
            "openai".to_string(),
            ProviderConfig {
                model: "gpt-4o-mini".to_string(),
                base_url: None,
            },
        );
        Self {
            provider: "openai".to_string(),
            providers,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Строка хоткея в формате Tauri, например "Ctrl+Space".
    pub hotkey: String,
    /// Абсолютный путь к файлу модели ggml-*.bin.
    pub model_path: Option<PathBuf>,
    /// "auto" | "ru" | "en"
    pub language: String,
    /// Абсолютный путь к файлу модели VAD (Silero), если пользователь её
    /// скачал. `None` — VAD выключен, расшифровка идёт по всей записи целиком,
    /// как и раньше; это не ошибка и не деградация, а сознательный дефолт.
    pub vad_model_path: Option<PathBuf>,
    /// Хоткей вставки текста в панели — в том же формате, что `hotkey`, но
    /// это НЕ глобальная комбинация: она перехватывается обычным keydown
    /// внутри окна overlay (см. Overlay.tsx), а не через
    /// tauri-plugin-global-shortcut, поэтому здесь не проходит через
    /// `validate_hotkey`/`register_hotkey` и хранится как обычная строка.
    pub paste_shortcut: String,
    /// Хоткей копирования текста в панели — та же оговорка, что у
    /// `paste_shortcut`: окно-локальный, не глобальный.
    pub copy_shortcut: String,
    /// Хоткеи действий главного окна (Translate / Ask AI / Fix / Shorten) —
    /// та же оговорка, что у `paste_shortcut`/`copy_shortcut`: окно-локальные,
    /// перехватываются обычным keydown внутри окна `main` (см. MainWindow.tsx),
    /// а не через tauri-plugin-global-shortcut. Хранятся четырьмя отдельными
    /// полями, а не картой «id действия → комбинация»: состав действий задан
    /// в коде (src/action-tree.ts), а не пользователем, и плоские поля дают
    /// тот же разбор в serde и ту же проверку типом на фронтенде, что и
    /// остальные настройки.
    /// ponytail: если действия станут пользовательскими, заменить на карту.
    pub translate_shortcut: String,
    pub ask_ai_shortcut: String,
    pub fix_shortcut: String,
    pub shorten_shortcut: String,
    /// Настройки ИИ-провайдеров — модель и адрес на каждого, БЕЗ ключей
    /// (они в Keychain). См. `AiSettings`.
    pub ai: AiSettings,
    /// Множитель усиления микрофона, применяемый к PCM ПЕРЕД VAD и whisper
    /// (см. `audio::apply_gain`). Тихий микрофон бьёт дважды: whisper на
    /// тихом входе распознаёт хуже, а VAD с порогом вероятности может не
    /// увидеть речи вовсе и вырезать всю запись. 1.0 — как было до появления
    /// настройки. На дорожку уровня НЕ влияет: та рисует сырой сигнал.
    pub mic_gain: f32,
    /// Порог обнаружения речи для VAD (Silero) — вероятность, выше которой
    /// кусок считается речью. Это НЕ чувствительность микрофона: та —
    /// `mic_gain` выше, и путать их вредно. 0.5 — дефолт whisper.cpp.
    pub vad_threshold: f32,
    /// Имя выбранного устройства записи, как его отдаёт `cpal`. `None` —
    /// «System default»: следовать за системным умолчанием, а не прикрепиться
    /// к тому устройству, которое было умолчанием в момент выбора. Это разные
    /// вещи, и путать их нельзя (см. бриф выбора устройства).
    ///
    /// Имя — единственный идентификатор, который даёт `cpal`.
    /// ponytail: имена не стабильны между переподключениями у части устройств
    /// (iPhone, USB-хабы); чинится переходом на CoreAudio device UID, если
    /// начнёт мешать.
    pub input_device: Option<String>,
    /// Словарь терминов: слова, которые пользователь диктует по-английски
    /// посреди русской речи. Уходит в `initial_prompt` whisper (см.
    /// `whisper::initial_prompt`) — пустой словарь означает, что параметр не
    /// передаётся вовсе, а не что передаётся пустая строка.
    ///
    /// По умолчанию заполнен списком ходовых терминов разработки и облаков
    /// (`DEFAULT_DICTIONARY`). Это дефолт serde, то есть подставляется только
    /// когда поля в файле нет: очищенный пользователем словарь остаётся
    /// очищенным и сидом не перезаписывается.
    pub dictionary: String,
}

/// Сид словаря: английские термины, которые русскоговорящий разработчик
/// произносит как есть посреди русской фразы, а whisper без подсказки
/// превращает в кириллицу.
///
/// Длина выбрана не на глаз. whisper.cpp берёт из подсказки не больше
/// `n_text_ctx/2` токенов (whisper.cpp, строка 5617: `std::min(n_max_text_ctx,
/// whisper_n_text_ctx(ctx)/2)`), а `n_text_ctx` у всех моделей 448 — то есть
/// потолок 224 токена. Причём лишнее отбрасывается с НАЧАЛА списка и молча:
/// длинный словарь не расширит охват, а тихо потеряет первую половину.
/// Поэтому здесь плотный список коротких терминов, а не связный текст.
pub const DEFAULT_DICTIONARY: &str = "commit, merge, rebase, pull request, branch, revert, deploy, rollback, backend, frontend, endpoint, payload, middleware, migration, schema, query, cache, webhook, latency, throughput, API, REST, GraphQL, gRPC, JWT, OAuth, CORS, component, props, hook, render, bundle, hydration, TypeScript, React, Kubernetes, Docker, container, pod, namespace, ingress, Helm, Terraform, pipeline, artifact, rollout, canary, load balancer, autoscaling, Prometheus, Grafana, Google Cloud, BigQuery, Cloud Run, Pub/Sub, Firestore, GKE, IAM, Cloud Storage, Secret Manager, Cloud Build, AWS, EC2, S3, Lambda, DynamoDB, RDS, ECS, EKS, Fargate, CloudWatch";

impl Default for Settings {
    fn default() -> Self {
        Self {
            // Cmd+T — сознательный выбор пользователя, несмотря на коллизию
            // с «New Tab» в большинстве приложений; предупреждение об этом
            // теперь в подсказке настроек, а не здесь.
            hotkey: "Super+KeyT".to_string(),
            model_path: None,
            language: "auto".to_string(),
            vad_model_path: None,
            // Enter — уже существовавшее поведение до того, как оно стало
            // настраиваемым; голая клавиша допустима именно потому, что это
            // окно-локальный хоткей, а не глобальный (см. комментарий у поля).
            paste_shortcut: "Enter".to_string(),
            // Cmd+C — стандартное системное сочетание для копирования.
            copy_shortcut: "Super+KeyC".to_string(),
            // Действия главного окна — все с Cmd: поле текста там это
            // CodeMirror с Vim, и голая клавиша (как и Ctrl-комбинация) была
            // бы отобрана у редактирования. В грамматике Vim модификатора
            // Cmd не бывает вовсе, поэтому Cmd+буква не пересекается ни с
            // normal-, ни с insert-режимом. Буквы — мнемоника действия, кроме
            // Translate: Cmd+T занят глобальным хоткеем записи выше, поэтому
            // взята L («language»).
            translate_shortcut: "Super+KeyL".to_string(),
            // Cmd+K — сложившееся «спросить ИИ» в редакторах.
            ask_ai_shortcut: "Super+KeyK".to_string(),
            // Cmd+F — мнемоника Fix; поиска по тексту в приложении нет,
            // сочетание свободно.
            fix_shortcut: "Super+KeyF".to_string(),
            // Cmd+S — мнемоника Shorten; сохранять в главном окне нечего.
            shorten_shortcut: "Super+KeyS".to_string(),
            ai: AiSettings::default(),
            // 1.0 — «как было до появления ползунка»: настройка не должна
            // менять звук у тех, кто её не трогал.
            mic_gain: crate::audio::DEFAULT_GAIN,
            // Дефолт whisper.cpp; ниже — VAD чаще считает звук речью и меньше
            // режет, выше — строже.
            vad_threshold: DEFAULT_VAD_THRESHOLD,
            // «System default» — следовать за системой. Это же и поведение,
            // которое было до появления выбора устройства.
            input_device: None,
            dictionary: DEFAULT_DICTIONARY.to_string(),
        }
    }
}

/// Границы порога VAD. Крайности бесполезны: 0.0 — «всё речь» (VAD ничего не
/// делает), 1.0 — «ничего не речь» (вырезается вся запись).
pub const MIN_VAD_THRESHOLD: f32 = 0.1;
pub const MAX_VAD_THRESHOLD: f32 = 0.9;
/// Дефолт whisper.cpp — значение, с которым VAD работал до появления ползунка.
pub const DEFAULT_VAD_THRESHOLD: f32 = 0.5;

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
    std::fs::create_dir_all(dir).context("Couldn't create the settings folder.")?;
    let raw = serde_json::to_string_pretty(s)?;
    std::fs::write(dir.join(FILE_NAME), raw).context("Couldn't write settings to disk.")?;
    Ok(())
}

#[cfg(test)]
mod tests {

    /// Сид словаря обязан помещаться в бюджет подсказки whisper. Потолок —
    /// 224 токена (`n_text_ctx/2`, n_text_ctx = 448 у всех моделей), и лишнее
    /// отбрасывается с начала списка МОЛЧА: без этого теста расширение
    /// словаря выглядело бы работающим, а на деле выбивало бы из подсказки
    /// первые термины.
    ///
    /// Токенизатор здесь не доступен, поэтому считаем консервативно по
    /// символам: английский текст у BPE whisper — порядка 4 символов на
    /// токен, берём 3.5 с запасом в худшую сторону.
    #[test]
    fn default_dictionary_fits_whisper_prompt_budget() {
        const MAX_PROMPT_TOKENS: usize = 224;
        let approx_tokens = (DEFAULT_DICTIONARY.len() as f32 / 3.5).ceil() as usize;
        assert!(
            approx_tokens <= MAX_PROMPT_TOKENS,
            "сид словаря ~{approx_tokens} токенов при потолке {MAX_PROMPT_TOKENS}; \
             whisper отбросит начало списка молча"
        );
    }

    /// Очищенный пользователем словарь не должен воскресать из сида: дефолт
    /// serde подставляется только при ОТСУТСТВИИ поля, а не при пустом.
    #[test]
    fn empty_dictionary_survives_roundtrip() {
        let mut s = Settings::default();
        s.dictionary = String::new();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.dictionary, "");
    }
    use super::*;

    // tmp() из брифа использовал только process::id(), который одинаков для
    // всех тестов в этом бинарнике — при параллельных потоках cargo тесты
    // гонялись за одну и ту же папку и флакали. Добавлен id потока, чтобы
    // каждый параллельно выполняющийся тест был изолирован; проверки не менялись.
    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_when_file_missing() {
        let dir = tmp();
        let s = load(&dir);
        assert_eq!(s.hotkey, "Super+KeyT");
        assert_eq!(s.model_path, None);
        assert_eq!(s.language, "auto");
        assert_eq!(s.vad_model_path, None);
        assert_eq!(s.paste_shortcut, "Enter");
        assert_eq!(s.copy_shortcut, "Super+KeyC");
        assert_eq!(s.translate_shortcut, "Super+KeyL");
        assert_eq!(s.ask_ai_shortcut, "Super+KeyK");
        assert_eq!(s.fix_shortcut, "Super+KeyF");
        assert_eq!(s.shorten_shortcut, "Super+KeyS");
        assert_eq!(s.mic_gain, 1.0);
        assert_eq!(s.vad_threshold, 0.5);
        assert_eq!(s.input_device, None);
        assert_eq!(s.dictionary, DEFAULT_DICTIONARY);
    }

    #[test]
    fn round_trip() {
        let dir = tmp();
        let mut providers = BTreeMap::new();
        providers.insert(
            "openai".to_string(),
            ProviderConfig {
                model: "gpt-4o-mini".to_string(),
                base_url: None,
            },
        );
        let s = Settings {
            hotkey: "Alt+Space".into(),
            model_path: Some(std::path::PathBuf::from("/tmp/ggml-small.bin")),
            language: "ru".into(),
            vad_model_path: Some(std::path::PathBuf::from("/tmp/ggml-silero-v5.1.2.bin")),
            paste_shortcut: "Shift+Enter".into(),
            copy_shortcut: "Ctrl+Alt+KeyC".into(),
            translate_shortcut: "Ctrl+KeyL".into(),
            ask_ai_shortcut: "Ctrl+KeyK".into(),
            fix_shortcut: "Ctrl+KeyF".into(),
            shorten_shortcut: "Ctrl+KeyS".into(),
            ai: AiSettings {
                provider: "openai".into(),
                providers,
            },
            mic_gain: 3.5,
            vad_threshold: 0.35,
            input_device: Some("Пётр's iPhone Microphone".into()),
            dictionary: "React\nTypeScript".into(),
        };
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
    }

    /// Настройки, сохранённые до появления выбора устройства и словаря, не
    /// должны переставать загружаться — та же гарантия, что уже отработана
    /// для VAD, Paste/Copy и усиления выше. Перекладка интерфейса не имеет
    /// права менять формат хранения.
    #[test]
    fn settings_without_device_and_dictionary_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru","micGain":2.0,"vadThreshold":0.4}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.input_device, None);
        // Отсутствующее в файле поле берёт сид, а не пустую строку.
        assert_eq!(s.dictionary, DEFAULT_DICTIONARY);
        // Соседние поля по-прежнему читаются как раньше.
        assert_eq!(s.hotkey, "Alt+Space");
        assert_eq!(s.language, "ru");
        assert_eq!(s.mic_gain, 2.0);
        assert_eq!(s.vad_threshold, 0.4);
        assert_eq!(s.model_path, Some(std::path::PathBuf::from("/tmp/ggml-small.bin")));
    }

    /// Полный набор полей, записанный прежней версией приложения, должен
    /// пережить круг «загрузить → сохранить → загрузить» без потерь: перекладка
    /// интерфейса не должна тихо выронить ни одного значения.
    #[test]
    fn every_stored_field_survives_a_load_save_load_cycle() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{
              "hotkey":"Alt+Space",
              "modelPath":"/tmp/ggml-small.bin",
              "language":"ru",
              "vadModelPath":"/tmp/ggml-silero-v5.1.2.bin",
              "pasteShortcut":"Shift+Enter",
              "copyShortcut":"Ctrl+Alt+KeyC",
              "translateShortcut":"Ctrl+KeyL",
              "askAiShortcut":"Ctrl+KeyK",
              "fixShortcut":"Ctrl+KeyF",
              "shortenShortcut":"Ctrl+KeyS",
              "ai":{"provider":"openai","providers":{"openai":{"model":"gpt-4o","baseUrl":"https://example.test/v1"}}},
              "micGain":3.5,
              "vadThreshold":0.35
            }"#,
        )
        .unwrap();
        let first = load(&dir);
        save(&dir, &first).unwrap();
        let second = load(&dir);
        assert_eq!(first, second);
        assert_eq!(second.hotkey, "Alt+Space");
        assert_eq!(second.paste_shortcut, "Shift+Enter");
        assert_eq!(second.copy_shortcut, "Ctrl+Alt+KeyC");
        assert_eq!(second.translate_shortcut, "Ctrl+KeyL");
        assert_eq!(second.ask_ai_shortcut, "Ctrl+KeyK");
        assert_eq!(second.fix_shortcut, "Ctrl+KeyF");
        assert_eq!(second.shorten_shortcut, "Ctrl+KeyS");
        assert_eq!(second.language, "ru");
        assert_eq!(second.mic_gain, 3.5);
        assert_eq!(second.vad_threshold, 0.35);
        assert_eq!(
            second.vad_model_path,
            Some(std::path::PathBuf::from("/tmp/ggml-silero-v5.1.2.bin"))
        );
        assert_eq!(second.ai.providers["openai"].model, "gpt-4o");
        assert_eq!(
            second.ai.providers["openai"].base_url.as_deref(),
            Some("https://example.test/v1")
        );
    }

    /// Настройки, сохранённые до появления усиления и порога VAD, не должны
    /// переставать загружаться — отсутствующие поля тихо становятся
    /// дефолтами, тем же путём, что уже отработан для VAD и Paste/Copy.
    #[test]
    fn settings_without_gain_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.mic_gain, 1.0);
        assert_eq!(s.vad_threshold, 0.5);
    }

    /// Настройки, сохранённые до появления VAD, не должны переставать
    /// загружаться — отсутствующее поле должно тихо стать `None`.
    #[test]
    fn settings_without_vad_field_still_load() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.vad_model_path, None);
        assert_eq!(s.language, "ru");
    }

    /// Настройки, сохранённые до появления настраиваемых Paste/Copy, не
    /// должны переставать загружаться — отсутствующие поля тихо становятся
    /// дефолтами, тем же путём, что уже отработан для VAD выше.
    #[test]
    fn settings_without_shortcut_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.paste_shortcut, "Enter");
        assert_eq!(s.copy_shortcut, "Super+KeyC");
    }

    /// То же самое для хоткеев действий главного окна: файл, записанный до их
    /// появления, обязан загрузиться, а не обнулить настройки целиком.
    #[test]
    fn settings_without_action_shortcut_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","pasteShortcut":"Shift+Enter"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.translate_shortcut, "Super+KeyL");
        assert_eq!(s.ask_ai_shortcut, "Super+KeyK");
        assert_eq!(s.fix_shortcut, "Super+KeyF");
        assert_eq!(s.shorten_shortcut, "Super+KeyS");
        // Соседнее поле читается как раньше.
        assert_eq!(s.paste_shortcut, "Shift+Enter");
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
        assert_eq!(s.hotkey, "Super+KeyT");
    }

    /// Настройки, сохранённые до появления ИИ-слоя, не должны переставать
    /// загружаться — отсутствующее поле `ai` тихо становится дефолтом,
    /// тем же путём, что уже отработан для VAD и Paste/Copy выше.
    #[test]
    fn settings_without_ai_field_still_load() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.ai, AiSettings::default());
    }

    /// Дефолт: OpenAI выбран и уже сконфигурирован (модель-подсказка,
    /// адрес по умолчанию) — единственный реализованный провайдер должен
    /// работать после первой же установки ключа, без похода в поле модели.
    #[test]
    fn ai_defaults_select_openai_with_a_model() {
        let ai = AiSettings::default();
        assert_eq!(ai.provider, "openai");
        let openai = ai.providers.get("openai").expect("openai должен быть предзаполнен");
        assert_eq!(openai.model, "gpt-4o-mini");
        assert_eq!(openai.base_url, None);
    }

    /// Основная гарантия брифа: переключение провайдера не должно терять
    /// настройки предыдущего — каждый провайдер хранится под своим ключом
    /// в `providers`, а не в общих полях, которые провайдеры делили бы.
    #[test]
    fn switching_provider_keeps_previous_providers_config_intact() {
        let dir = tmp();
        let mut providers = BTreeMap::new();
        providers.insert(
            "openai".to_string(),
            ProviderConfig {
                model: "gpt-4o-mini".to_string(),
                base_url: None,
            },
        );
        providers.insert(
            "openrouter".to_string(),
            ProviderConfig {
                model: "openai/gpt-4o-mini".to_string(),
                base_url: Some("https://openrouter.ai/api".to_string()),
            },
        );
        let mut s = Settings {
            ai: AiSettings {
                provider: "openai".into(),
                providers,
            },
            ..Settings::default()
        };
        save(&dir, &s).unwrap();

        // Переключились на другого провайдера и сохранили снова — запись
        // openai в карте должна остаться нетронутой.
        s.ai.provider = "openrouter".into();
        save(&dir, &s).unwrap();

        let loaded = load(&dir);
        assert_eq!(loaded.ai.provider, "openrouter");
        assert_eq!(loaded.ai.providers.get("openai").unwrap().model, "gpt-4o-mini");
        assert_eq!(
            loaded.ai.providers.get("openrouter").unwrap().model,
            "openai/gpt-4o-mini"
        );
    }
}
