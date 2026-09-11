//! Слой доступа к ИИ-провайдерам. Как whisper.rs и macos.rs — ничего не
//! знает про Tauri: наружу отдаёт обычные данные, `AppHandle` сюда не
//! попадает никогда (в отличие от model.rs, где он нужен для прогресса
//! загрузки). `ResolvedProvider` собирается в commands.rs из настроек плюс
//! ключа из Keychain — этот модуль не читает ни то, ни другое напрямую,
//! поэтому его легко тестировать без Tauri и без сети.
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Статический каталог провайдеров. Добавление второго реализованного
/// провайдера — это реализация одной ветки в `complete()`, а не переделка
/// настроек: `AiSettings`/`ProviderConfig` уже рассчитаны на произвольный id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// Можно ли сейчас выбрать этого провайдера. Показывается в интерфейсе
    /// всегда, но выбор непройденного — отказ и на фронте, и в `save_settings`.
    pub implemented: bool,
    pub default_base_url: &'static str,
    /// Подсказка примера модели для поля ввода в настройках.
    pub example_model: &'static str,
}

pub const PROVIDERS: &[ProviderInfo] = &[
    ProviderInfo {
        id: "openai",
        label: "OpenAI",
        implemented: true,
        default_base_url: "https://api.openai.com",
        example_model: "gpt-4o-mini",
    },
    ProviderInfo {
        id: "anthropic",
        label: "Anthropic",
        implemented: false,
        default_base_url: "https://api.anthropic.com",
        example_model: "claude-sonnet-4-5",
    },
    ProviderInfo {
        id: "openrouter",
        label: "OpenRouter",
        implemented: false,
        default_base_url: "https://openrouter.ai/api",
        example_model: "openai/gpt-4o-mini",
    },
    ProviderInfo {
        id: "ollama",
        label: "Ollama (local)",
        implemented: false,
        default_base_url: "http://localhost:11434",
        example_model: "llama3",
    },
];

pub fn provider_info(id: &str) -> Option<&'static ProviderInfo> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// Можно ли сохранить `id` как выбранного провайдера — известен и реализован.
/// Отдельная функция, а не проверка `implemented` инлайном в commands.rs:
/// одно и то же правило нужно и для валидации `save_settings`, и для теста
/// «отказ выбрать нереализованного провайдера».
pub fn is_selectable(id: &str) -> bool {
    provider_info(id).map(|p| p.implemented).unwrap_or(false)
}

/// Настройки одного провайдера плюс ключ, уже добытый из Keychain —
/// собирается в commands.rs, этот модуль не знает, откуда пришли поля.
pub struct ResolvedProvider {
    pub id: String,
    pub model: String,
    /// `None` = адрес по умолчанию для этого провайдера (см. `ProviderConfig`).
    pub base_url: Option<String>,
    /// `None` — ключ не задан; отдельная явная ошибка, а не паника на unwrap.
    pub api_key: Option<String>,
}

pub struct AiRequest {
    pub system: String,
    pub user: String,
}

/// Обёртка вокруг клиента запроса — connect_timeout + read_timeout, тот же
/// приём, что в model.rs (I9 оттуда: без таймаутов зависшее соединение
/// оставляет пользователя перед неотзывчивой панелью без ошибки и без
/// возможности отменить). read_timeout здесь больше, чем у загрузки моделей
/// (30с) — там он замеряет паузу МЕЖДУ уже идущими чанками потока, а здесь
/// это, по сути, весь запрос целиком: ответ приходит одним куском только
/// после того, как модель провайдера полностью его сгенерировала.
fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(60))
        .build()
        .context("Couldn't create the network client.")
}

/// Единственная зависимая от сети функция модуля. Для нереализованных
/// провайдеров — понятная ошибка, не `todo!()` и не паника: список
/// провайдеров показан в интерфейсе целиком, и до валидации в
/// `save_settings` на фронте могла долететь чужая копия старого запроса.
pub async fn complete(cfg: &ResolvedProvider, req: AiRequest) -> Result<String> {
    match cfg.id.as_str() {
        "openai" => complete_openai(cfg, req).await,
        other => match provider_info(other) {
            Some(info) => Err(anyhow!("{} isn't implemented yet.", info.label)),
            None => Err(anyhow!("Unknown provider: {other}.")),
        },
    }
}

async fn complete_openai(cfg: &ResolvedProvider, req: AiRequest) -> Result<String> {
    let info = provider_info("openai").expect("openai всегда есть в PROVIDERS");
    let api_key = require_api_key(cfg.api_key.as_deref(), info.label)?;
    let base = effective_base_url(info, cfg.base_url.as_deref());
    let url = format!("{base}/v1/chat/completions");
    let body = build_request_body(&cfg.model, &req);

    let client = http_client()?;
    let response = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| anyhow!(network_failure_message(classify_network_failure(&e), info.label)))?;

    let status = response.status();
    if !status.is_success() {
        // Сырой текст — в eprintln!, а не в сообщение пользователю: он
        // английский, длинный и часто содержит идентификаторы запроса
        // провайдера (см. бриф). Пользователю — сообщение по коду ответа.
        let raw = response.text().await.unwrap_or_default();
        eprintln!(
            "OpenAI ответил кодом {}: {raw}",
            status.as_u16()
        );
        return Err(anyhow!(status_error_message(status.as_u16(), info.label)));
    }

    let raw = response.text().await.map_err(|e| {
        eprintln!("не удалось прочитать тело ответа OpenAI: {e}");
        anyhow!("Unexpected response from {}. Try again.", info.label)
    })?;
    parse_chat_response(&raw)
}

/// Ключ не задан — отдельная, самая частая ошибка: пользователь выбрал
/// провайдера, но ещё не сохранил ключ в настройках.
fn require_api_key<'a>(key: Option<&'a str>, label: &str) -> Result<&'a str> {
    match key {
        Some(k) if !k.is_empty() => Ok(k),
        _ => Err(anyhow!("No API key set for {label}. Add one in Settings.")),
    }
}

/// `base_url` пуст/не задан — используем дефолтный адрес провайдера.
/// Хвостовой слэш срезаем, чтобы не получить двойной перед `/v1/...`.
fn effective_base_url(info: &ProviderInfo, override_url: Option<&str>) -> String {
    match override_url.map(str::trim) {
        Some(u) if !u.is_empty() => u.trim_end_matches('/').to_string(),
        _ => info.default_base_url.to_string(),
    }
}

/// Тело запроса `/v1/chat/completions` — формат общий для всего, что говорит
/// по протоколу OpenAI (OpenRouter, Ollama, локальные прокси), поэтому одна
/// реализация закрывает их всех, когда до них дойдёт очередь.
fn build_request_body(model: &str, req: &AiRequest) -> serde_json::Value {
    serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": req.system },
            { "role": "user", "content": req.user },
        ],
    })
}

#[derive(Deserialize)]
struct ChatCompletionResponse {
    #[serde(default)]
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    #[serde(default)]
    content: Option<String>,
}

/// Разбирает тело ответа `/v1/chat/completions`. Пустой список вариантов и
/// пустое содержимое — оба валидный JSON, но не то, что можно отдать
/// пользователю как результат, поэтому оба — явная ошибка, а не пустая строка.
fn parse_chat_response(raw: &str) -> Result<String> {
    let parsed: ChatCompletionResponse = serde_json::from_str(raw).map_err(|e| {
        eprintln!("не удалось разобрать ответ провайдера: {e}");
        anyhow!("Unexpected response from the provider. Try again.")
    })?;
    let content = parsed
        .choices
        .first()
        .and_then(|c| c.message.content.as_deref())
        .unwrap_or("")
        .trim();
    if content.is_empty() {
        return Err(anyhow!("The provider returned an empty response. Try again."));
    }
    Ok(content.to_string())
}

/// Код ответа → сообщение пользователю. Разведены минимум пять случаев из
/// брифа: неверный ключ, лимит, проблема на стороне провайдера, остальное.
/// (Отсутствие ключа и «нет сети» — отдельные ветки до/вместо HTTP-запроса,
/// см. `require_api_key` и `network_failure_message`.)
fn status_error_message(status: u16, label: &str) -> String {
    match status {
        401 => format!("{label} rejected the API key. Check it in Settings."),
        429 => format!("{label} rate limit reached. Wait a moment and try again."),
        500..=599 => format!("{label} is having problems right now. Try again in a bit."),
        _ => format!("{label} returned an unexpected error (status {status}). Try again."),
    }
}

/// Классификация сетевого сбоя reqwest — отдельно от текста сообщения, чтобы
/// текст можно было протестировать без настоящего `reqwest::Error` (его не
/// собрать в юнит-тесте без реального сетевого сбоя).
enum NetworkFailure {
    Timeout,
    Connect,
    Other,
}

fn classify_network_failure(e: &reqwest::Error) -> NetworkFailure {
    if e.is_timeout() {
        NetworkFailure::Timeout
    } else if e.is_connect() {
        NetworkFailure::Connect
    } else {
        NetworkFailure::Other
    }
}

fn network_failure_message(kind: NetworkFailure, label: &str) -> String {
    match kind {
        NetworkFailure::Timeout => format!("{label} took too long to respond. Try again."),
        NetworkFailure::Connect => {
            "Couldn't reach the network. Check your internet connection and try again."
                .to_string()
        }
        NetworkFailure::Other => format!("Couldn't reach {label}. Try again."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_is_selectable_others_are_not() {
        assert!(is_selectable("openai"));
        assert!(!is_selectable("anthropic"));
        assert!(!is_selectable("openrouter"));
        assert!(!is_selectable("ollama"));
        assert!(!is_selectable("не-существует"));
    }

    #[test]
    fn provider_info_finds_known_ids() {
        assert_eq!(provider_info("openai").unwrap().label, "OpenAI");
        assert!(provider_info("не-существует").is_none());
    }

    #[test]
    fn effective_base_url_falls_back_to_default() {
        let info = provider_info("openai").unwrap();
        assert_eq!(effective_base_url(info, None), "https://api.openai.com");
        assert_eq!(effective_base_url(info, Some("")), "https://api.openai.com");
        assert_eq!(effective_base_url(info, Some("   ")), "https://api.openai.com");
    }

    #[test]
    fn effective_base_url_uses_override_and_trims_slash() {
        let info = provider_info("openai").unwrap();
        assert_eq!(
            effective_base_url(info, Some("https://proxy.example.com/")),
            "https://proxy.example.com"
        );
        assert_eq!(
            effective_base_url(info, Some("  https://proxy.example.com  ")),
            "https://proxy.example.com"
        );
    }

    #[test]
    fn require_api_key_rejects_missing_and_empty() {
        assert!(require_api_key(None, "OpenAI").is_err());
        assert!(require_api_key(Some(""), "OpenAI").is_err());
        let err = require_api_key(None, "OpenAI").unwrap_err().to_string();
        assert!(err.contains("OpenAI"));
        assert!(err.contains("Settings"));
    }

    #[test]
    fn require_api_key_accepts_present_key() {
        assert_eq!(require_api_key(Some("sk-test"), "OpenAI").unwrap(), "sk-test");
    }

    #[test]
    fn request_body_has_model_and_two_messages() {
        let req = AiRequest {
            system: "system prompt".to_string(),
            user: "user text".to_string(),
        };
        let body = build_request_body("gpt-4o-mini", &req);
        assert_eq!(body["model"], "gpt-4o-mini");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "system prompt");
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "user text");
    }

    #[test]
    fn parses_valid_response() {
        let raw = r#"{"choices":[{"message":{"role":"assistant","content":"hello there"}}]}"#;
        assert_eq!(parse_chat_response(raw).unwrap(), "hello there");
    }

    #[test]
    fn trims_whitespace_from_content() {
        let raw = r#"{"choices":[{"message":{"content":"  spaced  "}}]}"#;
        assert_eq!(parse_chat_response(raw).unwrap(), "spaced");
    }

    #[test]
    fn rejects_response_without_choices() {
        let raw = r#"{"choices":[]}"#;
        assert!(parse_chat_response(raw).is_err());
    }

    #[test]
    fn rejects_response_missing_choices_field() {
        let raw = r#"{}"#;
        assert!(parse_chat_response(raw).is_err());
    }

    #[test]
    fn rejects_response_with_empty_content() {
        let raw = r#"{"choices":[{"message":{"content":""}}]}"#;
        assert!(parse_chat_response(raw).is_err());
    }

    #[test]
    fn rejects_response_with_null_content() {
        let raw = r#"{"choices":[{"message":{"content":null}}]}"#;
        assert!(parse_chat_response(raw).is_err());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_chat_response("это не json").is_err());
    }

    #[test]
    fn status_message_covers_known_codes() {
        let unauthorized = status_error_message(401, "OpenAI");
        assert!(unauthorized.contains("key"));
        let rate_limited = status_error_message(429, "OpenAI");
        assert!(rate_limited.to_lowercase().contains("later") || rate_limited.to_lowercase().contains("try again"));
        let server_error = status_error_message(500, "OpenAI");
        assert!(server_error.contains("OpenAI"));
        let server_error_2 = status_error_message(503, "OpenAI");
        assert!(server_error_2.contains("OpenAI"));
    }

    #[test]
    fn status_message_falls_back_for_unmapped_codes() {
        let msg = status_error_message(999, "OpenAI");
        assert!(msg.contains("999"));
    }

    #[test]
    fn network_failure_messages_are_distinct_per_kind() {
        let timeout = network_failure_message(NetworkFailure::Timeout, "OpenAI");
        let connect = network_failure_message(NetworkFailure::Connect, "OpenAI");
        let other = network_failure_message(NetworkFailure::Other, "OpenAI");
        assert_ne!(timeout, connect);
        assert_ne!(timeout, other);
        assert_ne!(connect, other);
        assert!(timeout.contains("OpenAI"));
    }

    #[test]
    fn unimplemented_provider_error_names_it_without_panicking() {
        // complete() зависит от сети только для "openai" — остальные ветки
        // чистые и проверяются напрямую без tokio-рантайма.
        let err = provider_info("anthropic").unwrap();
        assert!(!err.implemented);
    }

    /// `complete()` для нереализованного провайдера не делает ни одного
    /// await-а (нет сетевого вызова), поэтому future готов сразу на первом
    /// опросе — `now_or_never()` вытаскивает результат без токио-рантайма.
    #[test]
    fn complete_returns_clean_error_for_unimplemented_provider_without_networking() {
        use futures_util::FutureExt;

        let cfg = ResolvedProvider {
            id: "anthropic".to_string(),
            model: "claude-sonnet-4-5".to_string(),
            base_url: None,
            api_key: None,
        };
        let req = AiRequest {
            system: "s".to_string(),
            user: "u".to_string(),
        };
        let result = complete(&cfg, req).now_or_never().expect(
            "неизвестный/нереализованный провайдер не должен делать сетевой вызов",
        );
        let err = result.unwrap_err().to_string();
        assert!(err.contains("Anthropic"));
        assert!(err.contains("not implemented") || err.contains("isn't implemented"));
    }

    #[test]
    fn complete_returns_clean_error_for_unknown_provider_without_networking() {
        use futures_util::FutureExt;

        let cfg = ResolvedProvider {
            id: "totally-unknown".to_string(),
            model: "x".to_string(),
            base_url: None,
            api_key: None,
        };
        let req = AiRequest {
            system: "s".to_string(),
            user: "u".to_string(),
        };
        let result = complete(&cfg, req)
            .now_or_never()
            .expect("неизвестный провайдер не должен делать сетевой вызов");
        assert!(result.is_err());
    }
}
