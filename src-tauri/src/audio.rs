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

/// Частота среза high-pass фильтра. Ниже 80 Гц речи практически нет (даже у
/// низкого мужского голоса основной тон выше), а гул помещения, вентиляторы
/// и стук по столу живут именно там.
pub const HIGH_PASS_CUTOFF_HZ: f32 = 80.0;

/// Срезает низкочастотный гул перед VAD и whisper. Однополюсный RC-фильтр:
/// y[n] = a·(y[n-1] + x[n] - x[n-1]) — пара сложений на сэмпл.
/// ponytail: первый порядок, пологий спад 6 дБ/октаву; заменить на биквад
/// Баттерворта, если гул будет просачиваться.
///
/// Как и apply_gain — применяется к КОПИИ, уходящей в распознавание; сырая
/// запись (Play, история) и дорожка уровня фильтра не видят.
pub fn high_pass(pcm: &[f32], sample_rate: u32, cutoff_hz: f32) -> Vec<f32> {
    if pcm.is_empty() || cutoff_hz <= 0.0 || sample_rate == 0 {
        return pcm.to_vec();
    }
    let dt = 1.0 / sample_rate as f32;
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff_hz);
    let a = rc / (rc + dt);
    let mut out = Vec::with_capacity(pcm.len());
    // y[0] = 0: постоянная составляющая гасится с первого сэмпла, а не
    // протекает начальным скачком.
    let mut prev_x = pcm[0];
    let mut prev_y = 0.0f32;
    out.push(0.0);
    for &x in &pcm[1..] {
        let y = a * (prev_y + x - prev_x);
        prev_x = x;
        prev_y = y;
        out.push(y);
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

/// Потолок накопленного звука одной сессии — десять минут.
///
/// ЗАЧЕМ. Дозапись продолжает предыдущий PCM (`concat_pcm`), и до этого
/// потолка её ничто не ограничивало: 16 кГц моно f32 — это 64 КБ в секунду,
/// то есть час диктовки с дозаписями держал бы в памяти ~230 МБ, а ещё
/// столько же ненадолго возникало бы копией в момент каждой склейки.
///
/// ПОЧЕМУ ДЕСЯТЬ МИНУТ. Это ~38 МБ — на порядок больше самой длинной
/// правдоподобной диктовки (десять минут непрерывной речи это примерно
/// полторы тысячи слов) и всё ещё небольшая величина для памяти. Больше
/// смысла не имеет: текст такой длины давно пора вставить и продолжать в
/// документе, а не в панели.
///
/// КАК ДЕРЖИТСЯ. Только остановкой записи и отказом начать новую дозапись
/// (см. `commands::spawn_level_emitter` и `commands::begin_recording`) —
/// НИКОГДА обрезкой уже накопленного. Обрезка выбросила бы звук, из которого
/// уже получен текст: `Play` и форма волны перестали бы соответствовать
/// тому, что лежит в редакторе, причём молча. Отказ, о котором сказано
/// вслух, резче, но честен.
///
/// Единица здесь — сэмплы 16 кГц: в них живёт накопленный PCM. Десять минут
/// это 9 600 000 сэмплов, то есть 38.4 МБ. Число минут повторено словами в
/// тексте, который видит человек (`commands::SESSION_LIMIT_*`) — менять их
/// вместе.
pub const MAX_SESSION_SAMPLES: usize = 600 * WHISPER_SAMPLE_RATE as usize;

/// Достигнут ли потолок сессии: уже накопленные сэмплы плюс секунды, которые
/// пишутся прямо сейчас. Чистая функция — проверяется без микрофона и часов.
///
/// Секунды, а не сэмплы, для идущей записи намеренно: длина буфера внутри
/// `Recorder` живёт на частоте устройства (44.1/48 кГц) и за мьютексом, а
/// потолок здесь — про память, для которой достаточно настенного времени.
pub fn session_limit_reached(accumulated_samples: usize, current_secs: f32) -> bool {
    // NaN и отрицательное время (системные часы умеют прыгать назад) — это
    // «пока ничего не записано», а не повод срабатывать; бесконечность
    // зажимается потолком, а не превращается в мусор при `as usize`.
    let secs = if current_secs.is_nan() || current_secs <= 0.0 {
        0.0
    } else {
        current_secs
    };
    let current =
        (secs * WHISPER_SAMPLE_RATE as f32).min(MAX_SESSION_SAMPLES as f32) as usize;
    accumulated_samples.saturating_add(current) >= MAX_SESSION_SAMPLES
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
            log::warn!("не удалось перечислить устройства ввода: {e}");
            Vec::new()
        }
    }
}

fn find_input_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.input_devices()
        .ok()?
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
}

/// Живой захват звука: обычный поток cpal или Voice Processing I/O.
/// Существует только ради времени жизни — пока значение живо, звук пишется;
/// drop останавливает захват. Живёт целиком на потоке записи.
enum ActiveCapture {
    Cpal(cpal::Stream),
    #[cfg(target_os = "macos")]
    Vpio(RunningVpio),
}

/// Тёплый VPIO-граф между записями. Сборка графа — сотни миллисекунд, и
/// раньше она происходила на КАЖДОЕ нажатие хоткея, между нажатием и
/// появлением окна (begin_recording намеренно идёт до show_overlay, чтобы не
/// резать первое слово). Теперь граф собирается один раз (или при смене
/// устройств) и дальше только запускается/останавливается.
#[cfg(target_os = "macos")]
static VPIO_ENGINE: Mutex<Option<vpio::Engine>> = Mutex::new(None);

/// Идущая VPIO-запись: на drop останавливает захват и возвращает тёплый
/// юнит в кэш — следующий старт записи обойдётся в start/stop, а не в
/// пересборку графа.
#[cfg(target_os = "macos")]
struct RunningVpio(Option<vpio::Engine>);

#[cfg(target_os = "macos")]
impl Drop for RunningVpio {
    fn drop(&mut self) {
        if let Some(engine) = self.0.take() {
            engine.end();
            *VPIO_ENGINE.lock().unwrap() = Some(engine);
        }
    }
}

/// Voice Processing I/O на сырых вызовах CoreAudio.
///
/// Почему не через обёртку coreaudio-rs: её `AudioUnit::new` инициализирует
/// юнит сразу (а EnableIO/устройство/формат ставятся только до
/// инициализации), а `set_input_callback` опрашивает
/// kAudioDevicePropertyBufferFrameSize, которого у VPIO нет, — оба шага
/// роняли подъём эхоподавления («Initialized», «Invalid property» в логах).
/// Сырой путь ставит свойства в правильном порядке и ничего лишнего не
/// спрашивает.
#[cfg(target_os = "macos")]
mod vpio {
    use super::{peak_amplitude, WHISPER_SAMPLE_RATE};
    use anyhow::anyhow;
    use coreaudio::sys as ca;
    use std::os::raw::c_void;
    use std::sync::{Arc, Mutex};

    /// Куда летят сэмплы ТЕКУЩЕЙ записи. `None` — юнит собран, но запись не
    /// идёт (тёплый простой между записями): колбэк просто выбрасывает кадр.
    type Sinks = (Arc<Mutex<Vec<f32>>>, Arc<Mutex<Vec<f32>>>);

    /// Контекст input-колбэка: живёт в Box за сырым указателем ровно столько,
    /// сколько жив юнит (см. Drop у Engine).
    struct Ctx {
        unit: ca::AudioUnit,
        sinks: Mutex<Option<Sinks>>,
        scratch: Vec<f32>,
    }

    /// Собранный VPIO-граф. Сборка (создание компонента + свойства) дорогая,
    /// поэтому юнит живёт МЕЖДУ записями. Инициализация — ленивая, один раз
    /// на первом begin, и дальше НЕ снимается: AudioUnitInitialize у VPIO
    /// стоит сотни миллисекунд, и плата за него на каждом старте записи —
    /// это ровно та задержка «нажал хоткей → ON AIR», на которую жаловался
    /// пользователь. Приглушение чужого звука инициализированным юнитом в
    /// простое держит на нуле дакинг-конфигурация Min (см. build); если на
    /// какой-то системе простой всё же начнёт глушить звук — возвращать
    /// uninitialize в end, но с отложенным таймером, а не сразу.
    /// Пока юнит остановлен, микрофон не захватывается и индикатор системы
    /// не горит.
    pub struct Engine {
        unit: ca::AudioUnit,
        ctx: *mut Ctx,
        initialized: std::sync::atomic::AtomicBool,
        pub input_device: ca::AudioDeviceID,
        pub output_device: ca::AudioDeviceID,
    }

    // Хендлы AudioUnit безопасно дёргать с любого потока (API CoreAudio
    // потокобезопасен для start/stop/dispose), а ctx жив, пока жив Engine.
    // Send нужен, чтобы держать тёплый юнит в глобальном Mutex между
    // потоками записи (каждая запись — свой поток, см. Recorder::start).
    unsafe impl Send for Engine {}

    impl Engine {
        /// Начинает запись: при первом вызове инициализирует юнит (лениво,
        /// см. комментарий у Engine), подставляет приёмники и запускает
        /// захват. Замеры в лог — числа, не содержимое.
        pub fn begin(
            &self,
            buffer: Arc<Mutex<Vec<f32>>>,
            peaks: Arc<Mutex<Vec<f32>>>,
        ) -> anyhow::Result<()> {
            use std::sync::atomic::Ordering;
            unsafe {
                if !self.initialized.load(Ordering::Acquire) {
                    let t = std::time::Instant::now();
                    check(ca::AudioUnitInitialize(self.unit), "initialize vpio")?;
                    self.initialized.store(true, Ordering::Release);
                    log::info!("vpio: инициализация {} мс", t.elapsed().as_millis());
                }
                if let Ok(mut s) = (*self.ctx).sinks.lock() {
                    *s = Some((buffer, peaks));
                }
                let t = std::time::Instant::now();
                let started = check(ca::AudioOutputUnitStart(self.unit), "start vpio");
                if started.is_ok() {
                    log::info!("vpio: старт захвата {} мс", t.elapsed().as_millis());
                }
                started
            }
        }

        /// Прогрев: инициализирует юнит заранее (без запуска захвата), чтобы
        /// ПЕРВОЕ нажатие хоткея не платило и за инициализацию. Захват не
        /// идёт, микрофон не горит; приглушение чужого звука держит на нуле
        /// дакинг Min (см. build).
        pub fn prewarm_init(&self) {
            use std::sync::atomic::Ordering;
            if self.initialized.load(Ordering::Acquire) {
                return;
            }
            unsafe {
                let t = std::time::Instant::now();
                if check(ca::AudioUnitInitialize(self.unit), "initialize vpio").is_ok() {
                    self.initialized.store(true, Ordering::Release);
                    log::info!("vpio: прогрев-инициализация {} мс", t.elapsed().as_millis());
                }
            }
        }

        /// Останавливает захват. Юнит остаётся инициализированным — см.
        /// комментарий у Engine: повторная инициализация стоила бы сотни
        /// миллисекунд на каждом старте записи.
        pub fn end(&self) {
            unsafe {
                ca::AudioOutputUnitStop(self.unit);
                if let Ok(mut s) = (*self.ctx).sinks.lock() {
                    *s = None;
                }
            }
        }
    }

    impl Drop for Engine {
        fn drop(&mut self) {
            unsafe {
                ca::AudioOutputUnitStop(self.unit);
                ca::AudioUnitUninitialize(self.unit);
                ca::AudioComponentInstanceDispose(self.unit);
                // Колбэк уже не позовут — юнит остановлен и распущен.
                drop(Box::from_raw(self.ctx));
            }
        }
    }

    unsafe extern "C" fn input_proc(
        in_ref_con: *mut c_void,
        io_action_flags: *mut ca::AudioUnitRenderActionFlags,
        in_time_stamp: *const ca::AudioTimeStamp,
        in_bus_number: u32,
        in_number_frames: u32,
        _io_data: *mut ca::AudioBufferList,
    ) -> ca::OSStatus {
        let ctx = &mut *(in_ref_con as *mut Ctx);
        let frames = in_number_frames as usize;
        if ctx.scratch.len() < frames {
            // Аллокация в realtime-колбэке — зло, но случается максимум
            // пару раз на старте, пока не встретился самый крупный срез.
            ctx.scratch.resize(frames, 0.0);
        }
        let mut abl = ca::AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [ca::AudioBuffer {
                mNumberChannels: 1,
                mDataByteSize: (frames * std::mem::size_of::<f32>()) as u32,
                mData: ctx.scratch.as_mut_ptr() as *mut c_void,
            }],
        };
        let status = ca::AudioUnitRender(
            ctx.unit,
            io_action_flags,
            in_time_stamp,
            in_bus_number,
            in_number_frames,
            &mut abl,
        );
        if status != 0 {
            return status;
        }
        // Дальше — как в cpal-колбэке: только арифметика и запись в буфер.
        // Приёмников нет (тёплый простой между записями) — кадр выбрасываем.
        let chunk = &ctx.scratch[..frames];
        let peak = peak_amplitude(chunk);
        if let Ok(s) = ctx.sinks.lock() {
            if let Some((buffer, peaks)) = s.as_ref() {
                if let Ok(mut b) = buffer.lock() {
                    b.extend_from_slice(chunk);
                }
                if let Ok(mut p) = peaks.lock() {
                    p.push(peak);
                }
            }
        }
        0
    }

    /// Render-колбэк выходного элемента — тишина. VPIO полнодуплексный и
    /// отказывается инициализироваться (kAudioUnitErr_FailedInitialization,
    /// -10875 в логах) с выключенным выходом: эхоподавлению нужен живой
    /// render-путь. Играть нам нечего, поэтому отдаём нули.
    unsafe extern "C" fn silence_proc(
        _in_ref_con: *mut c_void,
        _io_action_flags: *mut ca::AudioUnitRenderActionFlags,
        _in_time_stamp: *const ca::AudioTimeStamp,
        _in_bus_number: u32,
        _in_number_frames: u32,
        io_data: *mut ca::AudioBufferList,
    ) -> ca::OSStatus {
        if !io_data.is_null() {
            let abl = &mut *io_data;
            let bufs = std::slice::from_raw_parts_mut(
                abl.mBuffers.as_mut_ptr(),
                abl.mNumberBuffers as usize,
            );
            for b in bufs {
                if !b.mData.is_null() {
                    std::ptr::write_bytes(b.mData as *mut u8, 0, b.mDataByteSize as usize);
                }
            }
        }
        0
    }

    fn check(status: ca::OSStatus, what: &str) -> anyhow::Result<()> {
        if status == 0 {
            Ok(())
        } else {
            // Код OSStatus в тексте — единственная диагностика, которая
            // доедет до лога при сбое на конкретном устройстве.
            Err(anyhow!("{what}: OSStatus {status}"))
        }
    }

    /// Собирает и инициализирует VPIO-граф, НЕ запуская захват: вход с
    /// `input_device`, выход (обязательный для инициализации, см.
    /// silence_proc) — на `output_device`. Запись включает Engine::begin;
    /// сэмплы летят сразу в формате whisper (16 кГц моно f32 — конвертирует
    /// сам юнит).
    pub fn build(
        input_device: ca::AudioDeviceID,
        output_device: ca::AudioDeviceID,
    ) -> anyhow::Result<Engine> {
        unsafe {
            let desc = ca::AudioComponentDescription {
                componentType: ca::kAudioUnitType_Output,
                componentSubType: ca::kAudioUnitSubType_VoiceProcessingIO,
                componentManufacturer: ca::kAudioUnitManufacturer_Apple,
                componentFlags: 0,
                componentFlagsMask: 0,
            };
            let comp = ca::AudioComponentFindNext(std::ptr::null_mut(), &desc);
            if comp.is_null() {
                return Err(anyhow!("voice processing component not found"));
            }
            let mut unit: ca::AudioUnit = std::ptr::null_mut();
            check(ca::AudioComponentInstanceNew(comp, &mut unit), "create vpio")?;

            // Любой сбой ниже обязан прибрать уже созданный юнит и контекст.
            let built = (|| -> anyhow::Result<*mut Ctx> {
                let on: u32 = 1;
                // Включены ОБА элемента: вход (1) — микрофон, выход (0) —
                // обязательный render-путь эхоподавления (см. silence_proc).
                // Всё ДО AudioUnitInitialize: после неё эти свойства не
                // принимаются.
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioOutputUnitProperty_EnableIO,
                        ca::kAudioUnitScope_Input,
                        1,
                        &on as *const _ as *const c_void,
                        4,
                    ),
                    "enable vpio input",
                )?;
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioOutputUnitProperty_EnableIO,
                        ca::kAudioUnitScope_Output,
                        0,
                        &on as *const _ as *const c_void,
                        4,
                    ),
                    "enable vpio output",
                )?;
                // Устройства — по элементам: вход на element 1, выход на 0.
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioOutputUnitProperty_CurrentDevice,
                        ca::kAudioUnitScope_Global,
                        1,
                        &input_device as *const _ as *const c_void,
                        std::mem::size_of::<ca::AudioDeviceID>() as u32,
                    ),
                    "bind vpio to input device",
                )?;
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioOutputUnitProperty_CurrentDevice,
                        ca::kAudioUnitScope_Global,
                        0,
                        &output_device as *const _ as *const c_void,
                        std::mem::size_of::<ca::AudioDeviceID>() as u32,
                    ),
                    "bind vpio to output device",
                )?;
                let asbd = ca::AudioStreamBasicDescription {
                    mSampleRate: WHISPER_SAMPLE_RATE as f64,
                    mFormatID: ca::kAudioFormatLinearPCM,
                    mFormatFlags: ca::kAudioFormatFlagIsFloat | ca::kAudioFormatFlagIsPacked,
                    mBytesPerPacket: 4,
                    mFramesPerPacket: 1,
                    mBytesPerFrame: 4,
                    mChannelsPerFrame: 1,
                    mBitsPerChannel: 32,
                    mReserved: 0,
                };
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioUnitProperty_StreamFormat,
                        ca::kAudioUnitScope_Output,
                        1,
                        &asbd as *const _ as *const c_void,
                        std::mem::size_of::<ca::AudioStreamBasicDescription>() as u32,
                    ),
                    "set vpio capture format",
                )?;
                // Тот же клиентский формат на render-стороне: silence_proc
                // отдаёт нули, формат важен только для согласованности.
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioUnitProperty_StreamFormat,
                        ca::kAudioUnitScope_Input,
                        0,
                        &asbd as *const _ as *const c_void,
                        std::mem::size_of::<ca::AudioStreamBasicDescription>() as u32,
                    ),
                    "set vpio render format",
                )?;
                let silence_cb = ca::AURenderCallbackStruct {
                    inputProc: Some(silence_proc),
                    inputProcRefCon: std::ptr::null_mut(),
                };
                check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioUnitProperty_SetRenderCallback,
                        ca::kAudioUnitScope_Input,
                        0,
                        &silence_cb as *const _ as *const c_void,
                        std::mem::size_of::<ca::AURenderCallbackStruct>() as u32,
                    ),
                    "set vpio render callback",
                )?;
                let ctx = Box::into_raw(Box::new(Ctx {
                    unit,
                    sinks: Mutex::new(None),
                    scratch: vec![0.0; 8192],
                }));
                let cb = ca::AURenderCallbackStruct {
                    inputProc: Some(input_proc),
                    inputProcRefCon: ctx as *mut c_void,
                };
                let steps = check(
                    ca::AudioUnitSetProperty(
                        unit,
                        ca::kAudioOutputUnitProperty_SetInputCallback,
                        ca::kAudioUnitScope_Global,
                        0,
                        &cb as *const _ as *const c_void,
                        std::mem::size_of::<ca::AURenderCallbackStruct>() as u32,
                    ),
                    "set vpio input callback",
                );
                if let Err(e) = steps {
                    drop(Box::from_raw(ctx));
                    return Err(e);
                }

                // Приглушение ЧУЖОГО звука на минимум: по умолчанию macOS в
                // голосовом режиме притапливает остальной вывод (как
                // FaceTime), а пользователь во время диктовки продолжает
                // слушать своё видео — глушить его не наше дело,
                // эхоподавлению уровень дакинга не нужен. Свойство появилось
                // в macOS 14 — на старых системах просто не применится
                // (best effort, в лог и дальше). Констант нет в coreaudio-sys,
                // поэтому объявлены локально по AudioUnitProperties.h.
                const OTHER_AUDIO_DUCKING_CONFIGURATION: u32 = 2108;
                const DUCKING_LEVEL_MIN: u32 = 10;
                #[repr(C)]
                struct DuckingConfig {
                    enable_advanced_ducking: u8, // Boolean
                    ducking_level: u32,
                }
                let ducking = DuckingConfig {
                    enable_advanced_ducking: 0,
                    ducking_level: DUCKING_LEVEL_MIN,
                };
                if let Err(e) = check(
                    ca::AudioUnitSetProperty(
                        unit,
                        OTHER_AUDIO_DUCKING_CONFIGURATION,
                        ca::kAudioUnitScope_Global,
                        0,
                        &ducking as *const _ as *const c_void,
                        std::mem::size_of::<DuckingConfig>() as u32,
                    ),
                    "set vpio ducking",
                ) {
                    log::warn!("не удалось убрать приглушение чужого звука: {e}");
                }

                // AudioUnitInitialize здесь НЕ зовётся — см. Engine::begin.
                Ok(ctx)
            })();

            match built {
                Ok(ctx) => Ok(Engine {
                    unit,
                    ctx,
                    initialized: std::sync::atomic::AtomicBool::new(false),
                    input_device,
                    output_device,
                }),
                Err(e) => {
                    ca::AudioUnitUninitialize(unit);
                    ca::AudioComponentInstanceDispose(unit);
                    Err(e)
                }
            }
        }
    }
}

/// Захват через cpal — путь по умолчанию без эхоподавления. Возвращает
/// (живой поток, частота, каналы, имя устройства, которого не нашлось).
fn build_cpal_capture(
    preferred: Option<&str>,
    buffer: Arc<Mutex<Vec<f32>>>,
    peaks: Arc<Mutex<Vec<f32>>>,
) -> anyhow::Result<(ActiveCapture, u32, u16, Option<String>)> {
    let host = cpal::default_host();
    // Перечисление устройств — десятки-сотни миллисекунд (с Bluetooth
    // дороже), а нужно оно только чтобы проверить, на месте ли ЗАКРЕПЛЁННЫЙ
    // микрофон. «System default» обходится без опроса вовсе.
    let choice = match preferred {
        None => DeviceChoice::SystemDefault,
        Some(_) => choose_device(preferred, &input_device_names(&host)),
    };
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
                DeviceChoice::Named(name) | DeviceChoice::MissingFallback(name) => Some(name),
            };
            (device, missing)
        }
    };
    let config = device
        .default_input_config()
        .context("couldn't read input device configuration")?;
    let sample_rate = config.sample_rate().0;
    let channels = config.channels();
    // ponytail: поддерживаем только f32-вход, добавить ветки
    // i16/u16, если появится устройство, которое на этом падает.
    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                // Только арифметика и запись в буфер — колбэк в реальном
                // времени, аллокации и IPC здесь недопустимы.
                let peak = peak_amplitude(data);
                if let Ok(mut b) = buffer.lock() {
                    b.extend_from_slice(data);
                }
                if let Ok(mut p) = peaks.lock() {
                    p.push(peak);
                }
            },
            |err| log::error!("ошибка потока микрофона: {err}"),
            None,
        )
        .context("couldn't open the microphone stream")?;
    stream.play().context("couldn't start the microphone stream")?;
    Ok((ActiveCapture::Cpal(stream), sample_rate, channels, fell_back_from))
}

/// Захват через Voice Processing I/O — системное эхоподавление macOS (то же,
/// что у FaceTime): из сигнала микрофона вычитается звук, который Mac сам
/// сейчас проигрывает, — видео в браузере перестаёт попадать в диктовку.
/// Побочно Apple применяет и своё шумоподавление/AGC — это свойство режима,
/// а не наша настройка. Сам юнит поднимает модуль `vpio` выше.
///
/// Любая ошибка здесь — повод откатиться на cpal-путь (см. Recorder::start),
/// а не сорвать запись: эхоподавление — улучшение, микрофон — обязанность.
#[cfg(target_os = "macos")]
fn build_vpio_capture(
    preferred: Option<&str>,
    buffer: Arc<Mutex<Vec<f32>>>,
    peaks: Arc<Mutex<Vec<f32>>>,
) -> anyhow::Result<(ActiveCapture, u32, u16, Option<String>)> {
    use coreaudio::audio_unit::macos_helpers::{get_default_device_id, get_device_id_from_name};

    // Тот же выбор устройства, что у cpal-пути: имена CoreAudio и cpal
    // совпадают (cpal на macOS читает то же свойство устройства). И так же,
    // как там, список устройств опрашивается только ради закреплённого
    // имени — «System default» этих миллисекунд не платит.
    let choice = match preferred {
        None => DeviceChoice::SystemDefault,
        Some(_) => choose_device(preferred, &list_input_devices()),
    };
    let named_id = match &choice {
        DeviceChoice::Named(name) => get_device_id_from_name(name),
        _ => None,
    };
    let (device_id, fell_back_from) = match named_id {
        Some(id) => (id, None),
        None => {
            let id = get_default_device_id(true).ok_or_else(|| anyhow!("no input device found"))?;
            let missing = match choice {
                DeviceChoice::SystemDefault => None,
                DeviceChoice::Named(name) | DeviceChoice::MissingFallback(name) => Some(name),
            };
            (id, missing)
        }
    };

    // Выход нужен юниту как render-путь эхоподавления (см. vpio::build) —
    // всегда системный выходной по умолчанию: звук, который мы вычитаем,
    // играет именно там.
    let output_id =
        get_default_device_id(false).ok_or_else(|| anyhow!("no output device for vpio"))?;

    // Тёплый юнит из кэша, если устройства не менялись; иначе (первая
    // запись без прогрева, сменили микрофон/выход) — пересборка.
    let cached = VPIO_ENGINE.lock().unwrap().take();
    let engine = match cached {
        Some(e) if e.input_device == device_id && e.output_device == output_id => e,
        _ => {
            let t = std::time::Instant::now();
            let e = vpio::build(device_id, output_id)?;
            log::info!("vpio: холодная сборка графа {} мс", t.elapsed().as_millis());
            e
        }
    };
    if let Err(e) = engine.begin(buffer, peaks) {
        // Юнит, который не стартует, в кэш не возвращаем — пусть следующая
        // попытка соберёт свежий.
        return Err(e);
    }
    // Одна строка на запись: по логу должно быть видно, каким путём пошёл
    // захват, — молчаливый фолбэк уже один раз спрятал поломку.
    log::info!("запись через Voice Processing I/O, эхоподавление активно");

    Ok((
        ActiveCapture::Vpio(RunningVpio(Some(engine))),
        WHISPER_SAMPLE_RATE,
        1,
        fell_back_from,
    ))
}

/// Прогрев эхоподавления при старте приложения: собирает VPIO-граф в кэш
/// заранее, чтобы ПЕРВОЕ нажатие хоткея не платило за сборку (сотни
/// миллисекунд между нажатием и появлением окна). Ошибки только в лог —
/// запись при пустом кэше соберёт граф сама.
#[cfg(target_os = "macos")]
pub fn prewarm_echo_cancellation(preferred: Option<String>) {
    use coreaudio::audio_unit::macos_helpers::{get_default_device_id, get_device_id_from_name};
    std::thread::spawn(move || {
        let input_id = match preferred.as_deref() {
            // Именованного может не оказаться — греем на умолчании, как
            // сделает и сама запись (fell_back_from сообщит о подмене она же).
            // Список устройств не опрашиваем: id ищется прямо по имени.
            Some(name) => get_device_id_from_name(name).or_else(|| get_default_device_id(true)),
            None => get_default_device_id(true),
        };
        let (Some(input_id), Some(output_id)) = (input_id, get_default_device_id(false)) else {
            log::warn!("прогрев эхоподавления: не нашлось устройств, пропускаем");
            return;
        };
        match vpio::build(input_id, output_id) {
            Ok(engine) => {
                // Инициализацию тоже платим здесь, в фоне старта приложения,
                // а не на первом хоткее.
                engine.prewarm_init();
                *VPIO_ENGINE.lock().unwrap() = Some(engine);
                log::info!("эхоподавление прогрето заранее");
            }
            Err(e) => log::warn!("прогрев эхоподавления не удался: {e}"),
        }
    });
}

/// Пишет с микрофона на выделенном потоке: ни `cpal::Stream`, ни `AudioUnit`
/// не `Send`, поэтому они не могут жить в состоянии Tauri напрямую.
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
    /// Момент старта — по нему считается длина идущей записи для потолка
    /// сессии (см. `session_limit_reached`). Настенное время, а не длина
    /// буфера: буфер живёт за мьютексом внутри колбэка реального времени, а
    /// для потолка по памяти секунды и сэмплы отличаются на доли процента.
    started: std::time::Instant,
}

impl Recorder {
    /// `preferred` — сохранённое имя устройства; `None` = следовать за
    /// системным умолчанием. Устройство выбирается один раз, на старте
    /// записи: менять его посреди записи нельзя, выбор применяется к следующей.
    ///
    /// `echo_cancel` — включить системное эхоподавление (Voice Processing
    /// I/O): звук, который Mac сам проигрывает, вычитается из микрофона.
    /// Если VPIO не поднялся, запись молча идёт обычным путём cpal — с
    /// предупреждением в лог, но без срыва записи.
    pub fn start(preferred: Option<String>, echo_cancel: bool) -> anyhow::Result<Self> {
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
            // Время от нажатия до живого захвата — главная метрика задержки
            // «хоткей → ON AIR»; в лог идёт только число.
            let capture_t = std::time::Instant::now();

            #[cfg(target_os = "macos")]
            let built = if echo_cancel {
                build_vpio_capture(preferred.as_deref(), buffer.clone(), peaks_thread.clone())
                    .or_else(|e| {
                        log::warn!("эхоподавление не поднялось, пишем без него: {e}");
                        build_cpal_capture(preferred.as_deref(), buffer.clone(), peaks_thread)
                    })
            } else {
                build_cpal_capture(preferred.as_deref(), buffer.clone(), peaks_thread)
            };
            #[cfg(not(target_os = "macos"))]
            let built = {
                let _ = echo_cancel; // VPIO — только macOS
                build_cpal_capture(preferred.as_deref(), buffer.clone(), peaks_thread)
            };

            let (capture, sample_rate, channels) = match built {
                Ok((capture, sample_rate, channels, fell_back_from)) => {
                    log::info!("захват поднят за {} мс", capture_t.elapsed().as_millis());
                    let _ = init_tx.send(Ok(fell_back_from));
                    (capture, sample_rate, channels)
                }
                Err(e) => {
                    let _ = init_tx.send(Err(e));
                    return;
                }
            };

            // Блокируемся, пока не попросят остановиться (или пока отправитель не умрёт).
            let _ = stop_rx.recv();
            drop(capture);

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
            // Отсчёт идёт от момента, когда поток микрофона уже открыт
            // (`init_rx.recv()` выше вернулся): раньше этого звук не пишется.
            started: std::time::Instant::now(),
        })
    }

    /// Имя сохранённого устройства, которого не нашлось. `Some` — писали не с
    /// того микрофона, который выбирал пользователь, и он должен это узнать.
    pub fn fell_back_from(&self) -> Option<&str> {
        self.fell_back_from.as_deref()
    }

    /// Сколько секунд идёт эта запись. Нужно ровно для одного — проверки
    /// потолка сессии (см. `session_limit_reached`).
    pub fn elapsed_secs(&self) -> f32 {
        self.started.elapsed().as_secs_f32()
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

    /// Постоянная составляющая (чистый DC — предельный случай гула) должна
    /// уйти в ноль, а не пройти насквозь.
    #[test]
    fn high_pass_removes_dc() {
        let input = vec![0.5_f32; 16_000];
        let out = high_pass(&input, 16_000, HIGH_PASS_CUTOFF_HZ);
        assert_eq!(out.len(), input.len());
        // Хвост (после переходного процесса) практически нулевой.
        assert!(out[8_000..].iter().all(|s| s.abs() < 0.01));
    }

    /// Высокая частота (речь и выше) проходит почти без ослабления.
    #[test]
    fn high_pass_keeps_high_frequencies() {
        // Меандр 4 кГц при 16 кГц дискретизации — заведомо выше среза.
        let input: Vec<f32> = (0..16_000).map(|i| if (i / 2) % 2 == 0 { 0.5 } else { -0.5 }).collect();
        let out = high_pass(&input, 16_000, HIGH_PASS_CUTOFF_HZ);
        let tail_peak = peak_amplitude(&out[8_000..]);
        assert!(tail_peak > 0.4, "высокие частоты ослабли до {tail_peak}");
    }

    #[test]
    fn high_pass_handles_empty_and_degenerate_args() {
        assert!(high_pass(&[], 16_000, HIGH_PASS_CUTOFF_HZ).is_empty());
        // Нулевой срез и нулевая частота дискретизации — passthrough, не паника.
        let input = vec![0.3_f32, -0.3];
        assert_eq!(high_pass(&input, 16_000, 0.0), input);
        assert_eq!(high_pass(&input, 0, HIGH_PASS_CUTOFF_HZ), input);
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

    /// Потолок сессии в двух единицах должен означать одно и то же число.
    #[test]
    fn session_cap_is_ten_minutes() {
        assert_eq!(MAX_SESSION_SAMPLES, 9_600_000);
        assert_eq!(MAX_SESSION_SAMPLES, 10 * 60 * WHISPER_SAMPLE_RATE as usize);
        // 38.4 МБ при 4 байтах на сэмпл — величина, ради которой всё и
        // затевалось: без потолка час диктовки держал бы ~230 МБ.
        assert_eq!(MAX_SESSION_SAMPLES * 4, 38_400_000);
    }

    #[test]
    fn session_limit_counts_accumulated_plus_current() {
        // Пустая сессия и короткая запись — далеко до потолка.
        assert!(!session_limit_reached(0, 0.0));
        assert!(!session_limit_reached(0, 599.0));
        // Ровно потолок уже считается достигнутым: дальше расти некуда.
        assert!(session_limit_reached(0, 600.0));
        assert!(session_limit_reached(MAX_SESSION_SAMPLES, 0.0));
        // Главный случай дозаписи: накоплено девять минут, пишем ещё две.
        assert!(session_limit_reached(9 * 60 * WHISPER_SAMPLE_RATE as usize, 120.0));
        assert!(!session_limit_reached(9 * 60 * WHISPER_SAMPLE_RATE as usize, 30.0));
    }

    /// Часы умеют отдавать мусор (скачок системного времени), а `as usize`
    /// на отрицательном или NaN даёт ноль/мусор — потолок не должен от этого
    /// ни падать, ни срабатывать раньше времени.
    #[test]
    fn session_limit_survives_nonsense_durations() {
        assert!(!session_limit_reached(0, f32::NAN));
        assert!(!session_limit_reached(0, -5.0));
        // Бесконечность — уже за потолком, а не ноль от переполнения приведения.
        assert!(session_limit_reached(0, f32::INFINITY));
        // Накопленное при этом по-прежнему учитывается.
        assert!(session_limit_reached(MAX_SESSION_SAMPLES, f32::NAN));
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
