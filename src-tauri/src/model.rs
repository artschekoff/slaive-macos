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

/// Размер файла VAD-модели в репозитории `ggml-org/whisper-vad`, байт.
/// Проверено по метаданным репозитория, как и размеры каталога ниже.
pub const VAD_MODEL_SIZE_BYTES: u64 = 885_098;
pub const VAD_MODEL_LABEL: &str = "Silero v5.1.2";
pub const VAD_MODEL_NOTE: &str = "Skips the silence while you think, so pauses aren't transcribed into invented captions. \
     Optional — everything works without it, just slower and noisier.";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// Чем модель отличается на практике — под пользователя, который диктует
    /// по-русски с английскими терминами и работает в шумных местах.
    /// Абстрактное «быстрее/точнее» ему выбрать не помогает.
    pub note: &'static str,
    /// Точный размер файла в репозитории, байт. Взят из метаданных
    /// huggingface, а не прикинут: цифра стоит рядом с кнопкой Download и
    /// решает, хватит ли места.
    pub size_bytes: u64,
}

/// Мультиязычные модели: английские (.en) не понимают русский.
///
/// Имена файлов и размеры сверены с реальным содержимым
/// `ggerganov/whisper.cpp` — выдуманное имя даёт 404 в момент скачивания, то
/// есть ошибку у пользователя. Квантованные варианты (`-q5_1`, `-q8_0`) в
/// каталог не берём: они дешевле по месту, но заметно хуже как раз на том,
/// ради чего этот список — редкие английские термины внутри русской речи.
/// ponytail: квантованные веса не предлагаем, добавить, если место на диске
/// станет решающим ограничением.
pub const CATALOG: &[ModelInfo] = &[
    ModelInfo {
        id: "tiny",
        label: "Tiny",
        note: "Instant, and the least accurate. Usable for short dictation in a quiet room; \
               it garbles English terms and gives up on background noise.",
        size_bytes: 77_691_713,
    },
    ModelInfo {
        id: "base",
        label: "Base",
        note: "Fast. Clean Russian in a quiet room comes out fine; English terms mid-sentence \
               often come back in Cyrillic, and a noisy room costs whole words.",
        size_bytes: 147_951_465,
    },
    ModelInfo {
        id: "small",
        label: "Small",
        note: "Recommended. Usually keeps English terms as English and holds up in a café \
               or an open office. About a second of transcription per ten seconds of speech.",
        size_bytes: 487_601_967,
    },
    ModelInfo {
        id: "medium",
        label: "Medium",
        note: "Clearly better than Small on mixed Russian and English and in noise, \
               at roughly twice the transcription time and 1.5 GB of disk.",
        size_bytes: 1_533_763_059,
    },
    ModelInfo {
        id: "large-v3-turbo",
        label: "Large v3 Turbo",
        note: "The most accurate on mixed speech and noise, and nearly as fast as Small \
               thanks to the turbo decoder. Costs 1.6 GB of disk and the most memory.",
        size_bytes: 1_624_555_275,
    },
];

pub fn file_name(id: &str) -> String {
    format!("ggml-{id}.bin")
}

/// Все модели живут в одной папке, `app_data_dir()/models` — и транскрипция,
/// и VAD. Единственное место, где это имя собирается.
pub fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

/// Состояние модели в списке настроек.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelState {
    /// Файла нет — доступно скачивание.
    Missing,
    /// Файл есть, но работает сейчас другая модель — доступны Use и Delete.
    Downloaded,
    /// Файл есть и именно он прописан в настройках — Delete запрещён.
    Active,
}

/// Одна строка списка моделей: каталог плюс правда с диска.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: &'static str,
    pub label: &'static str,
    pub note: &'static str,
    pub size_bytes: u64,
    pub state: ModelState,
    /// Реальный размер файла на диске. Может отличаться от `size_bytes`,
    /// и тогда показываем именно его — это то, что занято на самом деле.
    pub disk_bytes: Option<u64>,
    /// Путь к файлу, если он есть — им подставляется активная модель.
    pub path: Option<PathBuf>,
}

/// Два пути указывают на один файл. Через `canonicalize`, потому что в
/// настройках лежит путь, записанный при скачивании, а сравнивать его нужно
/// с путём, собранным сейчас: симлинк в цепочке (`/var` → `/private/var` на
/// macOS) сделал бы строки разными при одном и том же файле, и активная
/// модель стала бы удаляемой.
fn same_file(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Состояние ОДНОЙ модели. Скачанность определяется по файлу на диске, а не
/// по записи в настройках: файл могли удалить снаружи, и список обязан
/// показывать правду, а не то, что приложение записало когда-то.
pub fn state_of(models_dir: &Path, id: &str, active: Option<&Path>) -> ModelState {
    let path = models_dir.join(file_name(id));
    if !path.is_file() {
        return ModelState::Missing;
    }
    match active {
        Some(active) if same_file(&path, active) => ModelState::Active,
        _ => ModelState::Downloaded,
    }
}

/// Весь каталог со снятым с диска состоянием — то, что показывает список
/// настроек.
pub fn catalog_state(models_dir: &Path, active: Option<&Path>) -> Vec<ModelEntry> {
    CATALOG
        .iter()
        .map(|m| {
            let path = models_dir.join(file_name(m.id));
            let state = state_of(models_dir, m.id, active);
            let exists = state != ModelState::Missing;
            ModelEntry {
                id: m.id,
                label: m.label,
                note: m.note,
                size_bytes: m.size_bytes,
                state,
                disk_bytes: exists.then(|| file_size(&path)).flatten(),
                path: exists.then(|| path.clone()),
            }
        })
        .collect()
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// Сколько места занято папкой моделей, байт. Считается по всем файлам в
/// ней, а не по каталогу: сюда входят и VAD, и недокачанные `.part`, и модель,
/// которую пользователь положил руками. Цифра рядом с кнопкой Delete должна
/// совпадать с тем, что покажет Finder, иначе она бесполезна.
pub fn disk_usage(models_dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(models_dir) else {
        return 0; // папки ещё нет — ничего и не занято
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum()
}

/// Есть ли такой id в каталоге. Тот же приём защиты, что у `url_for`: пути и
/// URL строятся только для известных id, произвольная строка (в том числе с
/// `../`) до сборки пути не доходит.
pub fn is_known(id: &str) -> bool {
    CATALOG.iter().any(|m| m.id == id)
}

/// Удаляет скачанную модель. Подтверждения не спрашиваем — модель качается
/// заново одной кнопкой; но активную удалять нельзя, иначе приложение
/// останется без распознавания вовсе.
pub fn delete(models_dir: &Path, id: &str, active: Option<&Path>) -> anyhow::Result<()> {
    // Тот же приём защиты, что у `url_for`: путь собирается только для id из
    // каталога, произвольная строка (в том числе с `../`) сюда не доходит.
    if !is_known(id) {
        return Err(anyhow!("Unknown model: {id}."));
    }
    match state_of(models_dir, id, active) {
        ModelState::Active => Err(anyhow!(
            "This model is in use. Switch to another one first, then delete it."
        )),
        // Файла и так нет — цель достигнута, ошибки нет.
        ModelState::Missing => Ok(()),
        ModelState::Downloaded => {
            let path = models_dir.join(file_name(id));
            std::fs::remove_file(&path).context("Couldn't delete the model file.")
        }
    }
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

    // Любой обрыв внутри — и `.part` удаляется. Он и так не выглядит скачанной
    // моделью (имя другое, `state_of` смотрит на `ggml-*.bin`), но занимать
    // гигабайт на диске после неудачи ему тоже незачем.
    let downloaded = match stream_to_part(app, &part_path, response, progress_event, total).await {
        Ok(downloaded) => downloaded,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(e);
        }
    };

    // Переименование — последний шаг и единственный момент, когда файл
    // начинает выглядеть скачанной моделью. До него на диске лежит только
    // `.part`, который никакая проверка скачанности за модель не считает.
    tokio::fs::rename(&part_path, &final_path).await?;
    let _ = app.emit_to(
        "settings",
        progress_event,
        Progress { downloaded, total: downloaded },
    );
    Ok(final_path)
}

/// Тело загрузки: пишет ответ во временный файл и отдаёт число записанных
/// байт. Вынесено из `download_to`, чтобы у неудачи была ровно одна точка
/// уборки `.part` — иначе каждый `?` пришлось бы оборачивать руками, а
/// пропущенный оставил бы мусор в папке моделей.
async fn stream_to_part(
    app: &AppHandle,
    part_path: &Path,
    response: reqwest::Response,
    progress_event: &str,
    total: u64,
) -> anyhow::Result<u64> {
    let mut downloaded: u64 = 0;
    let mut last_emitted: u64 = 0;
    let mut file = tokio::fs::File::create(part_path).await?;
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

    // Обрыв на середине тела не всегда доходит сюда ошибкой: сервер или
    // прокси могут закрыть соединение так, что поток просто кончится. Тогда
    // единственный признак недокачки — расхождение с Content-Length, и без
    // этой проверки усечённый файл переименовался бы в `ggml-*.bin` и
    // выглядел бы полноценной моделью до первой попытки её загрузить.
    if total > 0 && downloaded != total {
        return Err(anyhow!(
            "Download ended early — got {downloaded} of {total} bytes. Try again."
        ));
    }
    Ok(downloaded)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-model-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_model(dir: &Path, id: &str, bytes: usize) -> PathBuf {
        let path = dir.join(file_name(id));
        std::fs::write(&path, vec![0u8; bytes]).unwrap();
        path
    }

    #[test]
    fn catalog_is_not_empty_and_has_small() {
        assert!(CATALOG.iter().any(|m| m.id == "small"));
    }

    /// Каталог закрывает диапазон от «мгновенно» до «лучшее качество»: без
    /// tiny и medium между base, small и large-v3-turbo остаются провалы и по
    /// размеру, и по качеству.
    #[test]
    fn catalog_covers_the_whole_size_range() {
        let ids: Vec<&str> = CATALOG.iter().map(|m| m.id).collect();
        assert_eq!(ids, ["tiny", "base", "small", "medium", "large-v3-turbo"]);
        // Список отсортирован по размеру — так его и читают сверху вниз.
        assert!(CATALOG.windows(2).all(|w| w[0].size_bytes < w[1].size_bytes));
        // Подпись обязана объяснять разницу на практике, а не быть пустой.
        assert!(CATALOG.iter().all(|m| m.note.len() > 40));
    }

    /// Размеры сверены с метаданными `ggerganov/whisper.cpp`. Тест
    /// фиксирует именно проверенные числа: правка «на глаз» их сдвинет и
    /// упрётся в этот тест, а не в пользователя, у которого не хватило места.
    #[test]
    fn catalog_sizes_match_the_repository() {
        let by_id = |id: &str| CATALOG.iter().find(|m| m.id == id).unwrap().size_bytes;
        assert_eq!(by_id("tiny"), 77_691_713);
        assert_eq!(by_id("base"), 147_951_465);
        assert_eq!(by_id("small"), 487_601_967);
        assert_eq!(by_id("medium"), 1_533_763_059);
        assert_eq!(by_id("large-v3-turbo"), 1_624_555_275);
    }

    /// Имя файла собирается по одному правилу для всех записей каталога —
    /// это и есть то, что уходит в URL. Выдуманное имя = 404 у пользователя.
    #[test]
    fn every_catalog_id_maps_to_a_ggml_file_name() {
        for m in CATALOG {
            assert_eq!(file_name(m.id), format!("ggml-{}.bin", m.id));
            assert!(url_for(m.id).unwrap().ends_with(&file_name(m.id)));
        }
    }

    /// Скачанность — по файлу на диске, а не по записи в настройках: файл
    /// могли удалить снаружи, и список обязан показывать правду.
    #[test]
    fn state_comes_from_the_file_not_from_settings() {
        let dir = tmp();
        let path = write_model(&dir, "small", 10);

        // Настройки указывают на small, файл на месте — модель активна.
        assert_eq!(state_of(&dir, "small", Some(&path)), ModelState::Active);
        // Другая модель каталога скачана не была.
        assert_eq!(state_of(&dir, "base", Some(&path)), ModelState::Missing);

        // Файл удалили снаружи, настройки по-прежнему на него указывают —
        // модель обязана показаться отсутствующей, а не скачанной.
        std::fs::remove_file(&path).unwrap();
        assert_eq!(state_of(&dir, "small", Some(&path)), ModelState::Missing);
    }

    /// Скачана, но не активна: доступны Use и Delete.
    #[test]
    fn downloaded_but_not_active_is_distinguished_from_active() {
        let dir = tmp();
        let small = write_model(&dir, "small", 10);
        write_model(&dir, "base", 10);
        assert_eq!(state_of(&dir, "base", Some(&small)), ModelState::Downloaded);
        assert_eq!(state_of(&dir, "small", Some(&small)), ModelState::Active);
        // Модели не выбрано вовсе — скачанная просто скачана.
        assert_eq!(state_of(&dir, "small", None), ModelState::Downloaded);
    }

    #[test]
    fn catalog_state_reports_disk_size_of_present_files() {
        let dir = tmp();
        let small = write_model(&dir, "small", 1234);
        let entries = catalog_state(&dir, Some(&small));
        let by_id = |id: &str| entries.iter().find(|e| e.id == id).unwrap().clone();
        assert_eq!(entries.len(), CATALOG.len());
        assert_eq!(by_id("small").state, ModelState::Active);
        // Реальный размер файла, а не заявленный каталогом.
        assert_eq!(by_id("small").disk_bytes, Some(1234));
        assert!(by_id("small").path.is_some());
        assert_eq!(by_id("medium").state, ModelState::Missing);
        assert_eq!(by_id("medium").disk_bytes, None);
        assert_eq!(by_id("medium").path, None);
    }

    /// Активную модель удалять нельзя — иначе приложение остаётся без
    /// распознавания, а починить это можно только повторным скачиванием.
    #[test]
    fn active_model_cannot_be_deleted() {
        let dir = tmp();
        let small = write_model(&dir, "small", 10);
        let err = delete(&dir, "small", Some(&small)).unwrap_err().to_string();
        assert!(err.contains("in use"), "непонятное сообщение: {err}");
        assert!(small.exists(), "файл активной модели должен остаться на месте");
    }

    #[test]
    fn non_active_model_is_deleted() {
        let dir = tmp();
        let small = write_model(&dir, "small", 10);
        let base = write_model(&dir, "base", 10);
        delete(&dir, "base", Some(&small)).unwrap();
        assert!(!base.exists());
        assert!(small.exists());
        // Повторное удаление того же id — не ошибка: файла и так нет.
        delete(&dir, "base", Some(&small)).unwrap();
    }

    /// Тот же приём защиты от path traversal, что у `url_for`: удаление
    /// строит путь только для известного id.
    #[test]
    fn delete_rejects_unknown_ids() {
        let dir = tmp();
        assert!(delete(&dir, "../../etc/passwd", None).is_err());
        assert!(delete(&dir, "не-существует", None).is_err());
    }

    /// `is_known` — общий сторож для всего, что собирает путь или URL по id.
    /// Каждый известный id обязан его проходить, любая другая строка — нет.
    #[test]
    fn is_known_accepts_exactly_the_catalog() {
        for m in CATALOG {
            assert!(is_known(m.id), "{} должен быть известен", m.id);
        }
        assert!(!is_known("../../etc/passwd"));
        assert!(!is_known("../ggml-small"));
        assert!(!is_known("small.bin"));
        assert!(!is_known(""));
        // VAD живёт вне каталога транскрипции — у него свой сторож
        // (`vad_url_for`), и путать их нельзя.
        assert!(!is_known(VAD_MODEL_ID));
    }

    #[test]
    fn disk_usage_sums_every_file_in_the_models_folder() {
        let dir = tmp();
        assert_eq!(disk_usage(&dir.join("нет-такой-папки")), 0);
        assert_eq!(disk_usage(&dir), 0);
        write_model(&dir, "small", 1000);
        write_model(&dir, "base", 500);
        // Недокачанный кусок тоже занимает место — цифра должна совпадать с
        // тем, что покажет Finder, иначе она бесполезна.
        std::fs::write(dir.join("ggml-medium.bin.part"), vec![0u8; 250]).unwrap();
        assert_eq!(disk_usage(&dir), 1750);
    }

    #[test]
    fn url_points_at_huggingface_for_the_new_ids() {
        assert_eq!(
            url_for("tiny").unwrap(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin"
        );
        assert_eq!(
            url_for("medium").unwrap(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin"
        );
        assert_eq!(
            url_for("large-v3-turbo").unwrap(),
            "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
        );
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
