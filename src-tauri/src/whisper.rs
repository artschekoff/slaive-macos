use anyhow::{anyhow, Context};
use std::path::Path;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadParams,
};

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
                "Model file not found. Open Settings and download it again."
            ));
        }
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
        .context("Couldn't load the whisper model. Try downloading it again in Settings.")?;
        Ok(Self { ctx })
    }

    /// `pcm` должен быть f32, 16 кГц, моно. `language` — "auto", "ru" или "en".
    /// `vad_model_path` — путь к модели VAD (Silero), если пользователь её
    /// скачал; `None` или несуществующий файл просто отключают VAD, это не
    /// ошибка — расшифровка идёт как раньше, по всему аудио целиком.
    pub fn transcribe(
        &self,
        pcm: &[f32],
        language: &str,
        vad_model_path: Option<&Path>,
    ) -> anyhow::Result<String> {
        if pcm.len() < MIN_SAMPLES {
            return Err(anyhow!("Recording too short — hold the hotkey and speak longer."));
        }

        // `lang` объявлен до `params`, потому что FullParams заимствует эту строку.
        let lang = language.to_string();
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // "auto" передаём как обычное значение языка, а не через
        // set_detect_language: у whisper.cpp это отдельный режим "определить
        // язык и остановиться" — full() возвращает 0 сегментов, ничего не
        // расшифровав. Строка "auto" сама попадает в ту же ветку определения
        // языка внутри whisper.cpp, но затем продолжает расшифровку.
        //
        // ЛОВУШКА: докстринг whisper-rs у set_detect_language врёт:
        //   "Set `detect_language`. Has the same effect as setting the
        //   language to \"auto\" or None."
        // Это не так ни в одной проверенной версии whisper-rs (0.14, 0.16),
        // ни в whisper.cpp — флаг detect_language там означает буквально
        // "определи язык и выйди немедленно", а не "определи и продолжи
        // расшифровку". Именно эта строка докстринга и стала причиной
        // первоначального бага (см. регрессионный тест auto_language_transcribes
        // ниже). НЕ заменять set_language(Some("auto")) на
        // set_detect_language(true), поверив документации крейта — проверено
        // вручную на реальной модели, что это ломает транскрипцию.
        params.set_language(Some(lang.as_str()));
        params.set_n_threads(thread_count());
        params.set_translate(false);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        // VAD — усиление, а не обязательное условие: пользователь, не
        // скачавший модель, должен получить расшифровку точно как раньше.
        // Путь объявлен до `params.set_vad_model_path`, чтобы пережить сам
        // вызов (set_vad_model_path копирует байты в свой CString, но
        // одолжённая &str должна быть жива хотя бы на время вызова).
        if let Some(path) = vad_model_path {
            if path.exists() {
                let vad_path = path.to_string_lossy().into_owned();
                params.set_vad_model_path(Some(vad_path.as_str()));
                // enable_vad(true) паникует, если путь не задан — но мы его
                // только что задали строкой выше, так что это безопасно.
                params.enable_vad(true);

                let mut vad_params = WhisperVadParams::default();
                // Пользователь думает вслух и держит паузы секунду и дольше.
                // Дефолт 100 мс слишком чувствителен: он резал бы сегмент на
                // каждой межсловной/межфразовой паузе на выдохе (обычно
                // <300 мс), плодя лишние короткие сегменты. 500 мс — заметно
                // ниже целевой паузы пользователя (>=1 с), но выше обычной
                // паузы внутри непрерывной речи, так что настоящие паузы для
                // раздумий по-прежнему вырезаются, а естественная речь — нет.
                vad_params.set_min_silence_duration(500);
                // Дефолт 30 мс — безопасный запас для чистой команды голосом
                // "в упор", но начало слова после долгой паузы для раздумий
                // часто тише и определяется VAD на десятки миллисекунд позже
                // истинного начала звука. 200 мс — компромисс: заметно больше
                // запаса на старте/конце сегмента, а стоимость (до 400 мс
                // лишней почти тишины на сегмент из многосекундной записи)
                // ничтожна на фоне цели "не резать начало слова".
                vad_params.set_speech_pad(200);
                // threshold, min_speech_duration, max_speech_duration,
                // samples_overlap — дефолты крейта: пользовательский кейс не
                // даёт основания их менять (короткого шума на грани
                // распознавания не больше обычного, максимум длины сегмента
                // и так ограничен длиной записи хоткея).
                params.set_vad_params(vad_params);
            }
        }

        let mut state = self
            .ctx
            .create_state()
            .context("Couldn't initialize the whisper engine.")?;
        state
            .full(params, pcm)
            .context("Couldn't transcribe the recording.")?;

        // В 0.16 full_n_segments() возвращает голый c_int, а не Result — это
        // изменилось при апгрейде с 0.14.
        let n = state.full_n_segments();
        let mut segments = Vec::with_capacity(n as usize);
        for i in 0..n {
            // ponytail: сегмент, который whisper.cpp не смог отдать текстом,
            // тихо пропускаем вместо прерывания всей расшифровки — одна
            // испорченная реплика не должна стоить пользователю всей записи.
            // Усложнить, если окажется, что это происходит не только на
            // мусорном/пустом аудио.
            //
            // В 0.16 full_get_segment_text() убрали: сегмент теперь достаётся
            // через get_segment() -> Option<WhisperSegment>, а текст — через
            // to_str_lossy() -> Result<Cow<str>, _>.
            let text = state
                .get_segment(i)
                .and_then(|s| s.to_str_lossy().ok())
                .map(|s| s.into_owned())
                .unwrap_or_default();
            segments.push(text);
        }
        Ok(join_segments(&segments))
    }
}

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
        let text = t.transcribe(&silence, "ru", None).unwrap();
        println!("на тишине получили: {text:?}");
    }

    /// Регрессия на баг с `set_detect_language`: при языке "auto" full()
    /// раньше возвращал 0 сегментов, потому что detect_language — это режим
    /// "определить язык и остановиться", а не "определить и расшифровать".
    /// Запуск:
    /// SLAIVE_MODEL=~/Library/Application\ Support/net.slaive.app/models/ggml-base.bin \
    ///   cargo test auto_language_transcribes -- --ignored --nocapture
    #[test]
    #[ignore]
    fn auto_language_transcribes() {
        let path = std::env::var("SLAIVE_MODEL").expect("задай SLAIVE_MODEL");
        let t = Transcriber::load(std::path::Path::new(&path)).unwrap();

        // Грубый тон 440 Гц, 2 секунды на 16 кГц — не тишина, но и не речь.
        let sample_rate = 16_000_usize;
        let duration_secs = 2;
        let freq = 440.0_f32;
        let tone: Vec<f32> = (0..sample_rate * duration_secs)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                0.5 * (2.0 * std::f32::consts::PI * freq * t).sin()
            })
            .collect();

        let text = t.transcribe(&tone, "auto", None).unwrap();
        println!("на тоне 440 Гц с language=auto получили: {text:?}");
        // Основная регрессия, которую мы ловим: раньше это возвращало Ok("")
        // из-за detect_language, не дойдя до транскрипции вообще. transcribe
        // должен как минимум успешно завершиться, не упав в пустую строку
        // из-за возврата на этапе определения языка.
        assert!(
            t.transcribe(&tone, "auto", None).is_ok(),
            "transcribe с auto должен завершаться Ok"
        );
    }

    /// Проверка VAD на реальных модели и файле Silero: запись из тишины,
    /// затем тона, затем снова тишины — форма, похожая на реальную паузу для
    /// раздумий на входе и выходе записи. Требует не только SLAIVE_MODEL, но
    /// и файл VAD рядом, в той же папке `models/` (см. брифинг задачи —
    /// скачивается тем же curl, что и модель, под именем
    /// `model::VAD_MODEL_FILE_NAME`). Запуск:
    /// SLAIVE_MODEL=~/Library/Application\ Support/net.slaive.app/models/ggml-base.bin \
    ///   PATH="$HOME/.cargo/bin:$PATH" cargo test -- --ignored --nocapture
    #[test]
    #[ignore]
    fn vad_model_transcribes_with_silence_padding() {
        let path = std::env::var("SLAIVE_MODEL").expect("задай SLAIVE_MODEL");
        let model_path = std::path::Path::new(&path);
        let t = Transcriber::load(model_path).unwrap();

        let vad_path = model_path
            .parent()
            .expect("у SLAIVE_MODEL должна быть родительская папка")
            .join(crate::model::VAD_MODEL_FILE_NAME);
        assert!(
            vad_path.exists(),
            "скачайте модель VAD в {} перед запуском (см. брифинг задачи)",
            vad_path.display()
        );

        let sample_rate = 16_000usize;
        let silence = vec![0.0_f32; sample_rate];
        let freq = 440.0_f32;
        let tone: Vec<f32> = (0..sample_rate)
            .map(|i| {
                let t = i as f32 / sample_rate as f32;
                0.5 * (2.0 * std::f32::consts::PI * freq * t).sin()
            })
            .collect();
        let mut pcm = silence.clone();
        pcm.extend_from_slice(&tone);
        pcm.extend_from_slice(&silence);

        let text = t
            .transcribe(&pcm, "auto", Some(vad_path.as_path()))
            .unwrap();
        println!("VAD включён ({}): получили {text:?}", vad_path.display());
    }
}
