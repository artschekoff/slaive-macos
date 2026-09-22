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

/// Зажимает порог VAD в допустимый диапазон. Пришедшее значение могли
/// поправить руками в settings.json: 0.0 сделал бы VAD бесполезным («всё
/// речь»), 1.0 — вырезал бы запись целиком, а NaN уронил бы `clamp`.
pub fn clamp_vad_threshold(threshold: f32) -> f32 {
    if threshold.is_nan() {
        return crate::settings::DEFAULT_VAD_THRESHOLD;
    }
    threshold.clamp(
        crate::settings::MIN_VAD_THRESHOLD,
        crate::settings::MAX_VAD_THRESHOLD,
    )
}

/// Потолок подсказки: whisper.cpp берёт из `initial_prompt` не больше
/// `n_text_ctx/2` токенов (whisper.cpp: `std::min(n_max_text_ctx,
/// whisper_n_text_ctx(ctx)/2)`), а `n_text_ctx` у всех моделей 448. Лишнее
/// отбрасывается С НАЧАЛА списка и молча: длинный словарь не расширяет охват,
/// а тихо теряет первые термины.
pub const MAX_PROMPT_TOKENS: usize = 224;

/// Запас на пробное токенизирование: `whisper_tokenize` пишет в буфер
/// фиксированного размера и отдаёт -1, если не поместилось. Шестьдесят
/// четыре бюджета — заведомо больше любого осмысленного словаря; всё, что
/// длиннее, и так далеко за потолком, и точное число там уже не нужно.
const TOKENIZE_PROBE_LIMIT: usize = MAX_PROMPT_TOKENS * 64;

/// Собирает `initial_prompt` из словаря терминов пользователя.
///
/// Зачем это вообще: человек диктует по-русски и вставляет английские
/// термины. Без подсказки whisper пишет их кириллицей («реакт», «докер»), и
/// исправлять приходится руками каждый раз. Увидев те же слова в затравке,
/// модель повторяет их написание.
///
/// Пользователь пишет их списком — по строке или через запятую; whisper ждёт
/// связный текст, поэтому строки склеиваются в одну через запятую. Пустые
/// куски выбрасываются, пустой словарь целиком даёт `None` — параметр не
/// передаётся вовсе, а не пустой строкой (пустая затравка не то же самое,
/// что её отсутствие, и незачем выяснять, как whisper.cpp понимает первое).
///
/// NUL вырезается: `FullParams::set_initial_prompt` строит `CString` и на
/// нуле внутри строки паникует (whisper-rs 0.16). В settings.json такой байт
/// не попадёт через интерфейс, но файл правят руками.
pub fn initial_prompt(dictionary: &str) -> Option<String> {
    let terms: Vec<String> = dictionary
        .split(['\n', ','])
        .map(|term| term.replace('\0', "").trim().to_string())
        .filter(|term| !term.is_empty())
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(terms.join(", "))
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

    /// Сколько токенов занимает текст у токенизатора ЭТОЙ модели.
    ///
    /// Почему это единственный честный ответ. Токенизатор whisper — байтовый
    /// BPE, и «символов на токен» у него не константа, а функция от письма и
    /// регистра: замер на реальной модели (см. `prompt_token_estimate...`
    /// ниже и отчёт) даёт от 1.5 символов на токен на списке аббревиатур до
    /// 6.2 на связной английской фразе — разброс вчетверо. Любая оценка «по
    /// длине» либо врёт вдвое вниз на одних словарях, либо вдвое вверх на
    /// других; оба направления одинаково бесполезны рядом с потолком в 224.
    ///
    /// Ошибка — только если текст не поместился в пробный буфер
    /// (`TOKENIZE_PROBE_LIMIT`) или содержит NUL; и то и другое означает
    /// словарь, который в подсказку не влезет в любом случае.
    pub fn count_tokens(&self, text: &str) -> anyhow::Result<usize> {
        self.ctx
            .tokenize(text, TOKENIZE_PROBE_LIMIT)
            .map(|tokens| tokens.len())
            .map_err(|e| {
                anyhow!("Dictionary is too long to count — shorten it. ({e})")
            })
    }

    /// `pcm` должен быть f32, 16 кГц, моно, УЖЕ усиленный (см.
    /// `audio::apply_gain` — усиление применяется до вызова, одинаково для
    /// VAD и для расшифровки). `language` — "auto", "ru" или "en".
    /// `vad_model_path` — путь к модели VAD (Silero), если пользователь её
    /// скачал; `None` или несуществующий файл просто отключают VAD, это не
    /// ошибка — расшифровка идёт как раньше, по всему аудио целиком.
    /// `vad_threshold` — порог вероятности речи, имеет смысл только когда
    /// VAD включён; вне диапазона зажимается (см. `settings`).
    /// `initial_prompt` — уже собранная затравка из словаря терминов (см.
    /// `initial_prompt`); `None` означает, что параметр не передаётся вовсе.
    pub fn transcribe(
        &self,
        pcm: &[f32],
        language: &str,
        vad_model_path: Option<&Path>,
        vad_threshold: f32,
        initial_prompt: Option<&str>,
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

        // Словарь терминов. Задаём параметр ТОЛЬКО когда затравка есть:
        // set_initial_prompt копирует строку в свой CString (whisper-rs
        // 0.16), поэтому одолжённая &str переживать вызов не обязана.
        if let Some(prompt) = initial_prompt {
            // Единственное место, где ВИДНО, что подсказка не влезла: токены
            // считает та же модель, которая сейчас будет расшифровывать.
            // В лог идут только числа — сам словарь это тоже личные данные.
            match self.count_tokens(prompt) {
                Ok(n) if n > MAX_PROMPT_TOKENS => log::warn!(
                    "словарь: {n} токенов при потолке {MAX_PROMPT_TOKENS} — whisper отбросит {} с начала списка",
                    n - MAX_PROMPT_TOKENS
                ),
                Ok(_) => {}
                Err(e) => log::warn!("словарь: посчитать токены не удалось: {e}"),
            }
            params.set_initial_prompt(prompt);
        }

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
                // Порог обнаружения речи — единственный параметр VAD, который
                // вынесен пользователю (см. `settings::vad_threshold`): на
                // тихом микрофоне дефолтные 0.5 могут не увидеть речи вовсе и
                // вырезать всю запись, а симптом («ничего не распознано»)
                // неотличим от обычной неудачи. Значение зажимается здесь, а
                // не только в интерфейсе: settings.json правится руками.
                vad_params.set_threshold(clamp_vad_threshold(vad_threshold));
                // min_speech_duration, max_speech_duration, samples_overlap —
                // дефолты крейта: пользовательский кейс не даёт основания их
                // менять (максимум длины сегмента и так ограничен длиной
                // записи хоткея).
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

    /// Пустой словарь — параметр не передаётся вовсе, а не пустой строкой.
    #[test]
    fn empty_dictionary_produces_no_prompt() {
        assert_eq!(initial_prompt(""), None);
        assert_eq!(initial_prompt("   "), None);
        assert_eq!(initial_prompt("\n\n  \n"), None);
        // Одни разделители без слов — тоже пусто.
        assert_eq!(initial_prompt(",,, \n , "), None);
    }

    /// Пользователь пишет термины списком; whisper ждёт связный текст.
    #[test]
    fn dictionary_lines_become_one_comma_separated_prompt() {
        assert_eq!(
            initial_prompt("React\nTypeScript\nKubernetes").as_deref(),
            Some("React, TypeScript, Kubernetes")
        );
    }

    /// Списком через запятую в одну строку — тот же результат: разделитель
    /// выбирает пользователь, а не формат поля.
    #[test]
    fn commas_and_newlines_are_the_same_separator() {
        assert_eq!(
            initial_prompt("React, TypeScript\n  Kubernetes ,\n\n Docker "),
            initial_prompt("React\nTypeScript\nKubernetes\nDocker")
        );
    }

    /// Кириллица и латиница в одном словаре — ровно тот случай, ради
    /// которого поле существует: русская речь с английскими терминами.
    #[test]
    fn dictionary_keeps_mixed_scripts_as_typed() {
        assert_eq!(
            initial_prompt("Слейв\nwhisper.cpp\nTauri").as_deref(),
            Some("Слейв, whisper.cpp, Tauri")
        );
    }

    /// NUL уронил бы `set_initial_prompt` паникой внутри CString — в
    /// settings.json такой байт можно вписать руками.
    #[test]
    fn nul_bytes_are_stripped_before_they_reach_cstring() {
        let prompt = initial_prompt("Rea\0ct\nTauri").unwrap();
        assert!(!prompt.contains('\0'));
        assert_eq!(prompt, "React, Tauri");
    }

    #[test]
    fn vad_threshold_is_clamped_to_the_useful_range() {
        assert_eq!(clamp_vad_threshold(0.5), 0.5);
        assert_eq!(clamp_vad_threshold(0.0), crate::settings::MIN_VAD_THRESHOLD);
        assert_eq!(clamp_vad_threshold(1.0), crate::settings::MAX_VAD_THRESHOLD);
        assert_eq!(
            clamp_vad_threshold(f32::NAN),
            crate::settings::DEFAULT_VAD_THRESHOLD
        );
    }

    /// ЗАМЕР НА ЖИВОМ ТОКЕНИЗАТОРЕ. Тест, ради которого счётчик бюджета
    /// перестал быть оценкой по длине. Печатает по каждому представительному
    /// словарю: символы, байты, реальные токены и обе прежние оценки —
    /// «байты/3.5» (так считал Rust) и «символы/3.5» (так считал фронтенд).
    ///
    /// Проверяет он ровно одно утверждение, которое нельзя вывести
    /// рассуждением: обе прежние оценки промахиваются, причём в РАЗНЫЕ
    /// стороны, и ни одна не годится в предупреждение. Числа замера — в
    /// отчёте .superpowers/sdd/2026-09-09-slaive-v1-voice-overlay/.
    ///
    /// Запуск (модель любая, счёт зависит от её словаря):
    /// SLAIVE_MODEL="$HOME/Library/Application Support/net.slaive.app/models/ggml-large-v3-turbo.bin" \
    ///   PATH="$HOME/.cargo/bin:$PATH" cargo test prompt_token -- --ignored --nocapture
    #[test]
    #[ignore]
    fn prompt_token_length_estimates_are_wrong_in_both_directions() {
        let path = std::env::var("SLAIVE_MODEL").expect("задай SLAIVE_MODEL");
        let t = Transcriber::load(std::path::Path::new(&path)).unwrap();

        let ru_terms = "коммит\nветка\nоткат\nразвёртывание\nочередь\nиндекс\n\
хранилище\nнагрузка\nотказоустойчивость\nмикросервис\nпроизводительность\n\
обновление\nсогласованность\nбалансировщик\nподписка\nшифрование";
        let mixed = "React\nкоммит\nKubernetes\nветка\nDocker\nразвёртывание\n\
pull request\nочередь\nTypeScript\nотказоустойчивость";
        let acronyms = "JWT\nCORS\nGKE\nIAM\nSSO\nCRDT\nHSTS\nBPE\nRPC\nUUID\nTTL\nACL\nSLA\nSLO";

        // Словарь, на котором прежние оценки ЗАНИЖАЮТ счёт: это и есть
        // опасное направление — предупреждение не показывается, а термины
        // из начала списка уже отброшены.
        let mut too_low = Vec::new();
        // И словарь, на котором Rust-оценка ЗАВЫШАЕТ вдвое: пугает там, где
        // места ещё половина.
        let mut too_high = Vec::new();

        for (name, dict) in [
            ("EN seed", crate::settings::DEFAULT_DICTIONARY),
            ("RU terms", ru_terms),
            ("mixed", mixed),
            ("EN acronyms", acronyms),
        ] {
            let prompt = initial_prompt(dict).expect("словарь не пуст");
            let real = t.count_tokens(&prompt).expect("токенизация словаря");
            let chars = prompt.chars().count();
            let bytes = prompt.len();
            let est_bytes = (bytes as f32 / 3.5).ceil() as usize;
            let est_chars = (chars as f32 / 3.5).ceil() as usize;
            println!(
                "{name:12} chars={chars:4} bytes={bytes:4} tokens={real:4} \
chars/tok={:.2} прежняя оценка Rust (байты/3.5)={est_bytes:4} фронтенда (символы/3.5)={est_chars:4}",
                chars as f32 / real as f32,
            );
            if est_chars < real {
                too_low.push(name);
            }
            if est_bytes as f32 > real as f32 * 1.4 {
                too_high.push(name);
            }
        }

        assert!(
            !too_low.is_empty(),
            "оценка по символам обязана где-то занижать — иначе замер не воспроизвёлся: {too_low:?}"
        );
        assert!(
            !too_high.is_empty(),
            "оценка по байтам обязана где-то сильно завышать: {too_high:?}"
        );
        println!("занижают: {too_low:?}; сильно завышают: {too_high:?}");
    }

    /// Потолок подсказки — не выдумка: он выводится из `n_text_ctx` самой
    /// модели, и если whisper.cpp когда-нибудь изменит контекст, число здесь
    /// обязано разойтись с моделью громко, а не остаться жить в комментарии.
    #[test]
    #[ignore]
    fn max_prompt_tokens_is_half_the_model_text_context() {
        let path = std::env::var("SLAIVE_MODEL").expect("задай SLAIVE_MODEL");
        let ctx = whisper_rs::WhisperContext::new_with_params(
            &path,
            whisper_rs::WhisperContextParameters::default(),
        )
        .unwrap();
        assert_eq!(ctx.n_text_ctx() as usize / 2, MAX_PROMPT_TOKENS);
    }

    /// Сид словаря против РЕАЛЬНОГО токенизатора. Прежняя версия этого теста
    /// жила в settings.rs и считала «байты/3.5» — на сиде это 181 токен при
    /// настоящих 192, то есть тест защищал не тот запас, который думал.
    #[test]
    #[ignore]
    fn default_dictionary_fits_the_prompt_budget() {
        let path = std::env::var("SLAIVE_MODEL").expect("задай SLAIVE_MODEL");
        let t = Transcriber::load(std::path::Path::new(&path)).unwrap();
        let prompt = initial_prompt(crate::settings::DEFAULT_DICTIONARY).unwrap();
        let real = t.count_tokens(&prompt).unwrap();
        println!("сид словаря: {real} токенов из {MAX_PROMPT_TOKENS}");
        assert!(
            real <= MAX_PROMPT_TOKENS,
            "сид занимает {real} токенов при потолке {MAX_PROMPT_TOKENS}: \
whisper отбросит начало списка молча"
        );
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
        let text = t.transcribe(&silence, "ru", None, 0.5, None).unwrap();
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

        let text = t.transcribe(&tone, "auto", None, 0.5, None).unwrap();
        println!("на тоне 440 Гц с language=auto получили: {text:?}");
        // Основная регрессия, которую мы ловим: раньше это возвращало Ok("")
        // из-за detect_language, не дойдя до транскрипции вообще. transcribe
        // должен как минимум успешно завершиться, не упав в пустую строку
        // из-за возврата на этапе определения языка.
        assert!(
            t.transcribe(&tone, "auto", None, 0.5, None).is_ok(),
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
            .transcribe(&pcm, "auto", Some(vad_path.as_path()), 0.5, None)
            .unwrap();
        println!("VAD включён ({}): получили {text:?}", vad_path.display());
    }
}
