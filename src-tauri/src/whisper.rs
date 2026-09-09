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
                "Model file not found. Open Settings and download it again."
            ));
        }
        let ctx = WhisperContext::new_with_params(
            &model_path.to_string_lossy(),
            WhisperContextParameters::default(),
        )
        .context("Couldn't load the whisper model. Try downloading it again in Settings.")?;
        Ok(Self { ctx })
    }

    /// `pcm` должен быть f32, 16 кГц, моно. `language` — "auto", "ru" или "en".
    pub fn transcribe(&self, pcm: &[f32], language: &str) -> anyhow::Result<String> {
        if pcm.len() < MIN_SAMPLES {
            return Err(anyhow!("Recording too short — hold the hotkey and speak longer."));
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

        let mut state = self
            .ctx
            .create_state()
            .context("Couldn't initialize the whisper engine.")?;
        state
            .full(params, pcm)
            .context("Couldn't transcribe the recording.")?;

        let n = state
            .full_n_segments()
            .context("Couldn't read transcription segments.")?;
        let mut segments = Vec::with_capacity(n as usize);
        for i in 0..n {
            // ponytail: сегмент, который whisper.cpp не смог отдать текстом,
            // тихо пропускаем вместо прерывания всей расшифровки — одна
            // испорченная реплика не должна стоить пользователю всей записи.
            // Усложнить, если окажется, что это происходит не только на
            // мусорном/пустом аудио.
            segments.push(state.full_get_segment_text(i).unwrap_or_default());
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
        let text = t.transcribe(&silence, "ru").unwrap();
        println!("на тишине получили: {text:?}");
    }
}
