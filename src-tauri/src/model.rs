use anyhow::{anyhow, Context};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

const BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// VAD (Voice Activity Detection) — отдельный от каталога транскрипции
/// артефакт: ровно один файл, а не выбор между размерами, поэтому у него
/// нет записи в `CATALOG` и нет выпадающего списка. Тот же
/// `ggerganov/whisper.cpp` отдаёт для этого файла 404 — модель лежит в
/// отдельном репозитории `ggml-org/whisper-vad`.
const VAD_MODEL_URL_BASE: &str = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";
/// Единственный допустимый id VAD-модели — тот же приём защиты от path
/// traversal, что и у `url_for`: URL строится только для этого точного id.
pub const VAD_MODEL_ID: &str = "silero-v5.1.2";
pub const VAD_MODEL_FILE_NAME: &str = "ggml-silero-v5.1.2.bin";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub size_mb: u32,
}

/// Мультиязычные модели: английские (.en) не понимают русский.
pub const CATALOG: &[ModelInfo] = &[
    ModelInfo { id: "base", label: "Base — fast, weaker on Russian", size_mb: 148 },
    ModelInfo { id: "small", label: "Small — recommended", size_mb: 488 },
    ModelInfo { id: "large-v3-turbo", label: "Large v3 Turbo — best quality", size_mb: 1620 },
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

/// Тот же приём для VAD: URL строится только при точном совпадении с
/// единственным известным id, а не подстановкой произвольного значения.
pub fn vad_url_for(id: &str) -> Option<String> {
    (id == VAD_MODEL_ID).then(|| format!("{VAD_MODEL_URL_BASE}/{VAD_MODEL_FILE_NAME}"))
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
    let url = url_for(id).ok_or_else(|| anyhow!("Unknown model: {id}."))?;
    download_to(app, dir, &url, &file_name(id), "model:progress").await
}

/// То же самое для VAD-модели: выбора размера тут нет, поэтому без id —
/// единственный известный URL берётся напрямую из `vad_url_for`. Прогресс —
/// отдельным событием `vad:progress`, чтобы не путаться с загрузкой модели
/// транскрипции, если пользователь умудрится запустить оба скачивания разом.
pub async fn download_vad(app: &AppHandle, dir: &Path) -> anyhow::Result<PathBuf> {
    let url = vad_url_for(VAD_MODEL_ID).expect("VAD_MODEL_ID должен совпадать сам с собой");
    download_to(app, dir, &url, VAD_MODEL_FILE_NAME, "vad:progress").await
}

/// Общее ядро загрузки, разделяемое моделями транскрипции и VAD: пишет во
/// временный `.part` и переименовывает только после успеха — прерванная
/// загрузка не оставит битый файл, который выглядит как рабочий.
async fn download_to(
    app: &AppHandle,
    dir: &Path,
    url: &str,
    file_name: &str,
    progress_event: &str,
) -> anyhow::Result<PathBuf> {
    let models_dir = dir.join("models");
    tokio::fs::create_dir_all(&models_dir).await?;

    let final_path = models_dir.join(file_name);
    let part_path = models_dir.join(format!("{file_name}.part"));

    // I9: без явных таймаутов зависшее соединение оставляло пользователя
    // смотреть на «Downloading…» без полосы, без отмены и без ошибки —
    // бесконечно. connect_timeout ловит недоступный сервер, read_timeout —
    // застрявшее соединение посреди уже начатой загрузки.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .read_timeout(std::time::Duration::from_secs(30))
        .build()
        .context("Couldn't create the download client.")?;

    let response = client
        .get(url)
        .send()
        .await
        .context("Couldn't reach huggingface.co. Check your internet connection and try again.")?
        .error_for_status()
        .context("The server returned an error while downloading the model. Try again later.")?;

    let total = response.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let mut file = tokio::fs::File::create(&part_path).await?;
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("Connection dropped during download. Try again.")?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        // Событие не чаще, чем раз на мегабайт — иначе UI захлебнётся.
        if downloaded - last_emitted > 1_000_000 {
            last_emitted = downloaded;
            let _ = app.emit_to("settings", progress_event, Progress { downloaded, total });
        }
    }
    file.flush().await?;
    drop(file);

    tokio::fs::rename(&part_path, &final_path).await?;
    let _ = app.emit_to(
        "settings",
        progress_event,
        Progress { downloaded, total: downloaded },
    );
    Ok(final_path)
}

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

    #[test]
    fn vad_url_matches_known_id() {
        assert_eq!(
            vad_url_for(VAD_MODEL_ID).unwrap(),
            "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin"
        );
    }

    #[test]
    fn vad_url_rejects_unknown_ids() {
        // Тот же приём защиты от path traversal, что и у моделей транскрипции.
        assert!(vad_url_for("../../etc/passwd").is_none());
        assert!(vad_url_for("не-существует").is_none());
    }
}
