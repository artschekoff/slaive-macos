//! Утилита владельца проекта: генерация пары ключей и подпись лицензий.
//! Работает локально, без сети — это и есть весь «лицензионный сервер» до
//! тех пор, пока продажи не потребуют автоматизации (webhook Paddle зовёт
//! ровно эту же подпись, когда появится).
//!
//!   cargo run --example license_tool -- gen
//!       печатает новую пару: приватный ключ сохранить в
//!       license-signing.key (он в .gitignore), публичный вписать в
//!       PUBLIC_KEY_HEX в src/license.rs.
//!
//!   cargo run --example license_tool -- sign <приватный-hex|@файл> <нагрузка>
//!       печатает готовый лицензионный ключ для покупателя; нагрузка —
//!       номер заказа или email.

// Логика формата живёт в license.rs и подключается по пути: у пакета нет
// библиотечного крейта, а дублировать формат в двух местах нельзя.
#[path = "../src/license.rs"]
mod license;

use ed25519_dalek::Signer;

fn read_urandom_32() -> [u8; 32] {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .expect("нет /dev/urandom")
        .read_exact(&mut buf)
        .expect("не прочитать /dev/urandom");
    buf
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("gen") => {
            let sk = ed25519_dalek::SigningKey::from_bytes(&read_urandom_32());
            println!("private (license-signing.key): {}", license::hex_encode(&sk.to_bytes()));
            println!("public  (PUBLIC_KEY_HEX):      {}", license::hex_encode(sk.verifying_key().as_bytes()));
        }
        Some("sign") if args.len() == 3 => {
            let key_hex = match args[1].strip_prefix('@') {
                Some(path) => std::fs::read_to_string(path).expect("не прочитать файл ключа"),
                None => args[1].clone(),
            };
            let bytes: [u8; 32] = license::hex_decode(&key_hex)
                .expect("приватный ключ — не hex")
                .try_into()
                .expect("приватный ключ должен быть 32 байта");
            let sk = ed25519_dalek::SigningKey::from_bytes(&bytes);
            let payload = args[2].as_bytes();
            let sig = sk.sign(payload);
            println!("{}", license::assemble_key(payload, &sig.to_bytes()));
        }
        // Проверка ключа тем же публичным ключом, что зашит в приложение, —
        // прогнать перед отправкой покупателю: ловит и опечатку в ключе, и
        // рассинхрон пары после регенерации.
        Some("verify") if args.len() == 2 => match license::verify_key(&args[1], license::PUBLIC_KEY_HEX) {
            Some(payload) => println!("ok, payload: {payload}"),
            None => {
                eprintln!("INVALID: ключ не проходит проверку зашитым публичным ключом");
                std::process::exit(1);
            }
        },
        _ => {
            eprintln!(
                "usage: license_tool gen | license_tool sign <private-hex|@file> <payload> | license_tool verify <key>"
            );
            std::process::exit(2);
        }
    }
}
