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

/// Пишет с микрофона на выделенном потоке: `cpal::Stream` не `Send`,
/// поэтому он не может жить в состоянии Tauri напрямую.
pub struct Recorder {
    stop_tx: mpsc::Sender<()>,
    done_rx: mpsc::Receiver<anyhow::Result<Vec<f32>>>,
}

impl Recorder {
    pub fn start() -> anyhow::Result<Self> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (done_tx, done_rx) = mpsc::channel::<anyhow::Result<Vec<f32>>>();
        let (init_tx, init_rx) = mpsc::channel::<anyhow::Result<()>>();

        std::thread::spawn(move || {
            let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));

            let built = (|| -> anyhow::Result<(cpal::Stream, u32, u16)> {
                let device = cpal::default_host()
                    .default_input_device()
                    .ok_or_else(|| anyhow!("no input device found"))?;
                let config = device
                    .default_input_config()
                    .context("couldn't read input device configuration")?;
                let sample_rate = config.sample_rate().0;
                let channels = config.channels();
                let sink = buffer.clone();
                // ponytail: поддерживаем только f32-вход, добавить ветки
                // i16/u16, если появится устройство, которое на этом падает.
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
                    .context("couldn't open the microphone stream")?;
                stream.play().context("couldn't start the microphone stream")?;
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

        init_rx.recv().context("recording thread didn't start")??;
        Ok(Self { stop_tx, done_rx })
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
}
