//! Лицензия и триал. Модель — «плати за официальную сборку» (как у
//! Aseprite/VoiceInk): код открыт, 14 дней всё работает без ключа, дальше
//! запись требует лицензию. Ключ — Ed25519-подпись, проверяется ОФЛАЙН
//! зашитым публичным ключом: ни лицензионного сервера, ни единого сетевого
//! вызова здесь нет, и правило «сеть — только huggingface.co» не трогается.
//! Подписывает ключи локальная утилита (см. src/bin/license_tool.rs),
//! приватный ключ в репозиторий не попадает (license-signing.key в
//! .gitignore).
//!
//! Это касса для честных, а не DRM: проверка видна в открытом коде и
//! выпиливается одной правкой. Защищать сильнее бессмысленно — приложение
//! и так можно собрать из исходников бесплатно, платят за сборку и за то,
//! чтобы проект жил.
//!
//! Модуль ничего не знает про Tauri — только каталог данных, часы и ключ,
//! всё приходит аргументами (тестируемость, как у journal.rs).

use serde::{Deserialize, Serialize};

/// Длина триала. Четырнадцать — как 14-дневный manibek у соседей по нише:
/// за две недели голосовой ввод либо врастает в привычки, либо нет.
pub const TRIAL_DAYS: u64 = 14;

const MS_PER_DAY: u64 = 24 * 60 * 60 * 1000;
const FILE_NAME: &str = "license.json";

/// Публичный ключ Ed25519 (hex), которым проверяются лицензии. Пара ему —
/// в license-signing.key у владельца проекта; `license_tool gen` печатает
/// новую пару, если эту нужно сменить (смена инвалидирует ВСЕ выданные
/// ключи — делать только до первых продаж).
pub const PUBLIC_KEY_HEX: &str = "075f1a6f1ed69bf42be6ff28e1e2320b7c4ac6133b798c48cb368c8f3516fbec";

/// Префикс лицензионного ключа. Цифра — версия формата: если формат
/// когда-нибудь поменяется, старые ключи останутся узнаваемыми.
const KEY_PREFIX: &str = "SLAIVE1";

/// Hosted checkout Paddle — страница покупки, которую открывает кнопка Buy
/// (в БРАУЗЕРЕ пользователя, см. commands::open_buy_page: приложение само
/// в сеть за этим не ходит, правило «сеть — только huggingface.co» не
/// нарушается). Пока это ПЕСОЧНИЦА: платежи тестовые. Перед релизом
/// завести тот же hosted checkout в боевом аккаунте и заменить URL.
/// Товар: pro_01m5d354ys9v5xc2p0ep45mt4f, цены
/// pri_01m5d378mwezd3ft9e5swe8r0a ($25 Personal) и
/// pri_01m5d38e69rrx1jx1dhrvbwkm2 ($49 Extended).
pub const BUY_URL: &str =
    "https://sandbox-pay.paddle.io/hsc_01m5d3dpvdyns5ajvc1krehhh4_11kknw2gzw868nwe9mbhtpgc23vwaajp";

/// Что приложение знает о лицензии. `days_left` считается на момент вызова
/// `status` — это снимок, не живой счётчик.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum LicenseStatus {
    /// Ключ активирован — навсегда: покупка разовая, подписки нет.
    Licensed,
    /// Триал идёт, осталось столько полных дней (сегодняшний включая).
    Trial { days_left: u64 },
    /// Триал кончился, ключа нет: запись заблокирована, всё остальное
    /// (настройки, уже расшифрованный текст) продолжает работать.
    Expired,
}

/// Содержимое license.json. Файл лежит в app_data_dir рядом с settings.json
/// — обычный файл, не Keychain: лицензионный ключ принадлежит пользователю
/// и секретом от него самого не является (в отличие от API-ключей).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LicenseFile {
    /// Момент первого запуска, мс UTC. 0 — ещё не записан.
    first_launch_ms: u64,
    /// Активированный ключ — хранится как ввели, проверяется на каждом
    /// чтении: подпись дешёвая, а протухший формат лучше заметить сразу.
    license_key: String,
}

fn file_path(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join(FILE_NAME)
}

fn load(dir: &std::path::Path) -> LicenseFile {
    std::fs::read_to_string(file_path(dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save(dir: &std::path::Path, f: &LicenseFile) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(file_path(dir), serde_json::to_string_pretty(f)?)?;
    Ok(())
}

/// Статус на момент `now_ms`. Первый вызов за жизнь установки записывает
/// старт триала — отдельного «начать триал» нет: триал начинается фактом
/// первого запуска, и спрашивать об этом пользователя незачем.
pub fn status(dir: &std::path::Path, now_ms: u64, public_key_hex: &str) -> LicenseStatus {
    let mut f = load(dir);
    if verify_key(&f.license_key, public_key_hex).is_some() {
        return LicenseStatus::Licensed;
    }
    if f.first_launch_ms == 0 || f.first_launch_ms > now_ms {
        // Второе условие — часы, переведённые назад (или файл из будущего):
        // честнее перезапустить отсчёт, чем показать мгновенный Expired.
        f.first_launch_ms = now_ms;
        // Ошибка записи не роняет статус: триал просто начнётся заново на
        // следующем запуске — в пользу пользователя, не против него.
        let _ = save(dir, &f);
    }
    let elapsed_days = (now_ms - f.first_launch_ms) / MS_PER_DAY;
    if elapsed_days < TRIAL_DAYS {
        LicenseStatus::Trial { days_left: TRIAL_DAYS - elapsed_days }
    } else {
        LicenseStatus::Expired
    }
}

/// Активация: ключ проверяется и сохраняется. Err — человекочитаемая
/// причина для поля в настройках, без деталей криптографии.
pub fn activate(
    dir: &std::path::Path,
    key: &str,
    public_key_hex: &str,
) -> Result<(), String> {
    let key = key.trim();
    if verify_key(key, public_key_hex).is_none() {
        return Err("That key doesn't check out. Paste it exactly as it was sent to you.".into());
    }
    let mut f = load(dir);
    f.license_key = key.to_string();
    save(dir, &f).map_err(|_| "Couldn't save the license. Check disk access.".to_string())
}

/// Проверка ключа формата `SLAIVE1-<hex полезной нагрузки>-<hex подписи>`.
/// Нагрузка — произвольная строка (номер заказа, email), возвращается
/// наружу на будущее (показать «лицензия выдана на …»); подпись Ed25519
/// покрывает нагрузку целиком. `None` — любой дефект: не наш префикс,
/// битый hex, неверная подпись.
pub fn verify_key(key: &str, public_key_hex: &str) -> Option<String> {
    let mut parts = key.trim().splitn(3, '-');
    if parts.next()? != KEY_PREFIX {
        return None;
    }
    let payload = hex_decode(parts.next()?)?;
    let sig_bytes = hex_decode(parts.next()?)?;
    let pk_bytes: [u8; 32] = hex_decode(public_key_hex)?.try_into().ok()?;
    let sig: [u8; 64] = sig_bytes.try_into().ok()?;
    let vk = ed25519_dalek::VerifyingKey::from_bytes(&pk_bytes).ok()?;
    vk.verify_strict(&payload, &ed25519_dalek::Signature::from_bytes(&sig))
        .ok()?;
    String::from_utf8(payload).ok()
}

/// Собирает ключ из нагрузки и подписи — используется утилитой подписи и
/// тестами; формат живёт в одном месте с проверкой.
pub fn assemble_key(payload: &[u8], signature: &[u8; 64]) -> String {
    format!("{KEY_PREFIX}-{}-{}", hex_encode(payload), hex_encode(signature))
}

// Свои hex-помощники вместо крейта `hex`: двадцать строк против новой
// зависимости в дереве — лестница говорит «строки».
pub fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hex_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;

    fn keypair() -> (ed25519_dalek::SigningKey, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pk_hex = hex_encode(sk.verifying_key().as_bytes());
        (sk, pk_hex)
    }

    fn signed_key(payload: &str) -> (String, String) {
        let (sk, pk_hex) = keypair();
        let sig = sk.sign(payload.as_bytes());
        (assemble_key(payload.as_bytes(), &sig.to_bytes()), pk_hex)
    }

    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-license-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn valid_key_round_trips_and_returns_payload() {
        let (key, pk) = signed_key("order-1042");
        assert_eq!(verify_key(&key, &pk), Some("order-1042".to_string()));
    }

    #[test]
    fn tampered_key_wrong_prefix_and_garbage_are_rejected() {
        let (key, pk) = signed_key("order-1042");
        // Подмена нагрузки при чужой подписи.
        let (other, _) = signed_key("order-9999");
        let forged = {
            let sig = other.rsplit('-').next().unwrap();
            let payload = key.split('-').nth(1).unwrap();
            format!("SLAIVE1-{payload}-{sig}")
        };
        assert_eq!(verify_key(&forged, &pk), None);
        assert_eq!(verify_key("SLAIVE2-aa-bb", &pk), None);
        assert_eq!(verify_key("просто текст", &pk), None);
        assert_eq!(verify_key("", &pk), None);
    }

    #[test]
    fn first_call_starts_the_trial_and_counts_days_down() {
        let dir = tmp();
        let (_, pk) = keypair();
        let day = MS_PER_DAY;
        assert_eq!(status(&dir, 1000, &pk), LicenseStatus::Trial { days_left: 14 });
        // Тот же старт, прошло 13 полных дней — остался один.
        assert_eq!(
            status(&dir, 1000 + 13 * day, &pk),
            LicenseStatus::Trial { days_left: 1 }
        );
        assert_eq!(status(&dir, 1000 + 14 * day, &pk), LicenseStatus::Expired);
    }

    #[test]
    fn clock_rolled_back_restarts_the_trial_instead_of_expiring() {
        let dir = tmp();
        let (_, pk) = keypair();
        assert_eq!(
            status(&dir, 5 * MS_PER_DAY, &pk),
            LicenseStatus::Trial { days_left: 14 }
        );
        // Часы ушли назад за точку старта — отсчёт честно начинается заново.
        assert_eq!(status(&dir, 1000, &pk), LicenseStatus::Trial { days_left: 14 });
    }

    #[test]
    fn activation_persists_and_wins_over_the_expired_trial() {
        let dir = tmp();
        let (key, pk) = signed_key("order-7");
        assert_eq!(status(&dir, 0, &pk), LicenseStatus::Trial { days_left: 14 });
        activate(&dir, &format!("  {key}  "), &pk).unwrap();
        // Далеко за пределами триала — но ключ активирован.
        assert_eq!(status(&dir, 100 * MS_PER_DAY, &pk), LicenseStatus::Licensed);
    }

    #[test]
    fn a_bad_key_does_not_activate_and_says_why() {
        let dir = tmp();
        let (_, pk) = keypair();
        let err = activate(&dir, "SLAIVE1-00-11", &pk).unwrap_err();
        assert!(err.contains("doesn't check out"));
        assert_eq!(status(&dir, 0, &pk), LicenseStatus::Trial { days_left: 14 });
    }

    #[test]
    fn hex_helpers_round_trip_and_reject_odd_input() {
        assert_eq!(hex_decode(&hex_encode(&[0, 1, 255])), Some(vec![0, 1, 255]));
        assert_eq!(hex_decode("abc"), None);
        assert_eq!(hex_decode("zz"), None);
    }
}
