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
