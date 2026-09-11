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

/// Пиковая амплитуда чанка. Вынесено отдельно, чтобы поддавалось тесту.
pub fn peak_amplitude(chunk: &[f32]) -> f32 {
    chunk.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

/// Границы множителя усиления микрофона. Ниже 0.5× смысла нет (тихий вход и
/// так проблема, а не громкий), выше 10× любой реальный микрофон уже упирается
/// в ограничение по модулю единицы и начинает клиппировать.
pub const MIN_GAIN: f32 = 0.5;
pub const MAX_GAIN: f32 = 10.0;
pub const DEFAULT_GAIN: f32 = 1.0;

/// Усиливает сэмплы перед VAD и whisper (см. `commands::end_recording`).
///
/// Два ограничения, оба обязательны:
///  - сам множитель зажимается в [`MIN_GAIN`, `MAX_GAIN`] — settings.json
///    лежит открытым текстом и его могли поправить руками, а `NaN`/1000×
///    превратили бы запись в сплошной треск;
///  - результат зажимается по модулю единицы — выход за диапазон f32-аудио
///    и есть клиппинг, whisper на нём распознаёт хуже, чем на тихом входе.
///
/// Функция НЕ имеет отношения к дорожке уровня: дорожка рисуется из пиков,
/// которые `Recorder` считает в колбэке микрофона (см. `Recorder::start`), а
/// сюда приходит уже завершённая запись. `audio.rs` про множитель не знает
/// нигде, кроме этой чистой функции, — усиление физически не может попасть
/// в путь пиков.
pub fn apply_gain(pcm: &[f32], gain: f32) -> Vec<f32> {
    // NaN не проходит ни одно сравнение, поэтому clamp на нём паникует —
    // отсекаем отдельно, до него.
    let gain = if gain.is_nan() {
        DEFAULT_GAIN
    } else {
        gain.clamp(MIN_GAIN, MAX_GAIN)
    };
    if gain == 1.0 {
        return pcm.to_vec();
    }
    pcm.iter().map(|s| (s * gain).clamp(-1.0, 1.0)).collect()
}

/// Склейка аудио при дозаписи: новый фрагмент продолжает предыдущий, а не
/// заменяет его. Иначе `Play` играл бы только последний кусок, а текст в
/// панели был бы накопленным — кнопка начала бы врать о том, что проигрывает.
pub fn concat_pcm(prev: &[f32], next: &[f32]) -> Vec<f32> {
    let mut out = Vec::with_capacity(prev.len() + next.len());
    out.extend_from_slice(prev);
    out.extend_from_slice(next);
    out
}

/// Какое устройство записи открывать. Решение отделено от самого открытия
/// намеренно: открытие требует живого `cpal::Host` и микрофона, а решение —
/// чистая функция, которая проверяется тестом без того и другого.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceChoice {
    /// Сохранённого выбора нет — следуем за системным умолчанием. Это НЕ то
    /// же самое, что «имя нынешнего умолчания»: человек, выбравший «по
    /// умолчанию», хочет следовать за системой и дальше.
    SystemDefault,
    /// Сохранённое устройство на месте — пишем с него.
    Named(String),
    /// Сохранённого устройства в системе нет (iPhone ушёл из зоны, наушники
    /// отключили). Пишем с умолчания, но обязаны сказать об этом человеку —
    /// имя внутри как раз для сообщения.
    MissingFallback(String),
}

/// Решает, с какого устройства писать: сохранённый выбор против того, что
/// сейчас реально есть в системе.
pub fn choose_device(saved: Option<&str>, available: &[String]) -> DeviceChoice {
    match saved {
        None => DeviceChoice::SystemDefault,
        Some(name) if available.iter().any(|d| d == name) => DeviceChoice::Named(name.to_string()),
        Some(name) => DeviceChoice::MissingFallback(name.to_string()),
    }
}

/// Имена доступных устройств ввода. Пустой список — не ошибка: микрофона
/// может не быть вовсе, и перечисление обязано это пережить, а не упасть.
///
/// Имя — единственный идентификатор, который даёт `cpal`.
/// ponytail: имена не стабильны между переподключениями у части устройств;
/// чинится переходом на CoreAudio device UID, если начнёт мешать.
pub fn list_input_devices() -> Vec<String> {
    input_device_names(&cpal::default_host())
}

/// Имя нынешнего системного умолчания — только чтобы показать его подписью
/// рядом с пунктом «System default». Выбором оно не становится.
pub fn default_input_device_name() -> Option<String> {
    cpal::default_host()
        .default_input_device()
        .and_then(|d| d.name().ok())
}

fn input_device_names(host: &cpal::Host) -> Vec<String> {
    match host.input_devices() {
        Ok(devices) => devices.filter_map(|d| d.name().ok()).collect(),
        // Хост может отказать в перечислении (нет прав, нет аудиоподсистемы) —
        // это пустой список, а не паника.
        Err(e) => {
            eprintln!("не удалось перечислить устройства ввода: {e}");
            Vec::new()
        }
    }
}

fn find_input_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.input_devices()
        .ok()?
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
}

/// Пишет с микрофона на выделенном потоке: `cpal::Stream` не `Send`,
/// поэтому он не может жить в состоянии Tauri напрямую.
pub struct Recorder {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<anyhow::Result<Vec<f32>>>,
    /// Пики по чанкам, копятся в колбэке и вычерпываются `drain_peaks`.
    /// Живёт в `Arc`, общем с потоком записи: доступ на чтение/очистку не
    /// требует владения `Recorder` и работает, пока запись идёт.
    peaks: Arc<Mutex<Vec<f32>>>,
    /// Имя сохранённого устройства, которого не нашлось: запись пошла с
    /// умолчания. `None` — писали именно с того, что просили. Молча подменять
    /// микрофон нельзя, поэтому признак поднимается наверх, а не теряется.
    fell_back_from: Option<String>,
}

impl Recorder {
    /// `preferred` — сохранённое имя устройства; `None` = следовать за
    /// системным умолчанием. Устройство выбирается один раз, на старте
    /// записи: менять его посреди записи нельзя, выбор применяется к следующей.
    pub fn start(preferred: Option<String>) -> anyhow::Result<Self> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<anyhow::Result<Vec<f32>>>();
        // Первым сообщением поток отдаёт не только «удалось/не удалось», но и
        // имя устройства, которого не нашлось, — иначе признак подмены
        // микрофона остался бы внутри потока записи.
        let (init_tx, init_rx) = mpsc::channel::<anyhow::Result<Option<String>>>();
        let peaks: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let peaks_thread = peaks.clone();

        std::thread::spawn(move || {
            let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

            let built = (|| -> anyhow::Result<(cpal::Stream, u32, u16, Option<String>)> {
                let host = cpal::default_host();
                let choice = choose_device(preferred.as_deref(), &input_device_names(&host));
                // Named всё ещё может не открыться: между перечислением и
                // открытием устройство успевают отключить. Это тот же случай,
                // что MissingFallback, и обрабатывается так же.
                let named = match &choice {
                    DeviceChoice::Named(name) => find_input_device(&host, name),
                    _ => None,
                };
                let (device, fell_back_from) = match named {
                    Some(device) => (device, None),
                    None => {
                        let device = host
                            .default_input_device()
                            .ok_or_else(|| anyhow!("no input device found"))?;
                        let missing = match choice {
                            DeviceChoice::SystemDefault => None,
                            DeviceChoice::Named(name) | DeviceChoice::MissingFallback(name) => {
                                Some(name)
                            }
                        };
                        (device, missing)
                    }
                };
                let config = device
                    .default_input_config()
                    .context("couldn't read input device configuration")?;
                let sample_rate = config.sample_rate().0;
                let channels = config.channels();
                let sink = buffer.clone();
                let peaks_sink = peaks_thread.clone();
                // ponytail: поддерживаем только f32-вход, добавить ветки
                // i16/u16, если появится устройство, которое на этом падает.
                let stream = device
                    .build_input_stream(
                        &config.into(),
                        move |data: &[f32], _| {
                            // Только арифметика и запись в буфер — колбэк в реальном
                            // времени, аллокации и IPC здесь недопустимы.
                            let peak = peak_amplitude(data);
                            if let Ok(mut b) = sink.lock() {
                                b.extend_from_slice(data);
                            }
                            if let Ok(mut p) = peaks_sink.lock() {
                                p.push(peak);
                            }
                        },
                        |err| eprintln!("ошибка потока микрофона: {err}"),
                        None,
                    )
                    .context("couldn't open the microphone stream")?;
                stream.play().context("couldn't start the microphone stream")?;
                Ok((stream, sample_rate, channels, fell_back_from))
            })();

            let (stream, sample_rate, channels) = match built {
                Ok((stream, sample_rate, channels, fell_back_from)) => {
                    let _ = init_tx.send(Ok(fell_back_from));
                    (stream, sample_rate, channels)
                }
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };

            // Блокируемся, пока не попросят остановиться (или пока отправитель не умрёт).
            let _ = stop_rx.recv();
            drop(stream);

            // M8: отравленный мьютекс — это потерянное аудио, а не тишина.
            // unwrap_or_default() раньше превращал его в пустую «успешную»
            // запись, которая ниже по потоку выглядела как «слишком короткая
            // запись» — сообщение врало, а виноватым выставляли пользователя.
            let raw = match buffer.lock() {
                Ok(b) => b.clone(),
                Err(_) => {
                    let _ = done_tx.send(Err(anyhow!("audio buffer was poisoned — recording lost")));
                    return;
                }
            };
            let mono = to_mono(&raw, channels);
            let _ = done_tx.send(Ok(resample_to_16k(&mono, sample_rate)));
        });

        let fell_back_from = init_rx.recv().context("recording thread didn't start")??;
        Ok(Self {
            stop_tx,
            done_rx,
            peaks,
            fell_back_from,
        })
    }

    /// Имя сохранённого устройства, которого не нашлось. `Some` — писали не с
    /// того микрофона, который выбирал пользователь, и он должен это узнать.
    pub fn fell_back_from(&self) -> Option<&str> {
        self.fell_back_from.as_deref()
    }

    /// Забирает пики, накопленные с прошлого вызова, и очищает буфер.
    pub fn drain_peaks(&self) -> Vec<f32> {
        match self.peaks.lock() {
            Ok(mut p) => std::mem::take(&mut *p),
            // Отравленный мьютекс пиков — не повод терять запись целиком,
            // как в случае с основным буфером; просто нечего вернуть на этот тик.
            Err(_) => Vec::new(),
        }
    }

    /// Останавливает запись и отдаёт 16 кГц моно f32.
    pub fn stop(self) -> anyhow::Result<Vec<f32>> {
        let _ = self.stop_tx.send(());
        self.done_rx
            .recv()
            .context("recording thread finished without a result")?
    }
}

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

    /// T2: длина не кратна числу каналов. `chunks_exact` молча выбрасывает
    /// хвостовой неполный кадр — проверяем, что это ожидаемое поведение,
    /// а не забытый сэмпл.
    #[test]
    fn to_mono_drops_incomplete_trailing_frame() {
        // 5 сэмплов на 2 канала: последний сэмпл не образует полный кадр.
        let input = [0.0_f32, 1.0, -1.0, 1.0, 0.5];
        assert_eq!(to_mono(&input, 2), vec![0.5, 0.0]);
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

    /// T1: все прежние тесты гоняли константный сигнал, на котором
    /// перестановка, дублирование или пропуск сэмплов остались бы
    /// незамеченными. Возрастающая рампа ловит именно такой баг.
    #[test]
    fn resample_preserves_monotonic_ramp() {
        let input: Vec<f32> = (0..48_000).map(|i| i as f32).collect();
        let out = resample_to_16k(&input, 48_000);
        assert_eq!(out.len(), 16_000);
        // Возрастающий вход обязан остаться возрастающим: перестановка,
        // дублирование или пропуск сэмплов это нарушат.
        assert!(out.windows(2).all(|w| w[1] > w[0]));
        // Первое окно усредняет сэмплы 0,1,2 → 1.0
        assert!((out[0] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn peak_of_empty_is_zero() {
        assert_eq!(peak_amplitude(&[]), 0.0);
    }

    #[test]
    fn peak_ignores_sign() {
        assert_eq!(peak_amplitude(&[-0.8, 0.3]), 0.8);
    }

    #[test]
    fn peak_of_silence_is_zero() {
        assert_eq!(peak_amplitude(&[0.0, 0.0, 0.0]), 0.0);
    }

    #[test]
    fn gain_of_one_changes_nothing() {
        let input = vec![-0.5_f32, 0.0, 0.25, 0.9];
        assert_eq!(apply_gain(&input, 1.0), input);
    }

    #[test]
    fn gain_raises_peak_proportionally() {
        let input = [0.02_f32, -0.04, 0.0];
        let out = apply_gain(&input, 5.0);
        assert!((peak_amplitude(&out) - 0.2).abs() < 1e-6);
        // Знак и нули сохраняются — усиление это множитель, а не выпрямитель.
        assert!((out[1] + 0.2).abs() < 1e-6);
        assert_eq!(out[2], 0.0);
    }

    #[test]
    fn gain_clamps_to_unit_magnitude() {
        let out = apply_gain(&[0.5_f32, -0.5, 0.05], 10.0);
        assert_eq!(out[0], 1.0);
        assert_eq!(out[1], -1.0);
        assert!((out[2] - 0.5).abs() < 1e-6);
        assert!(out.iter().all(|s| s.abs() <= 1.0));
    }

    /// Множитель из руками поправленного settings.json не должен уводить
    /// запись в сплошной клиппинг — он зажимается в допустимый диапазон.
    #[test]
    fn gain_multiplier_itself_is_clamped() {
        // 1000× зажимается до MAX_GAIN=10 — 0.05 * 10 = 0.5, а не единица.
        let out = apply_gain(&[0.05_f32], 1000.0);
        assert!((out[0] - 0.5).abs() < 1e-6);
        // Ниже MIN_GAIN тоже не пускаем: 0.0 превратил бы запись в тишину.
        let out = apply_gain(&[0.4_f32], 0.0);
        assert!((out[0] - 0.2).abs() < 1e-6);
        // NaN — не повод паниковать в clamp: откатываемся к 1.0.
        assert_eq!(apply_gain(&[0.4_f32], f32::NAN), vec![0.4_f32]);
    }

    #[test]
    fn gain_handles_empty_input() {
        assert!(apply_gain(&[], 4.0).is_empty());
        assert!(apply_gain(&[], 1.0).is_empty());
    }

    #[test]
    fn concat_length_is_the_sum_of_lengths() {
        let prev = vec![0.1_f32; 1600];
        let next = vec![0.2_f32; 800];
        let joined = concat_pcm(&prev, &next);
        assert_eq!(joined.len(), prev.len() + next.len());
        // Порядок принципиален: добавка идёт ПОСЛЕ прежнего, а не наоборот.
        assert_eq!(joined[0], 0.1);
        assert_eq!(joined[1600], 0.2);
    }

    #[test]
    fn concat_with_empty_sides() {
        assert_eq!(concat_pcm(&[], &[0.3_f32, 0.4]), vec![0.3_f32, 0.4]);
        assert_eq!(concat_pcm(&[0.3_f32, 0.4], &[]), vec![0.3_f32, 0.4]);
        assert!(concat_pcm(&[], &[]).is_empty());
    }

    fn devices() -> Vec<String> {
        vec![
            "MacBook Pro Microphone".to_string(),
            "iPhone Microphone".to_string(),
        ]
    }

    /// «System default» — это следование за системой, а не имя нынешнего
    /// умолчания: сохранённого имени нет вовсе, и подставлять его нельзя.
    #[test]
    fn no_saved_choice_follows_the_system_default() {
        assert_eq!(choose_device(None, &devices()), DeviceChoice::SystemDefault);
    }

    #[test]
    fn saved_device_that_is_present_is_used_as_is() {
        assert_eq!(
            choose_device(Some("iPhone Microphone"), &devices()),
            DeviceChoice::Named("iPhone Microphone".to_string())
        );
    }

    /// Главный случай брифа: iPhone ушёл из зоны. Пишем с умолчания, но
    /// признак подмены обязан подняться наверх вместе с именем — иначе
    /// человек будет думать, что диктует в iPhone.
    #[test]
    fn missing_saved_device_falls_back_and_says_which_one_is_gone() {
        assert_eq!(
            choose_device(Some("iPhone Microphone"), &["MacBook Pro Microphone".to_string()]),
            DeviceChoice::MissingFallback("iPhone Microphone".to_string())
        );
    }

    /// Устройств ввода нет вовсе — решение всё равно принимается и не
    /// паникует. Отсутствие микрофона ловится ниже, на открытии потока.
    #[test]
    fn choice_survives_an_empty_device_list() {
        assert_eq!(choose_device(None, &[]), DeviceChoice::SystemDefault);
        assert_eq!(
            choose_device(Some("iPhone Microphone"), &[]),
            DeviceChoice::MissingFallback("iPhone Microphone".to_string())
        );
    }

    /// Совпадение имени — точное. Устройство «iPhone Microphone (2)» это
    /// другое устройство, а не то же самое: подставить его молча значило бы
    /// писать не с того микрофона и ничего об этом не сказать.
    #[test]
    fn device_names_match_exactly_not_by_prefix() {
        assert_eq!(
            choose_device(
                Some("iPhone Microphone"),
                &["iPhone Microphone (2)".to_string()]
            ),
            DeviceChoice::MissingFallback("iPhone Microphone".to_string())
        );
    }

    /// Перечисление не должно падать в среде без микрофона и без прав на
    /// него — здесь именно такая (CI, машина без аудиовхода).
    #[test]
    fn enumeration_does_not_panic_without_devices() {
        let names = list_input_devices();
        // Содержимое зависит от машины; проверяем, что вызов вообще жив и что
        // имена не пустые строки, если что-то нашлось.
        assert!(names.iter().all(|n| !n.is_empty()));
    }

    /// iPhone обычно отдаёт 48 кГц, встроенный микрофон — 44.1, а whisper
    /// принимает только 16 кГц. Путь ресемплинга общий для любого выбранного
    /// устройства, а не только для встроенного: проверяем ровно те частоты,
    /// которые дают реальные устройства с этого выбора.
    #[test]
    fn resampling_works_for_every_rate_a_selected_device_can_give() {
        for (rate, channels) in [(48_000_u32, 1_u16), (48_000, 2), (44_100, 2), (16_000, 1)] {
            // Секунда возрастающей рампы в чередующихся каналах.
            let frames = rate as usize;
            let raw: Vec<f32> = (0..frames * channels as usize)
                .map(|i| i as f32 / (frames * channels as usize) as f32)
                .collect();
            let mono = to_mono(&raw, channels);
            assert_eq!(mono.len(), frames, "моно-сведение при {rate} Гц / {channels} кан.");
            let out = resample_to_16k(&mono, rate);
            assert_eq!(out.len(), WHISPER_SAMPLE_RATE as usize, "{rate} Гц → 16 кГц");
            // Возрастающий вход остаётся возрастающим — сэмплы не переставлены
            // и не продублированы.
            assert!(out.windows(2).all(|w| w[1] > w[0]), "монотонность при {rate} Гц");
        }
    }
}
