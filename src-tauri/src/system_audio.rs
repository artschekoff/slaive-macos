//! Mute системного выхода на время записи — чтобы играющее видео или
//! музыка не попадали в диктовку. Подход VoiceInk, перенятый после
//! удаления эхоподавления: не вычитать чужой звук из микрофона (VPIO
//! портил тембр и держал устройство открытым с горящим индикатором), а
//! убрать сам звук на несколько секунд записи.
//!
//! Правила собственности — тоже их, и они важны:
//! - устройство, которое замьютил САМ пользователь, мы в собственность не
//!   берём: размьютить его после записи значило бы включить звук, который
//!   человек выключил руками;
//! - восстанавливаем ровно те устройства, которые мьютили сами (set ниже),
//!   даже если за время записи дефолтный выход сменился.
//!
//! Честное ограничение: после краха приложения mute снять некому — тот же
//! риск принят и в VoiceInk. Выход через Quit снимает (см. main.rs).

use coreaudio_sys as ca;
use std::os::raw::c_void;
use std::sync::Mutex;

/// Выходы, которые замьютили мы. Статик, а не поле состояния: запись и её
/// завершение живут в разных вызовах команд, а владелец mute — процесс.
static MUTED_BY_US: Mutex<Vec<ca::AudioObjectID>> = Mutex::new(Vec::new());

fn mute_address() -> ca::AudioObjectPropertyAddress {
    ca::AudioObjectPropertyAddress {
        mSelector: ca::kAudioDevicePropertyMute,
        mScope: ca::kAudioDevicePropertyScopeOutput,
        mElement: ca::kAudioObjectPropertyElementMaster,
    }
}

fn default_output_device() -> Option<ca::AudioObjectID> {
    let addr = ca::AudioObjectPropertyAddress {
        mSelector: ca::kAudioHardwarePropertyDefaultOutputDevice,
        mScope: ca::kAudioObjectPropertyScopeGlobal,
        mElement: ca::kAudioObjectPropertyElementMaster,
    };
    let mut device: ca::AudioObjectID = 0;
    let mut size = std::mem::size_of::<ca::AudioObjectID>() as u32;
    let status = unsafe {
        ca::AudioObjectGetPropertyData(
            ca::kAudioObjectSystemObject,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut device as *mut _ as *mut c_void,
        )
    };
    (status == 0 && device != ca::kAudioObjectUnknown).then_some(device)
}

fn is_muted(device: ca::AudioObjectID) -> Option<bool> {
    let addr = mute_address();
    if unsafe { ca::AudioObjectHasProperty(device, &addr) } == 0 {
        return None;
    }
    let mut muted: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        ca::AudioObjectGetPropertyData(
            device,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut muted as *mut _ as *mut c_void,
        )
    };
    (status == 0).then_some(muted != 0)
}

fn set_muted(device: ca::AudioObjectID, muted: bool) -> bool {
    let addr = mute_address();
    let mut settable: ca::Boolean = 0;
    let status = unsafe { ca::AudioObjectIsPropertySettable(device, &addr, &mut settable) };
    if status != 0 || settable == 0 {
        return false;
    }
    let value: u32 = muted.into();
    let status = unsafe {
        ca::AudioObjectSetPropertyData(
            device,
            &addr,
            0,
            std::ptr::null(),
            std::mem::size_of::<u32>() as u32,
            &value as *const _ as *const c_void,
        )
    };
    status == 0
}

/// Глушит дефолтный выход на время записи. Любой отказ — тихий: mute — это
/// удобство, а не обязанность, и срывать из-за него запись нельзя.
pub fn mute_default_output() {
    let Some(device) = default_output_device() else {
        return;
    };
    // Уже замьючено пользователем — не наше: собственность не берём.
    if is_muted(device) != Some(false) {
        return;
    }
    if set_muted(device, true) {
        let mut owned = MUTED_BY_US.lock().unwrap();
        if !owned.contains(&device) {
            owned.push(device);
        }
    }
}

/// Возвращает звук всем выходам, которые глушили мы. Зовётся на конце
/// записи и на выходе из приложения; на чужие mute не влияет.
pub fn restore_muted_outputs() {
    let mut owned = MUTED_BY_US.lock().unwrap();
    owned.retain(|&device| !set_muted(device, false));
}
