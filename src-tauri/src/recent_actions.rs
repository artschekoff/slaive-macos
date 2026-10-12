//! Недавно выполненные действия меню главного окна: что вызывали последним,
//! чтобы вызвать это же одним нажатием, не проходя уровни заново.
//!
//! Модуль, как и `history`, ничего не знает ни про Tauri, ни про окна: на вход
//! папка данных, на выход список. Путь к папке приходит снаружи
//! (`commands::data_dir`, то есть `app.path().app_data_dir()`), хардкода здесь
//! нет.
//!
//! ЧТО ТАКОЕ ДЕЙСТВИЕ. Не лист дерева, а ПУТЬ плюс ПАРАМЕТР. Узлов три вида
//! (см. `src/action-tree.ts`): `leaf` срабатывает сразу, и его одного
//! достаточно; `branch` → `leaf` это Translate и язык, нужны оба звена;
//! `prompt` это Ask AI со свободным запросом, и без текста запроса половина
//! пользы исчезает — перенабирать запрос дороже, чем дойти до кнопки.
//! Поэтому запись — это `path` (идентификаторы узлов от корня до того, что
//! выполнили) и `query` (текст запроса; у leaf он пуст).
//!
//! ПОДПИСИ ЗДЕСЬ НЕТ НАМЕРЕННО. «Translate → Russian» собирается на
//! фронтенде по ЖИВОМУ дереву (`src/recent-actions.ts`), потому что состав
//! дерева — настройка: список языков правится в окне настроек. Храни мы
//! подпись, после правки списка в меню остался бы пункт с подписью языка,
//! которого в дереве больше нет. Храним путь — пункт, который больше не
//! разрешается в узел, просто не показывается.
//!
//! ПРИВАТНОСТЬ. `query` — это текст, который написал пользователь, ровно того
//! же рода, что расшифровки в `history`. Правило проекта остаётся в силе: в
//! лог уходят только числа (сколько записей, сколько байт). Ни `query`, ни
//! его кусок, ни его длина в лог не попадают. Удаление ОДНОЙ записи
//! (`forget`) существует по той же причине, по которой оно есть у истории:
//! человек мог задать запрос, который не хочет видеть в окне каждый раз.
//!
//! ФОРМАТ. JSONL, как у истории: одна запись — одна строка, битая строка
//! пропускается и не уносит остальные. Дозаписи здесь не бывает (любое
//! изменение меняет ПОРЯДОК, то есть переписывает файл целиком), но при трёх
//! записях цена перезаписи — байты, а устойчивость к обрыву остаётся та же.
use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "recent-actions.jsonl";
/// Временное имя для перезаписи файла целиком — переименование в пределах
/// одной папки атомарно, поэтому прерванная перезапись оставляет нетронутым
/// СТАРЫЙ файл, а не половину нового. Тот же приём, что в `history`.
const TMP_FILE_NAME: &str = "recent-actions.jsonl.tmp";

/// Сколько действий помним. Три, а не десять: список нужен, чтобы его
/// прочитали ОДНИМ взглядом, и он стоит над основными действиями — длинный
/// отодвинул бы само меню вниз и перестал бы отличаться от него.
pub const MAX_ENTRIES: usize = 3;

/// Одно запомненное действие. `camelCase` — как у остальных структур, которые
/// уходят во фронтенд; тот же регистр лежит и в файле, менять его потом
/// нельзя без миграции.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// Идентификаторы узлов дерева от корня до выполненного действия:
    /// `["fix"]`, `["translate", "translate-russian"]`, `["ask-ai"]`.
    /// Это НЕ путь в файловой системе и нигде им не становится — просто
    /// ключи узлов, которые фронтенд разрешает в живом дереве.
    pub path: Vec<String>,
    /// Свободный запрос `prompt`-узла (Ask AI, Generate). У `leaf` пуст.
    pub query: String,
}

/// Тождество записи — ВЕСЬ путь вместе с запросом, то есть сравнение целой
/// структуры. Отдельной функции-ключа нет намеренно: два разных запроса к
/// Ask AI — это два разных действия (одинаковым считается только совпадающий
/// запрос), и производное «ключ» рядом с `PartialEq` было бы вторым
/// источником правды о том, что считать повтором.
fn same(a: &Action, b: &Action) -> bool {
    a == b
}

pub fn file_path(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

/// Читает список. Порядок — как в файле: от САМОГО НЕДАВНЕГО к старым, ровно
/// в том порядке, в каком пункты стоят в меню. Разворачивать на стороне
/// интерфейса (как это делает `history::list_history`) здесь нечего: у
/// истории файл растёт дозаписью в конец, а здесь он всё равно переписывается
/// целиком при каждом изменении.
///
/// Битая строка пропускается: процесс могли убить посреди перезаписи. Файл
/// читается байтами и превращается в строку через `from_utf8_lossy` — обрыв
/// мог прийтись на середину многобайтового символа, и `read_to_string`
/// отказался бы отдать ВЕСЬ файл из-за одного такого байта. Та же причина и
/// тот же приём, что в `history::load`.
///
/// Отсутствующий файл — пустой список, а не ошибка: до первого действия его и
/// не должно быть.
pub fn load(dir: &Path) -> anyhow::Result<Vec<Action>> {
    let path = file_path(dir);
    let raw = match std::fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(anyhow::Error::new(e).context("Couldn't read the recent actions file."))
        }
    };
    let text = String::from_utf8_lossy(&raw);
    let mut actions: Vec<Action> = Vec::new();
    let mut skipped = 0usize;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Action>(line) {
            Ok(action) => actions.push(action),
            Err(_) => skipped += 1,
        }
    }
    if skipped > 0 {
        // Только счётчик: в битой строке лежит тот же текст пользователя.
        log::warn!("недавние действия: пропущено битых строк: {skipped}");
    }
    // Потолок страхуем и на чтении: файл мог остаться от сборки с другим
    // MAX_ENTRIES, и показывать из него пять пунктов было бы неожиданностью,
    // которую пользователь не может отменить.
    actions.truncate(MAX_ENTRIES);
    Ok(actions)
}

/// Поднимает действие наверх списка и возвращает новый список.
///
/// ПОВТОР НЕ ПЛОДИТ ДУБЛИКАТОВ: то же действие, вызванное снова, переезжает
/// на первое место, а не добавляется второй копией. «То же» — это совпадение
/// и пути, и запроса (см. `same`).
pub fn touch(dir: &Path, action: Action) -> anyhow::Result<Vec<Action>> {
    std::fs::create_dir_all(dir).context("Couldn't create the app data folder.")?;
    let mut actions = load(dir)?;
    actions.retain(|a| !same(a, &action));
    actions.insert(0, action);
    actions.truncate(MAX_ENTRIES);
    write_all(dir, &actions)?;
    Ok(actions)
}

/// Убирает одно действие из списка и возвращает новый список. Отсутствие
/// такого действия — не ошибка: интерфейс мог показывать список, из которого
/// его уже убрали.
pub fn forget(dir: &Path, action: &Action) -> anyhow::Result<Vec<Action>> {
    let mut actions = load(dir)?;
    let before = actions.len();
    actions.retain(|a| !same(a, action));
    if actions.len() == before {
        return Ok(actions);
    }
    write_all(dir, &actions)?;
    Ok(actions)
}

/// Перезапись файла целиком через временный файл и переименование —
/// прерванная на середине перезапись оставляет старый файл нетронутым.
fn write_all(dir: &Path, actions: &[Action]) -> anyhow::Result<()> {
    let tmp = dir.join(TMP_FILE_NAME);
    let mut buf = String::new();
    for a in actions {
        // `to_string`, не `to_string_pretty`: на этом и держится «строка
        // файла = запись». Переносы внутри запроса экранирует сам serde_json.
        let line = serde_json::to_string(a)?;
        debug_assert!(!line.contains('\n'));
        buf.push_str(&line);
        buf.push('\n');
    }
    std::fs::write(&tmp, &buf).context("Couldn't write the recent actions file.")?;
    std::fs::rename(&tmp, file_path(dir)).context("Couldn't replace the recent actions file.")?;
    Ok(())
}

/// Размер файла в байтах — для лога. Числа логировать можно, содержимое нет.
pub fn file_bytes(dir: &Path) -> u64 {
    std::fs::metadata(file_path(dir)).map(|m| m.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Та же изоляция, что у тестов истории и настроек: pid плюс id потока,
    // иначе параллельные тесты дерутся за одну папку.
    fn tmp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-recent-actions-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leaf(id: &str) -> Action {
        Action {
            path: vec![id.to_string()],
            query: String::new(),
        }
    }

    fn ask(query: &str) -> Action {
        Action {
            path: vec!["ask-ai".to_string()],
            query: query.to_string(),
        }
    }

    #[test]
    fn empty_when_file_missing() {
        let dir = tmp();
        assert!(load(&dir).unwrap().is_empty());
    }

    #[test]
    fn touch_puts_the_action_on_top_and_survives_a_reload() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        let list = touch(&dir, leaf("shorten")).unwrap();
        assert_eq!(list, vec![leaf("shorten"), leaf("fix")]);
        // И то же самое после перезапуска — список лежит на диске.
        assert_eq!(load(&dir).unwrap(), vec![leaf("shorten"), leaf("fix")]);
    }

    /// Путь запоминается ЦЕЛИКОМ: Translate без языка выполнить нельзя, и
    /// запись о нём была бы пунктом, по которому не ясно, что он сделает.
    #[test]
    fn the_whole_path_is_remembered_not_just_the_leaf() {
        let dir = tmp();
        let action = Action {
            path: vec!["translate".to_string(), "translate-russian".to_string()],
            query: String::new(),
        };
        let list = touch(&dir, action.clone()).unwrap();
        assert_eq!(list, vec![action]);
    }

    #[test]
    fn evicts_beyond_the_cap() {
        let dir = tmp();
        for id in ["fix", "shorten", "summarize", "generate"] {
            touch(&dir, leaf(id)).unwrap();
        }
        let list = load(&dir).unwrap();
        assert_eq!(list.len(), MAX_ENTRIES);
        // Вытесняется САМОЕ СТАРОЕ (fix), новейшее стоит первым.
        assert_eq!(list, vec![leaf("generate"), leaf("summarize"), leaf("shorten")]);
    }

    /// Повтор поднимает действие наверх, а не добавляет вторую копию — иначе
    /// список из трёх пунктов занял бы себя одним и тем же действием.
    #[test]
    fn repeat_moves_to_the_top_without_duplicating() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        touch(&dir, leaf("shorten")).unwrap();
        let list = touch(&dir, leaf("fix")).unwrap();
        assert_eq!(list, vec![leaf("fix"), leaf("shorten")]);
    }

    /// Для Ask AI одинаковыми считаются только СОВПАДАЮЩИЕ запросы: два
    /// разных запроса — два разных действия, и второй не затирает первый.
    #[test]
    fn two_different_queries_are_two_actions() {
        let dir = tmp();
        touch(&dir, ask("make it formal")).unwrap();
        let list = touch(&dir, ask("make it short")).unwrap();
        assert_eq!(list, vec![ask("make it short"), ask("make it formal")]);

        // А тот же запрос — то же действие: поднимается, но не дублируется.
        let list = touch(&dir, ask("make it formal")).unwrap();
        assert_eq!(list, vec![ask("make it formal"), ask("make it short")]);
    }

    #[test]
    fn forget_removes_only_the_named_action() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        touch(&dir, ask("make it formal")).unwrap();
        touch(&dir, leaf("shorten")).unwrap();

        let list = forget(&dir, &ask("make it formal")).unwrap();
        assert_eq!(list, vec![leaf("shorten"), leaf("fix")]);
        assert_eq!(load(&dir).unwrap(), vec![leaf("shorten"), leaf("fix")]);

        // Повторное удаление — не ошибка и ничего не трогает.
        let list = forget(&dir, &ask("make it formal")).unwrap();
        assert_eq!(list, vec![leaf("shorten"), leaf("fix")]);
    }

    /// Удаление последнего пункта оставляет пустой список, а не роняет чтение.
    #[test]
    fn forgetting_the_last_action_leaves_an_empty_list() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        assert!(forget(&dir, &leaf("fix")).unwrap().is_empty());
        assert!(load(&dir).unwrap().is_empty());
        // И список продолжает работать.
        assert_eq!(touch(&dir, leaf("shorten")).unwrap(), vec![leaf("shorten")]);
    }

    /// Запрос с переносом строки обязан остаться ОДНОЙ строкой файла — иначе
    /// «строка = запись» ломается и половина записи читается как битая.
    #[test]
    fn multiline_query_stays_one_line() {
        let dir = tmp();
        touch(&dir, ask("первая строка\nвторая строка")).unwrap();
        let raw = std::fs::read_to_string(file_path(&dir)).unwrap();
        assert_eq!(raw.lines().count(), 1);
        assert_eq!(load(&dir).unwrap()[0].query, "первая строка\nвторая строка");
    }

    /// Обрыв питания посреди перезаписи: в файле осталась половина JSON.
    /// Остальные записи обязаны прочитаться.
    #[test]
    fn broken_line_is_skipped() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        let good = std::fs::read_to_string(file_path(&dir)).unwrap();
        std::fs::write(file_path(&dir), format!("{{\"path\":[\"обор\n{good}")).unwrap();

        let list = load(&dir).unwrap();
        assert_eq!(list, vec![leaf("fix")]);
    }

    /// Обрыв пришёлся на середину многобайтового символа — файл целиком уже
    /// не валидный UTF-8, `read_to_string` вернул бы ошибку на ВЕСЬ файл.
    #[test]
    fn invalid_utf8_tail_does_not_kill_the_file() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        let mut raw = std::fs::read(file_path(&dir)).unwrap();
        // Первый байт двухбайтовой кириллической буквы без пары.
        raw.extend_from_slice(&[b'{', b'"', b'p', 0xD0]);
        std::fs::write(file_path(&dir), raw).unwrap();

        assert_eq!(load(&dir).unwrap(), vec![leaf("fix")]);
    }

    /// Файл, оставшийся от сборки с большим потолком, не должен давать меню
    /// больше пунктов, чем оно рассчитано показывать.
    #[test]
    fn a_longer_file_is_cut_to_the_cap_on_read() {
        let dir = tmp();
        let mut buf = String::new();
        for i in 0..MAX_ENTRIES + 4 {
            buf.push_str(&serde_json::to_string(&leaf(&format!("a{i}"))).unwrap());
            buf.push('\n');
        }
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(file_path(&dir), buf).unwrap();
        assert_eq!(load(&dir).unwrap().len(), MAX_ENTRIES);
    }

    /// Перезапись не должна оставлять за собой временный файл: он лежит в той
    /// же папке данных и был бы просто мусором на диске.
    #[test]
    fn rewrite_leaves_no_temp_file() {
        let dir = tmp();
        touch(&dir, leaf("fix")).unwrap();
        forget(&dir, &leaf("fix")).unwrap();
        assert!(!dir.join(TMP_FILE_NAME).exists());
    }
}
