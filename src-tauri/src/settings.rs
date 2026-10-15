use anyhow::Context;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "settings.json";

/// Настройки одного ИИ-провайдера. Ключ сюда НЕ входит — он в Keychain (см.
/// `ai.rs`/`commands.rs`), а этот файл лежит в Application Support открытым
/// текстом и читается любым процессом от имени пользователя.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderConfig {
    pub model: String,
    /// Пусто/`None` = адрес по умолчанию для этого провайдера.
    pub base_url: Option<String>,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            base_url: None,
        }
    }
}

/// Роль диктора: имя для селектора в панели и промпт, которым ИИ правит
/// расшифровку под эту роль («я программист — почини термины»). id —
/// UUID, который выдаёт фронтенд при создании; имя не идентификатор,
/// его можно переименовывать, не теряя выбор активной роли.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DictorRole {
    pub id: String,
    pub name: String,
    pub prompt: String,
}

/// Настройки ИИ-слоя. У каждого провайдера своя запись в `providers`,
/// ключ — id провайдера (см. `ai::PROVIDERS`) — переключение между ними не
/// затирает соседние настройки, каждая пара модель+адрес живёт отдельно.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSettings {
    /// id выбранного провайдера.
    pub provider: String,
    /// Настройки по каждому провайдеру, ключ — id.
    pub providers: BTreeMap<String, ProviderConfig>,
}

impl Default for AiSettings {
    fn default() -> Self {
        let mut providers = BTreeMap::new();
        // OpenAI — единственный реализованный провайдер, поэтому он же
        // выбран по умолчанию и получает готовую модель-подсказку; ключ
        // пользователь всё равно должен добавить сам — без него запрос не
        // уйдёт (см. `ai::require_api_key`).
        providers.insert(
            "openai".to_string(),
            ProviderConfig {
                model: "gpt-4o-mini".to_string(),
                base_url: None,
            },
        );
        Self {
            provider: "openai".to_string(),
            providers,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Строка хоткея в формате Tauri, например "Ctrl+Space".
    pub hotkey: String,
    /// Глобальный хоткей захвата выделенного текста. Как и `hotkey`,
    /// регистрируется системно, поэтому перехватывает комбинацию во всех
    /// приложениях сразу.
    pub capture_hotkey: String,
    /// Абсолютный путь к файлу модели ggml-*.bin.
    pub model_path: Option<PathBuf>,
    /// "auto" | "ru" | "en"
    pub language: String,
    /// Абсолютный путь к файлу модели VAD (Silero), если пользователь её
    /// скачал. `None` — VAD выключен, расшифровка идёт по всей записи целиком,
    /// как и раньше; это не ошибка и не деградация, а сознательный дефолт.
    pub vad_model_path: Option<PathBuf>,
    /// Хоткей вставки текста в панели — в том же формате, что `hotkey`, но
    /// это НЕ глобальная комбинация: она перехватывается обычным keydown
    /// внутри окна overlay (см. Overlay.tsx), а не через
    /// tauri-plugin-global-shortcut, поэтому здесь не проходит через
    /// `validate_hotkey`/`register_hotkey` и хранится как обычная строка.
    pub paste_shortcut: String,
    /// Хоткей копирования текста в панели — та же оговорка, что у
    /// `paste_shortcut`: окно-локальный, не глобальный.
    pub copy_shortcut: String,
    /// Хоткей кнопки Follow в панели — «передать текст в главное окно».
    /// Та же оговорка, что у `paste_shortcut`/`copy_shortcut`: окно-локальный.
    /// В отличие от них требует модификатора (см. Settings.tsx): панель
    /// ловит его на ФАЗЕ ПЕРЕХВАТА и гасит распространение, иначе, например,
    /// Ctrl+F достался бы vim (`<C-f>` — постраничная прокрутка), — а голая
    /// клавиша, перехваченная так же, отобрала бы у редактора обычный ввод.
    /// Дефолт совпадает с `fix_shortcut` (оба — Cmd+F): это не столкновение,
    /// Follow живёт в панели, Fix — в главном окне, и в фокусе всегда только
    /// одно из них.
    pub follow_shortcut: String,
    /// Хоткеи действий главного окна (Translate / Ask AI / Generate / Fix /
    /// Shorten / Summarize) — та же оговорка, что у `paste_shortcut`/`copy_shortcut`:
    /// окно-локальные, перехватываются обычным keydown внутри окна `main`
    /// (см. MainWindow.tsx), а не через tauri-plugin-global-shortcut.
    /// Хранятся отдельными полями, а не картой «id действия → комбинация»:
    /// состав действий задан в коде (src/action-tree.ts), а не пользователем,
    /// и плоские поля дают тот же разбор в serde и ту же проверку типом на
    /// фронтенде, что и остальные настройки.
    /// ponytail: если действия станут пользовательскими, заменить на карту.
    pub translate_shortcut: String,
    pub ask_ai_shortcut: String,
    pub generate_shortcut: String,
    pub fix_shortcut: String,
    pub shorten_shortcut: String,
    pub summarize_shortcut: String,
    /// Хоткей кнопки Paste ГЛАВНОГО окна — отдельное поле от
    /// `paste_shortcut`, хотя действие в обоих окнах одно и то же («отправить
    /// текст туда, откуда пришла диктовка»). Причина в клавише, а не в
    /// действии: у панели дефолт — голый `Enter`, и в её редакторе он
    /// перехвачен vim-экшеном `slaivePaste` (см. Overlay.tsx). В главном окне
    /// такого экшена нет, и голый `Enter` там означал бы ровно то, что ему и
    /// положено означать в редакторе, — перенос строки. Поэтому у главного
    /// окна своя комбинация, и она с модификатором, как и остальные его
    /// хоткеи.
    pub main_paste_shortcut: String,
    /// Хоткей кнопки Copy главного окна — отдельное поле от `copy_shortcut`
    /// панели по той же причине, что у пары Paste: комбинации настраиваются
    /// на каждое окно свои, хотя действие одно. Дефолт совпадает с панельным
    /// Cmd+C намеренно — одна мышечная память на оба окна; столкновением это
    /// не считается, области разные (см. src/shortcut-conflicts.ts).
    pub main_copy_shortcut: String,
    /// Хоткей кнопки Accept главного окна — «предложение ИИ становится
    /// текстом окончательно». Та же оговорка, что у остальных: окно-локальный.
    ///
    /// Отдельная комбинация, а не переиспользование `main_paste_shortcut`,
    /// хотя в фазе `proposed` Paste и недоступен: Accept ЗАМЕНЯЕТ текст
    /// пользователя, и прежний достаётся только через Undo редактора. Клавиша,
    /// которой человек привык отправлять текст, не должна по случайности
    /// принимать чужую правку — поэтому у Accept свой, намеренно более
    /// тугой аккорд.
    ///
    /// Пары Cancel у него в настройках нет: Cancel — это Escape, и он не
    /// хранится (см. ESCAPE_SHORTCUT в src/action-shortcuts.ts).
    pub accept_shortcut: String,
    /// Настройки ИИ-провайдеров — модель и адрес на каждого, БЕЗ ключей
    /// (они в Keychain). См. `AiSettings`.
    pub ai: AiSettings,
    /// Языки, на которые переводит подменю Translate главного окна, — обычные
    /// НАЗВАНИЯ через запятую или с новой строки ("English, Spanish,
    /// Russian"), а не ISO-коды и не выбор из каталога. Модель одинаково
    /// понимает и то и другое, а список названий правится в одном поле — в
    /// отличие от каталога на две сотни языков, из которого нужны три.
    ///
    /// Хранится строкой, как `dictionary` ниже, а не `Vec<String>`: поле в
    /// настройках одно и текстовое, и разбор «строка → список» тогда живёт в
    /// одном месте (см. `parseLanguageList` в src/action-tree.ts), а не
    /// делится между склейкой в интерфейсе и разбором на бэкенде.
    ///
    /// Пустая строка — не «переводить некуда», а «не выбрано»: подменю тогда
    /// строится из дефолта (см. buildActionTree), потому что пустой список
    /// даёт только мёртвый пункт меню и никакого полезного смысла не несёт.
    /// Этим настройка отличается от `dictionary`, где пустота как раз
    /// означает «ничего не подсказывать whisper».
    pub translate_languages: String,
    /// Множитель усиления микрофона, применяемый к PCM ПЕРЕД VAD и whisper
    /// (см. `audio::apply_gain`). Тихий микрофон бьёт дважды: whisper на
    /// тихом входе распознаёт хуже, а VAD с порогом вероятности может не
    /// увидеть речи вовсе и вырезать всю запись. 1.0 — как было до появления
    /// настройки. На дорожку уровня НЕ влияет: та рисует сырой сигнал.
    pub mic_gain: f32,
    /// Порог обнаружения речи для VAD (Silero) — вероятность, выше которой
    /// кусок считается речью. Это НЕ чувствительность микрофона: та —
    /// `mic_gain` выше, и путать их вредно. 0.5 — дефолт whisper.cpp.
    pub vad_threshold: f32,
    /// Имя выбранного устройства записи, как его отдаёт `cpal`. `None` —
    /// «System default»: следовать за системным умолчанием, а не прикрепиться
    /// к тому устройству, которое было умолчанием в момент выбора. Это разные
    /// вещи, и путать их нельзя (см. бриф выбора устройства).
    ///
    /// Имя — единственный идентификатор, который даёт `cpal`.
    /// ponytail: имена не стабильны между переподключениями у части устройств
    /// (iPhone, USB-хабы); чинится переходом на CoreAudio device UID, если
    /// начнёт мешать.
    pub input_device: Option<String>,
    /// Системное эхоподавление (Voice Processing I/O): звук, который Mac сам
    /// проигрывает (видео, музыка), вычитается из сигнала микрофона — иначе
    /// он попадает в диктовку. Побочно Apple добавляет своё шумоподавление и
    /// автоусиление — тембр записи слегка меняется, поэтому настройка
    /// выключаемая. Если VPIO не поднимается, запись автоматически идёт
    /// обычным путём (см. `audio::Recorder::start`).
    pub echo_cancellation: bool,
    /// High-pass фильтр 80 Гц перед VAD и whisper (см. `audio::high_pass`):
    /// срезает гул помещения и вентиляторов, в которых речи нет. К сырой
    /// записи (Play, история) не применяется — это параметр распознавания,
    /// как и `mic_gain`.
    pub high_pass_filter: bool,
    /// Непрозрачность окон приложения, 0.5–1.0. Уходит в `NSWindow
    /// alphaValue` (см. `macos::set_window_alpha`), то есть красит окно
    /// целиком: содержимое, нативную полосу заголовка и тень. Одно значение
    /// на все три окна — отдельных на окно намеренно нет, пользователь
    /// выставляет «насколько сквозь Slaive видно то, что под ним», а не
    /// настраивает окна по одному.
    ///
    /// Значение зажимается при чтении (`load`), а не только в интерфейсе:
    /// файл правится руками, а 0.0 в нём означало бы невидимое приложение
    /// без единого способа вернуть его обратно.
    pub window_opacity: f32,
    /// Словарь терминов: слова, которые пользователь диктует по-английски
    /// посреди русской речи. Уходит в `initial_prompt` whisper (см.
    /// `whisper::initial_prompt`) — пустой словарь означает, что параметр не
    /// передаётся вовсе, а не что передаётся пустая строка.
    ///
    /// По умолчанию заполнен списком ходовых терминов разработки и облаков
    /// (`DEFAULT_DICTIONARY`). Это дефолт serde, то есть подставляется только
    /// когда поля в файле нет: очищенный пользователем словарь остаётся
    /// очищенным и сидом не перезаписывается.
    pub dictionary: String,
    /// Роли диктора для ИИ-правки расшифровки. Пустой список — функция
    /// не настроена, селектор в панели не показывается вовсе.
    pub dictor_roles: Vec<DictorRole>,
    /// id активной роли. `None` — правка выключена: whisper-текст уходит
    /// пользователю как есть, ни одного сетевого запроса не происходит.
    /// Это и дефолт: функция строго opt-in (см. бриф — «опционально»).
    pub dictor_role: Option<String>,
}

/// Сид словаря: английские термины, которые русскоговорящий разработчик
/// произносит как есть посреди русской фразы, а whisper без подсказки
/// превращает в кириллицу.
///
/// Длина выбрана не на глаз. whisper.cpp берёт из подсказки не больше
/// `n_text_ctx/2` токенов (whisper.cpp, строка 5617: `std::min(n_max_text_ctx,
/// whisper_n_text_ctx(ctx)/2)`), а `n_text_ctx` у всех моделей 448 — то есть
/// потолок 224 токена. Причём лишнее отбрасывается с НАЧАЛА списка и молча:
/// длинный словарь не расширит охват, а тихо потеряет первую половину.
/// Поэтому здесь плотный список коротких терминов, а не связный текст.
/// Сколько бюджета занято прямо сейчас, пользователь теперь видит в поле
/// настроек: число считает токенизатор самой модели (см.
/// `commands::count_prompt_tokens`), а не оценка по длине.
///
/// ПО ТЕРМИНУ В СТРОКЕ, а не через запятую, как было раньше. Разницы для
/// whisper нет никакой: `initial_prompt` разбивает и по переносам, и по
/// запятым, и в обоих случаях склеивает обратно через ", ". Форма выбрана
/// по тому, как список правят: поле словаря в настройках — редактор с
/// Vim-биндингами (src/DictionaryField.tsx), а там строка это единица
/// работы. `dd` выбрасывает термин, `j`/`k` ходят по терминам, `/docker`
/// ищет термин. На одной длинной строке через запятую то же `dd` стёрло бы
/// словарь целиком. Значения, уже сохранённые пользователями через запятую,
/// при этом продолжают работать как работали — сид не мигрирует чужой текст.
/// Дефолтные языки перевода. Те же три, что видит пользователь в поле
/// настроек, — и та же строка, из которой строится подменю Translate, когда
/// поле пусто (см. `translate_languages`). Дублируется на фронтенде
/// (DEFAULT_TRANSLATE_LANGUAGES в src/action-tree.ts) ровно как остальные
/// дефолты: там это заглушка до первого ответа get_settings.
pub const DEFAULT_TRANSLATE_LANGUAGES: &str = "English, Spanish, Russian";

pub const DEFAULT_DICTIONARY: &str = "commit\n\
merge\n\
rebase\n\
pull request\n\
branch\n\
revert\n\
deploy\n\
rollback\n\
backend\n\
frontend\n\
endpoint\n\
payload\n\
middleware\n\
migration\n\
schema\n\
query\n\
cache\n\
webhook\n\
latency\n\
throughput\n\
API\n\
REST\n\
GraphQL\n\
gRPC\n\
JWT\n\
OAuth\n\
CORS\n\
component\n\
props\n\
hook\n\
render\n\
bundle\n\
hydration\n\
TypeScript\n\
React\n\
Kubernetes\n\
Docker\n\
container\n\
pod\n\
namespace\n\
ingress\n\
Helm\n\
Terraform\n\
pipeline\n\
artifact\n\
rollout\n\
canary\n\
load balancer\n\
autoscaling\n\
Prometheus\n\
Grafana\n\
Google Cloud\n\
BigQuery\n\
Cloud Run\n\
Pub/Sub\n\
Firestore\n\
GKE\n\
IAM\n\
Cloud Storage\n\
Secret Manager\n\
Cloud Build\n\
AWS\n\
EC2\n\
S3\n\
Lambda\n\
DynamoDB\n\
RDS\n\
ECS\n\
EKS\n\
Fargate\n\
CloudWatch";

/// Сид ролей диктора — типовые профессии со специфичной терминологией,
/// которую whisper чаще всего перевирает. Тот же механизм, что у сида
/// словаря: дефолт serde подставляется только когда поля НЕТ в файле —
/// отредактированный или очищенный пользователем список не воскресает.
///
/// id — фиксированные слаги с префиксом "seed-", а не UUID: сид обязан
/// быть детерминированным (один и тот же файл настроек после каждого
/// запуска), а столкновение с ролями пользователя исключено — фронтенд
/// выдаёт новым ролям crypto.randomUUID().
///
/// Промпты на английском, как и системная рамка (см. buildRoleSystemPrompt
/// в src/dictor-roles.ts): рамка и вкладыш читаются моделью как один текст.
/// Каждый промпт называет, КТО говорит и КАКИЕ термины ожидать, — ровно те
/// два сигнала, по которым модель чинит перевранное слово.
fn seed_role(id: &str, name: &str, prompt: &str) -> DictorRole {
    DictorRole {
        id: format!("seed-{id}"),
        name: name.to_string(),
        prompt: prompt.to_string(),
    }
}

pub fn default_dictor_roles() -> Vec<DictorRole> {
    vec![
        seed_role(
            "programmer",
            "Programmer",
            "The speaker is a software developer. Expect programming and tooling terms: \
             git (commit, merge, rebase, pull request), backend, frontend, endpoint, \
             payload, deploy, rollback, refactoring, debugging, framework names (React, \
             TypeScript, Rust), databases, Docker, Kubernetes, CI/CD. Variable names and \
             code identifiers may appear mid-sentence — keep their exact spelling.",
        ),
        seed_role(
            "architect",
            "Software Architect",
            "The speaker is a software architect. Expect system design vocabulary: \
             microservices, monolith, event-driven, message broker, API gateway, \
             load balancer, scalability, latency, throughput, consistency, caching, \
             sharding, domain-driven design, bounded context, coupling, cohesion, \
             trade-off, technical debt, SLA, fault tolerance.",
        ),
        seed_role(
            "project-manager",
            "Project Manager",
            "The speaker is a project manager. Expect delivery and process terms: \
             sprint, backlog, standup, retrospective, roadmap, milestone, deadline, \
             stakeholder, scope, estimate, velocity, burndown, Jira, epic, user story, \
             acceptance criteria, risk, dependency, OKR, KPI, release plan.",
        ),
        seed_role(
            "devops",
            "DevOps Engineer",
            "The speaker is a DevOps / SRE engineer. Expect infrastructure terms: \
             pipeline, deployment, container, Kubernetes, Helm, Terraform, Ansible, \
             monitoring, alerting, Prometheus, Grafana, incident, postmortem, SLO, SLI, \
             autoscaling, ingress, namespace, secret, cloud providers (AWS, GCP, Azure) \
             and their services (EC2, S3, Lambda, Cloud Run, BigQuery).",
        ),
        seed_role(
            "data-scientist",
            "Data Scientist",
            "The speaker is a data scientist / ML engineer. Expect data and ML terms: \
             dataset, feature, model, training, inference, overfitting, regression, \
             classification, neural network, transformer, embedding, fine-tuning, \
             hyperparameter, pipeline, pandas, NumPy, PyTorch, SQL, A/B test, metric, \
             precision, recall, baseline.",
        ),
        seed_role(
            "designer",
            "Product Designer",
            "The speaker is a product / UX designer. Expect design vocabulary: \
             wireframe, mockup, prototype, user flow, usability, accessibility, \
             design system, component, typography, grid, spacing, contrast, Figma, \
             breakpoint, responsive, onboarding, empty state, call to action, \
             user research, heuristic evaluation.",
        ),
        seed_role(
            "marketer",
            "Marketer",
            "The speaker is a marketing specialist. Expect marketing terms: campaign, \
             funnel, conversion, CTR, CPC, CPA, ROI, retention, churn, engagement, \
             lead generation, landing page, SEO, SEM, A/B test, audience segmentation, \
             brand awareness, positioning, copy, CRM, newsletter, social media channels.",
        ),
        seed_role(
            "sales",
            "Sales Manager",
            "The speaker is a sales manager. Expect sales vocabulary: pipeline, lead, \
             prospect, qualification, discovery call, demo, proposal, quota, forecast, \
             close rate, upsell, cross-sell, churn, renewal, CRM (Salesforce, HubSpot), \
             deal stage, objection handling, pricing tier, contract, procurement.",
        ),
        seed_role(
            "lawyer",
            "Lawyer",
            "The speaker is a lawyer. Expect legal terminology: contract, clause, \
             liability, indemnification, jurisdiction, compliance, due diligence, \
             intellectual property, NDA, arbitration, litigation, plaintiff, defendant, \
             statute, regulation, GDPR, terms of service, breach, damages, settlement.",
        ),
        seed_role(
            "physician",
            "Physician",
            "The speaker is a medical professional. Expect clinical terminology: \
             diagnosis, symptom, anamnesis, prognosis, chronic, acute, dosage, \
             contraindication, drug names, anatomical terms, lab values, MRI, CT, ECG, \
             blood pressure, therapy, remission, referral, ICD codes. Keep drug names \
             and dosages exactly as spelled.",
        ),
        seed_role(
            "finance",
            "Financial Analyst",
            "The speaker is a finance professional. Expect financial terms: revenue, \
             EBITDA, margin, cash flow, balance sheet, P&L, forecast, budget, variance, \
             CAPEX, OPEX, valuation, equity, liability, amortization, depreciation, \
             ROI, IRR, liquidity, portfolio, hedge, interest rate, fiscal quarter.",
        ),
    ]
}

/// Дефолтный хоткей захвата — Ctrl+Cmd+Space. Функция, а не константа,
/// потому что `Default for Settings` ниже собирает `String`, и это её
/// единственный потребитель: `#[serde(default)]` на всей структуре уже
/// берёт значение оттуда же.
fn default_capture_hotkey() -> String {
    "Ctrl+Super+Space".to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // Cmd+T — сознательный выбор пользователя, несмотря на коллизию
            // с «New Tab» в большинстве приложений; предупреждение об этом
            // теперь в подсказке настроек, а не здесь.
            hotkey: "Super+KeyT".to_string(),
            capture_hotkey: default_capture_hotkey(),
            model_path: None,
            language: "auto".to_string(),
            vad_model_path: None,
            // Enter — уже существовавшее поведение до того, как оно стало
            // настраиваемым; голая клавиша допустима именно потому, что это
            // окно-локальный хоткей, а не глобальный (см. комментарий у поля).
            paste_shortcut: "Enter".to_string(),
            // Cmd+C — стандартное системное сочетание для копирования.
            copy_shortcut: "Super+KeyC".to_string(),
            // Cmd+F — F от Follow, хотя в том же приложении уже занят Fix
            // (`fix_shortcut` ниже) той же комбинацией. Не коллизия: Follow
            // живёт в панели, Fix — в главном окне, а в фокусе всегда ровно
            // одно окно, поэтому одна и та же комбинация в двух РАЗНЫХ окнах
            // никогда не запускает оба сразу (см. область/scope в
            // src/shortcut-conflicts.ts на фронтенде — это проверено тестом).
            follow_shortcut: "Super+KeyF".to_string(),
            // Действия главного окна — все с Cmd: поле текста там это
            // CodeMirror с Vim, и голая клавиша (как и Ctrl-комбинация) была
            // бы отобрана у редактирования. В грамматике Vim модификатора
            // Cmd не бывает вовсе, поэтому Cmd+буква не пересекается ни с
            // normal-, ни с insert-режимом. Буквы — мнемоника действия, кроме
            // Translate: Cmd+T занят глобальным хоткеем записи выше, поэтому
            // взята L («language»).
            translate_shortcut: "Super+KeyL".to_string(),
            // Cmd+K — сложившееся «спросить ИИ» в редакторах.
            ask_ai_shortcut: "Super+KeyK".to_string(),
            // Cmd+G — мнемоника Generate; «найти следующее» из стандартного
            // меню macOS в приложении отсутствует, сочетание свободно.
            generate_shortcut: "Super+KeyG".to_string(),
            // Cmd+F — мнемоника Fix; поиска по тексту в приложении нет,
            // сочетание свободно.
            fix_shortcut: "Super+KeyF".to_string(),
            // Cmd+S — мнемоника Shorten; сохранять в главном окне нечего.
            shorten_shortcut: "Super+KeyS".to_string(),
            // Cmd+U — вторая буква Summarize: S уже у Shorten, а Cmd+M
            // (третья по мнемонике) — системный Minimize, его перехватывает
            // меню приложения раньше, чем нажатие дойдёт до окна. Cmd+U ни в
            // стандартном меню macOS, ни в Vim ничем не занят.
            summarize_shortcut: "Super+KeyU".to_string(),
            // Cmd+Enter — сложившееся «отправить» в окнах, где сначала пишут,
            // а потом отдают написанное. В грамматике Vim Cmd нет, поэтому
            // комбинация не отбирает Enter ни у insert-режима (перенос
            // строки), ни у normal-режима.
            main_paste_shortcut: "Super+Enter".to_string(),
            // Cmd+C — тот же, что у панели: копирование оно и есть
            // копирование, в грамматике Vim Cmd не встречается.
            main_copy_shortcut: "Super+KeyC".to_string(),
            // Shift+Cmd+Enter — тот же «подтвердить», что у Paste, но с
            // добавленным Shift. Два модификатора здесь не педантизм: Accept
            // затирает текст пользователя предложением модели, и вернуть
            // прежний можно только через Undo редактора, — а Cmd+Enter (Paste)
            // человек в этом же окне жмёт привычно и часто. Соседство
            // помогает помнить (⇧⌘⏎ принять → ⌘⏎ вставить), лишний Shift
            // мешает попасть случайно.
            accept_shortcut: "Shift+Super+Enter".to_string(),
            ai: AiSettings::default(),
            translate_languages: DEFAULT_TRANSLATE_LANGUAGES.to_string(),
            // 1.0 — «как было до появления ползунка»: настройка не должна
            // менять звук у тех, кто её не трогал.
            mic_gain: crate::audio::DEFAULT_GAIN,
            // Дефолт whisper.cpp; ниже — VAD чаще считает звук речью и меньше
            // режет, выше — строже.
            vad_threshold: DEFAULT_VAD_THRESHOLD,
            // «System default» — следовать за системой. Это же и поведение,
            // которое было до появления выбора устройства.
            input_device: None,
            // Включено по умолчанию: запись под играющее видео — обычный
            // сценарий, а откат на cpal при сбое VPIO автоматический.
            echo_cancellation: true,
            // Включён из коробки: ниже 80 Гц речи нет, резать нечего, кроме
            // гула; выключатель — на случай записи не-речи.
            high_pass_filter: true,
            window_opacity: DEFAULT_WINDOW_OPACITY,
            dictionary: DEFAULT_DICTIONARY.to_string(),
            // Сид типовых профессий (см. default_dictor_roles) — как у
            // словаря: подставляется только при отсутствии поля в файле,
            // правки и очистка пользователя не перезаписываются.
            dictor_roles: default_dictor_roles(),
            // Активной роли по умолчанию НЕТ: правка — это сетевой запрос с
            // текстом речи на каждую диктовку, такое включают только явно.
            dictor_role: None,
        }
    }
}

/// Границы порога VAD. Крайности бесполезны: 0.0 — «всё речь» (VAD ничего не
/// делает), 1.0 — «ничего не речь» (вырезается вся запись).
pub const MIN_VAD_THRESHOLD: f32 = 0.1;
pub const MAX_VAD_THRESHOLD: f32 = 0.9;
/// Дефолт whisper.cpp — значение, с которым VAD работал до появления ползунка.
pub const DEFAULT_VAD_THRESHOLD: f32 = 0.5;

/// Границы непрозрачности окон. Нижняя — не вкусовая: ниже половины текст на
/// пёстрых обоях перестаёт читаться, а окно становится неотличимо от того,
/// что под ним. Верхняя — обычное непрозрачное окно, то есть «выключено».
pub const MIN_WINDOW_OPACITY: f32 = 0.5;
pub const MAX_WINDOW_OPACITY: f32 = 1.0;
/// По умолчанию чуть прозрачно: ровно та просьба, с которой всё началось, —
/// «видеть, поверх чего открыто окно», не теряя при этом сами окна.
pub const DEFAULT_WINDOW_OPACITY: f32 = 0.9;

/// Зажимает непрозрачность в рабочий диапазон. NaN не проходит ни одного
/// сравнения, из-за чего `clamp` на нём паникует, — отдельная ветка до
/// clamp, тот же приём, что в `audio::apply_gain` и
/// `whisper::clamp_vad_threshold`.
pub fn clamp_window_opacity(opacity: f32) -> f32 {
    if opacity.is_nan() {
        return DEFAULT_WINDOW_OPACITY;
    }
    opacity.clamp(MIN_WINDOW_OPACITY, MAX_WINDOW_OPACITY)
}

/// Битый или отсутствующий файл — не ошибка: возвращаем дефолты, чтобы
/// приложение всегда стартовало.
/// ponytail: без резервных копий и версионирования схемы, добавить когда полей станет много
pub fn load(dir: &Path) -> Settings {
    let mut s: Settings = std::fs::read_to_string(dir.join(FILE_NAME))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    // Единственное поле, которое зажимается прямо здесь, а не при применении,
    // как усиление и порог VAD. Причина в цене ошибки: неверное усиление
    // слышно и правится, а windowOpacity = 0 в файле, дописанный руками,
    // делает невидимым и окно настроек тоже — исправить его стало бы
    // неоткуда, кроме как тем же текстовым редактором.
    s.window_opacity = clamp_window_opacity(s.window_opacity);
    s
}

pub fn save(dir: &Path, s: &Settings) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir).context("Couldn't create the settings folder.")?;
    let raw = serde_json::to_string_pretty(s)?;
    std::fs::write(dir.join(FILE_NAME), raw).context("Couldn't write settings to disk.")?;
    Ok(())
}

#[cfg(test)]
mod tests {

    /// Сид словаря обязан помещаться в бюджет подсказки whisper. Потолок —
    /// 224 токена (`n_text_ctx/2`, n_text_ctx = 448 у всех моделей), и лишнее
    /// отбрасывается с начала списка МОЛЧА: без этого теста расширение
    /// словаря выглядело бы работающим, а на деле выбивало бы из подсказки
    /// первые термины.
    ///
    /// Токенизатор здесь не доступен, поэтому считаем консервативно по
    /// символам: английский текст у BPE whisper — порядка 4 символов на
    /// токен, берём 3.5 с запасом в худшую сторону.
    ///
    /// Меряем СОБРАННУЮ подсказку (`initial_prompt`), а не длину константы.
    /// Раньше это было одно и то же — сид был записан ровно через ", ", как
    /// его и склеивает `initial_prompt`. С переходом сида на «термин в
    /// строке» длины разошлись: перенос строки — один символ, ", " — два,
    /// и на 71 термине разница около 20 токенов, которых тест бы не увидел.
    /// До whisper доезжает склейка, её и проверяем; заодно тест перестал
    /// зависеть от того, как сид отформатирован.
    /// Сид записан по термину в строке — это не оформление, а выбранная
    /// единица правки в Vim-редакторе поля (см. комментарий у
    /// DEFAULT_DICTIONARY). Проверяем именно то, что от формы зависит: ни
    /// одной пустой строки и ни одной строки, где терминов на самом деле
    /// несколько, — иначе `dd` в поле выбрасывал бы не один термин, а сколько
    /// придётся.
    #[test]
    fn default_dictionary_is_one_term_per_line() {
        for line in DEFAULT_DICTIONARY.lines() {
            assert!(!line.trim().is_empty(), "в сиде словаря пустая строка");
            assert!(
                !line.contains(','),
                "строка сида «{line}» содержит больше одного термина"
            );
        }
    }

    /// Сторожок на РАЗМЕР сида, а не на его бюджет.
    ///
    /// Прежняя версия этого теста делала вид, что считает токены: длина
    /// подсказки в БАЙТАХ, делённая на 3.5. На сиде это давало 181 при
    /// настоящих 192 (замер на живом токенизаторе, см.
    /// `whisper::tests::prompt_token_length_estimates_are_wrong_in_both_directions`),
    /// то есть тест охранял запас, которого не было, и на кириллическом
    /// словаре разошёлся бы с фронтендом вдвое. Считать токены без модели
    /// нельзя, а модели в обычном прогоне тестов нет — поэтому здесь честный
    /// сторожок: сид не должен вырасти дальше того размера, на котором его
    /// бюджет измерили.
    ///
    /// 632 символа = 192 токена из 224 — свободно 32 токена, около десятка
    /// коротких терминов. Уперлись в этот assert — перемерьте сид тестом
    /// `whisper::tests::default_dictionary_fits_the_prompt_budget` (нужен
    /// SLAIVE_MODEL) и подвиньте число вместе с результатом замера.
    #[test]
    fn default_dictionary_stays_the_size_its_budget_was_measured_at() {
        const MEASURED_CHARS: usize = 632;
        let prompt = crate::whisper::initial_prompt(DEFAULT_DICTIONARY)
            .expect("сид словаря не пуст, подсказка обязана собраться");
        let chars = prompt.chars().count();
        assert!(
            chars <= MEASURED_CHARS,
            "сид словаря вырос до {chars} символов при измеренных {MEASURED_CHARS} \
             (=192 токена из {}); перемерьте бюджет, прежде чем двигать это число",
            crate::whisper::MAX_PROMPT_TOKENS
        );
    }

    /// Диагностика жалобы «словарь пустеет после перезапуска»: командная
    /// граница (`get_settings`/`save_settings` в commands.rs) здесь не
    /// участвует, но тест бьёт по тому же пути (save → load), что и она —
    /// `dictionary` живёт в ОДНОЙ структуре `Settings` с общей аннотацией
    /// serde, а не в отдельной с другой формой, так что нестыковки регистра
    /// полей между Rust и фронтендом здесь взяться неоткуда. Настоящая
    /// причина была не здесь (см. commit message) — это сторожок на будущее,
    /// с сидом полного размера, а не двумя строками, как у `round_trip` выше.
    #[test]
    fn full_seed_dictionary_survives_save_then_load() {
        let dir = tmp();
        let s = Settings::default();
        assert_eq!(s.dictionary, DEFAULT_DICTIONARY);
        save(&dir, &s).unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.dictionary, DEFAULT_DICTIONARY);
        assert!(!loaded.dictionary.is_empty());
    }

    /// Очищенный пользователем словарь не должен воскресать из сида: дефолт
    /// serde подставляется только при ОТСУТСТВИИ поля, а не при пустом.
    #[test]
    fn empty_dictionary_survives_roundtrip() {
        let mut s = Settings::default();
        s.dictionary = String::new();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.dictionary, "");
    }
    use super::*;

    // tmp() из брифа использовал только process::id(), который одинаков для
    // всех тестов в этом бинарнике — при параллельных потоках cargo тесты
    // гонялись за одну и ту же папку и флакали. Добавлен id потока, чтобы
    // каждый параллельно выполняющийся тест был изолирован; проверки не менялись.
    fn tmp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "slaive-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn defaults_when_file_missing() {
        let dir = tmp();
        let s = load(&dir);
        assert_eq!(s.hotkey, "Super+KeyT");
        assert_eq!(s.model_path, None);
        assert_eq!(s.language, "auto");
        assert_eq!(s.vad_model_path, None);
        assert_eq!(s.paste_shortcut, "Enter");
        assert_eq!(s.copy_shortcut, "Super+KeyC");
        // Cmd+F, тот же, что у Fix (fix_shortcut ниже) — не столкновение:
        // Follow в панели, Fix в главном окне, проверка столкновений
        // (src/shortcut-conflicts.ts) знает об этом через область поля.
        assert_eq!(s.follow_shortcut, "Super+KeyF");
        assert_eq!(s.translate_shortcut, "Super+KeyL");
        assert_eq!(s.ask_ai_shortcut, "Super+KeyK");
        assert_eq!(s.generate_shortcut, "Super+KeyG");
        assert_eq!(s.fix_shortcut, "Super+KeyF");
        assert_eq!(s.shorten_shortcut, "Super+KeyS");
        // Не Cmd+S (занят Shorten) и не Cmd+M (системный Minimize).
        assert_eq!(s.summarize_shortcut, "Super+KeyU");
        // Cmd+Enter, а не голый Enter как у панели: в главном окне Enter
        // принадлежит редактору (см. комментарий у поля).
        assert_eq!(s.main_paste_shortcut, "Super+Enter");
        // Cmd+C, как у панели: области разные, столкновения нет.
        assert_eq!(s.main_copy_shortcut, "Super+KeyC");
        // Shift+Cmd+Enter — намеренно туже, чем Paste: Accept затирает текст
        // пользователя предложением модели.
        assert_eq!(s.accept_shortcut, "Shift+Super+Enter");
        assert_eq!(s.translate_languages, "English, Spanish, Russian");
        assert_eq!(s.mic_gain, 1.0);
        assert_eq!(s.vad_threshold, 0.5);
        assert_eq!(s.input_device, None);
        // Эхоподавление включено из коробки: запись под играющее видео —
        // обычный сценарий, а при сбое VPIO откат на cpal автоматический.
        assert!(s.echo_cancellation);
        assert!(s.high_pass_filter);
        // Чуть прозрачно, но не настолько, чтобы это мешало: см. бриф.
        assert_eq!(s.window_opacity, 0.9);
        assert_eq!(s.dictionary, DEFAULT_DICTIONARY);
    }

    /// Настройка визуальная, но значение в ней — не вкусовое: 0.0 в файле,
    /// дописанный руками или оставшийся от сломанной записи, сделал бы
    /// невидимым и окно настроек, то есть отобрал бы единственный способ
    /// вернуть всё назад. Поэтому мусор зажимается при ЧТЕНИИ, а не при
    /// применении — в отличие от усиления и порога VAD.
    #[test]
    fn window_opacity_is_clamped_when_read_from_a_junk_file() {
        let dir = tmp();
        let write_and_load = |raw: &str| {
            std::fs::write(dir.join("settings.json"), raw).unwrap();
            load(&dir).window_opacity
        };
        assert_eq!(write_and_load(r#"{"windowOpacity":0.0}"#), MIN_WINDOW_OPACITY);
        assert_eq!(write_and_load(r#"{"windowOpacity":-5.0}"#), MIN_WINDOW_OPACITY);
        assert_eq!(write_and_load(r#"{"windowOpacity":42.0}"#), MAX_WINDOW_OPACITY);
        // Значение внутри диапазона проходит как есть — зажимаются края, а
        // не выбор пользователя.
        assert_eq!(write_and_load(r#"{"windowOpacity":0.7}"#), 0.7);
        // Поля нет вовсе — настройки, сохранённые до появления ползунка.
        assert_eq!(write_and_load(r#"{"hotkey":"Alt+Space"}"#), DEFAULT_WINDOW_OPACITY);
    }

    /// NaN не проходит ни одного сравнения, и `f32::clamp` на нём паникует —
    /// то есть настройки с `NaN` в файле роняли бы приложение на старте,
    /// а не просто выглядели бы странно.
    /// Дефолтные комбинации не должны совпадать между собой ВНУТРИ одной
    /// области перехвата. Ту же проверку для комбинаций, которые назначил
    /// пользователь, делает фронтенд (src/shortcut-conflicts.ts) — область
    /// там называется `ShortcutScope`, и правило то же: 'global' занимает
    /// клавишу системно, до окна события не доходит, и конфликтует с чем
    /// угодно; 'panel' и 'main' — окна, в фокусе всегда только одно из них,
    /// и одна и та же комбинация в разных окнах друг другу не мешает.
    /// ДЕФОЛТЫ рождаются здесь и до фронтендовой проверки не доходят:
    /// сломать их правкой `Default` можно молча, а наружу это выйдет как
    /// «кнопка перестала работать из коробки».
    ///
    /// Escape (Back/Cancel в главном окне) в список не входит намеренно: он
    /// не хранится и назначить его на что-то ещё нельзя — ShortcutCapture
    /// трактует Escape как отмену записи комбинации, поэтому столкнуться с
    /// ним структурно нечему.
    #[test]
    fn default_shortcuts_do_not_collide() {
        let s = Settings::default();
        let all = [
            ("hotkey", &s.hotkey, "global"),
            ("captureHotkey", &s.capture_hotkey, "global"),
            ("pasteShortcut", &s.paste_shortcut, "panel"),
            ("copyShortcut", &s.copy_shortcut, "panel"),
            ("followShortcut", &s.follow_shortcut, "panel"),
            ("mainPasteShortcut", &s.main_paste_shortcut, "main"),
            ("mainCopyShortcut", &s.main_copy_shortcut, "main"),
            ("acceptShortcut", &s.accept_shortcut, "main"),
            ("translateShortcut", &s.translate_shortcut, "main"),
            ("askAiShortcut", &s.ask_ai_shortcut, "main"),
            ("generateShortcut", &s.generate_shortcut, "main"),
            ("fixShortcut", &s.fix_shortcut, "main"),
            ("shortenShortcut", &s.shorten_shortcut, "main"),
            ("summarizeShortcut", &s.summarize_shortcut, "main"),
        ];
        for (i, (name_a, accel_a, scope_a)) in all.iter().enumerate() {
            for (name_b, accel_b, scope_b) in all.iter().skip(i + 1) {
                let can_collide = *scope_a == "global" || *scope_b == "global" || scope_a == scope_b;
                if !can_collide {
                    continue;
                }
                assert_ne!(
                    accel_a, accel_b,
                    "дефолты {name_a} и {name_b} заняли одну комбинацию {accel_a}"
                );
            }
        }
    }

    #[test]
    fn nan_opacity_falls_back_to_the_default_instead_of_panicking() {
        assert_eq!(clamp_window_opacity(f32::NAN), DEFAULT_WINDOW_OPACITY);
        assert_eq!(clamp_window_opacity(f32::INFINITY), MAX_WINDOW_OPACITY);
        assert_eq!(clamp_window_opacity(f32::NEG_INFINITY), MIN_WINDOW_OPACITY);
    }

    #[test]
    fn round_trip() {
        let dir = tmp();
        let mut providers = BTreeMap::new();
        providers.insert(
            "openai".to_string(),
            ProviderConfig {
                model: "gpt-4o-mini".to_string(),
                base_url: None,
            },
        );
        let s = Settings {
            hotkey: "Alt+Space".into(),
            capture_hotkey: "Ctrl+Super+Space".into(),
            model_path: Some(std::path::PathBuf::from("/tmp/ggml-small.bin")),
            language: "ru".into(),
            vad_model_path: Some(std::path::PathBuf::from("/tmp/ggml-silero-v5.1.2.bin")),
            paste_shortcut: "Shift+Enter".into(),
            copy_shortcut: "Ctrl+Alt+KeyC".into(),
            follow_shortcut: "Ctrl+Alt+KeyF".into(),
            translate_shortcut: "Ctrl+KeyL".into(),
            ask_ai_shortcut: "Ctrl+KeyK".into(),
            generate_shortcut: "Ctrl+KeyG".into(),
            fix_shortcut: "Ctrl+KeyF".into(),
            shorten_shortcut: "Ctrl+KeyS".into(),
            summarize_shortcut: "Ctrl+KeyU".into(),
            main_paste_shortcut: "Ctrl+Enter".into(),
            main_copy_shortcut: "Ctrl+Super+KeyC".into(),
            accept_shortcut: "Ctrl+Shift+Enter".into(),
            ai: AiSettings {
                provider: "openai".into(),
                providers,
            },
            translate_languages: "German\nJapanese".into(),
            mic_gain: 3.5,
            vad_threshold: 0.35,
            input_device: Some("Пётр's iPhone Microphone".into()),
            echo_cancellation: false,
            high_pass_filter: false,
            window_opacity: 0.75,
            dictionary: "React\nTypeScript".into(),
            dictor_roles: vec![DictorRole {
                id: "11111111-2222-3333-4444-555555555555".into(),
                name: "Программист".into(),
                prompt: "Я программист, почини термины.".into(),
            }],
            dictor_role: Some("11111111-2222-3333-4444-555555555555".into()),
        };
        save(&dir, &s).unwrap();
        assert_eq!(load(&dir), s);
    }

    /// Настройки, сохранённые до появления ролей диктора, не должны
    /// переставать загружаться — та же гарантия, что у VAD, Paste/Copy и
    /// словаря выше: отсутствующее поле берёт сид, активная роль остаётся
    /// выключенной (правка — сетевой запрос, такое включают только явно),
    /// соседи читаются как раньше.
    #[test]
    fn settings_without_dictor_roles_fall_back_to_the_seed() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.dictor_roles, default_dictor_roles());
        assert_eq!(s.dictor_role, None);
        assert_eq!(s.language, "ru");
    }

    /// Очищенный список ролей остаётся очищенным: сид подставляется только
    /// при ОТСУТСТВИИ поля — тот же инвариант, что у словаря и языков
    /// перевода выше. Без этого удаление ненужных ролей жило бы до
    /// перезапуска.
    #[test]
    fn cleared_dictor_roles_survive_roundtrip() {
        let mut s = Settings::default();
        s.dictor_roles = Vec::new();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert!(back.dictor_roles.is_empty());
    }

    /// Сид ролей обязан быть пригодным как есть: id уникальны (селектор и
    /// активная роль ищут по id), имена и промпты не пусты (пустая роль в
    /// селекторе — мусор, пустой промпт — бессмысленный сетевой запрос),
    /// активной роли среди них нет — функция строго opt-in.
    #[test]
    fn seed_roles_are_unique_named_and_prompted() {
        let roles = default_dictor_roles();
        assert!(!roles.is_empty());
        let mut ids = std::collections::BTreeSet::new();
        for r in &roles {
            assert!(ids.insert(r.id.clone()), "дублирующийся id в сиде: {}", r.id);
            assert!(r.id.starts_with("seed-"), "id сида без префикса: {}", r.id);
            assert!(!r.name.trim().is_empty(), "роль {} без имени", r.id);
            assert!(!r.prompt.trim().is_empty(), "роль {} без промпта", r.id);
        }
        assert_eq!(Settings::default().dictor_role, None);
    }

    /// Настройки, сохранённые до появления выбора устройства и словаря, не
    /// должны переставать загружаться — та же гарантия, что уже отработана
    /// для VAD, Paste/Copy и усиления выше. Перекладка интерфейса не имеет
    /// права менять формат хранения.
    #[test]
    fn settings_without_device_and_dictionary_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru","micGain":2.0,"vadThreshold":0.4}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.input_device, None);
        // Отсутствующее в файле поле берёт сид, а не пустую строку.
        assert_eq!(s.dictionary, DEFAULT_DICTIONARY);
        // Соседние поля по-прежнему читаются как раньше.
        assert_eq!(s.hotkey, "Alt+Space");
        assert_eq!(s.language, "ru");
        assert_eq!(s.mic_gain, 2.0);
        assert_eq!(s.vad_threshold, 0.4);
        assert_eq!(s.model_path, Some(std::path::PathBuf::from("/tmp/ggml-small.bin")));
    }

    /// Полный набор полей, записанный прежней версией приложения, должен
    /// пережить круг «загрузить → сохранить → загрузить» без потерь: перекладка
    /// интерфейса не должна тихо выронить ни одного значения.
    #[test]
    fn every_stored_field_survives_a_load_save_load_cycle() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{
              "hotkey":"Alt+Space",
              "modelPath":"/tmp/ggml-small.bin",
              "language":"ru",
              "vadModelPath":"/tmp/ggml-silero-v5.1.2.bin",
              "pasteShortcut":"Shift+Enter",
              "copyShortcut":"Ctrl+Alt+KeyC",
              "translateShortcut":"Ctrl+KeyL",
              "askAiShortcut":"Ctrl+KeyK",
              "fixShortcut":"Ctrl+KeyF",
              "shortenShortcut":"Ctrl+KeyS",
              "ai":{"provider":"openai","providers":{"openai":{"model":"gpt-4o","baseUrl":"https://example.test/v1"}}},
              "micGain":3.5,
              "vadThreshold":0.35
            }"#,
        )
        .unwrap();
        let first = load(&dir);
        save(&dir, &first).unwrap();
        let second = load(&dir);
        assert_eq!(first, second);
        assert_eq!(second.hotkey, "Alt+Space");
        assert_eq!(second.paste_shortcut, "Shift+Enter");
        assert_eq!(second.copy_shortcut, "Ctrl+Alt+KeyC");
        assert_eq!(second.translate_shortcut, "Ctrl+KeyL");
        assert_eq!(second.ask_ai_shortcut, "Ctrl+KeyK");
        assert_eq!(second.fix_shortcut, "Ctrl+KeyF");
        assert_eq!(second.shorten_shortcut, "Ctrl+KeyS");
        // Полей mainPasteShortcut, summarizeShortcut и translateLanguages в
        // этом файле нет — он написан версией до кнопки Paste в главном окне и
        // до Summarize. Они обязаны взять дефолт и не мешать читаться соседям,
        // а не уронить загрузку целиком.
        assert_eq!(second.main_paste_shortcut, "Super+Enter");
        assert_eq!(second.summarize_shortcut, "Super+KeyU");
        assert_eq!(second.translate_languages, DEFAULT_TRANSLATE_LANGUAGES);
        assert_eq!(second.language, "ru");
        assert_eq!(second.mic_gain, 3.5);
        assert_eq!(second.vad_threshold, 0.35);
        assert_eq!(
            second.vad_model_path,
            Some(std::path::PathBuf::from("/tmp/ggml-silero-v5.1.2.bin"))
        );
        assert_eq!(second.ai.providers["openai"].model, "gpt-4o");
        assert_eq!(
            second.ai.providers["openai"].base_url.as_deref(),
            Some("https://example.test/v1")
        );
    }

    /// Настройки, сохранённые до появления усиления и порога VAD, не должны
    /// переставать загружаться — отсутствующие поля тихо становятся
    /// дефолтами, тем же путём, что уже отработан для VAD и Paste/Copy.
    #[test]
    fn settings_without_gain_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.mic_gain, 1.0);
        assert_eq!(s.vad_threshold, 0.5);
    }

    /// Настройки, сохранённые до появления VAD, не должны переставать
    /// загружаться — отсутствующее поле должно тихо стать `None`.
    #[test]
    fn settings_without_vad_field_still_load() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.vad_model_path, None);
        assert_eq!(s.language, "ru");
    }

    /// Настройки, сохранённые до появления настраиваемых Paste/Copy, не
    /// должны переставать загружаться — отсутствующие поля тихо становятся
    /// дефолтами, тем же путём, что уже отработан для VAD выше.
    #[test]
    fn settings_without_shortcut_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.paste_shortcut, "Enter");
        assert_eq!(s.copy_shortcut, "Super+KeyC");
        assert_eq!(s.follow_shortcut, "Super+KeyF");
    }

    /// То же самое для хоткеев действий главного окна: файл, записанный до их
    /// появления, обязан загрузиться, а не обнулить настройки целиком.
    #[test]
    fn settings_without_action_shortcut_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","pasteShortcut":"Shift+Enter"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.translate_shortcut, "Super+KeyL");
        assert_eq!(s.ask_ai_shortcut, "Super+KeyK");
        assert_eq!(s.generate_shortcut, "Super+KeyG");
        assert_eq!(s.fix_shortcut, "Super+KeyF");
        assert_eq!(s.shorten_shortcut, "Super+KeyS");
        assert_eq!(s.summarize_shortcut, "Super+KeyU");
        assert_eq!(s.accept_shortcut, "Shift+Super+Enter");
        assert_eq!(s.main_copy_shortcut, "Super+KeyC");
        // Соседнее поле читается как раньше.
        assert_eq!(s.paste_shortcut, "Shift+Enter");
    }

    /// Файл, записанный до появления Summarize и списка языков перевода,
    /// обязан загружаться: отсутствующие поля берут дефолт, а соседние
    /// читаются как раньше. Та же гарантия, что уже отработана для VAD,
    /// Paste/Copy, усиления и словаря выше.
    #[test]
    fn settings_without_summarize_and_languages_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","shortenShortcut":"Ctrl+KeyS","dictionary":"React"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.summarize_shortcut, "Super+KeyU");
        assert_eq!(s.translate_languages, DEFAULT_TRANSLATE_LANGUAGES);
        assert_eq!(s.shorten_shortcut, "Ctrl+KeyS");
        assert_eq!(s.dictionary, "React");
    }

    /// Очищенный список языков остаётся очищенным: дефолт serde подставляется
    /// только при ОТСУТСТВИИ поля. Подменю Translate в этом случае строится из
    /// дефолта на фронтенде (см. buildActionTree), а не воскрешением значения
    /// в файле — иначе пользователь чистил бы поле, а оно заполнялось снова.
    #[test]
    fn cleared_translate_languages_survive_roundtrip() {
        let mut s = Settings::default();
        s.translate_languages = String::new();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back.translate_languages, "");
    }

    #[test]
    fn defaults_when_file_corrupt() {
        let dir = tmp();
        std::fs::write(dir.join("settings.json"), "{ это не json").unwrap();
        assert_eq!(load(&dir), Settings::default());
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let dir = tmp();
        std::fs::write(dir.join("settings.json"), r#"{"language":"en"}"#).unwrap();
        let s = load(&dir);
        assert_eq!(s.language, "en");
        assert_eq!(s.hotkey, "Super+KeyT");
    }

    /// Настройки, сохранённые до появления ИИ-слоя, не должны переставать
    /// загружаться — отсутствующее поле `ai` тихо становится дефолтом,
    /// тем же путём, что уже отработан для VAD и Paste/Copy выше.
    #[test]
    fn settings_without_ai_field_still_load() {
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","modelPath":"/tmp/ggml-small.bin","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.ai, AiSettings::default());
    }

    /// Дефолт: OpenAI выбран и уже сконфигурирован (модель-подсказка,
    /// адрес по умолчанию) — единственный реализованный провайдер должен
    /// работать после первой же установки ключа, без похода в поле модели.
    #[test]
    fn ai_defaults_select_openai_with_a_model() {
        let ai = AiSettings::default();
        assert_eq!(ai.provider, "openai");
        let openai = ai.providers.get("openai").expect("openai должен быть предзаполнен");
        assert_eq!(openai.model, "gpt-4o-mini");
        assert_eq!(openai.base_url, None);
    }

    /// Основная гарантия брифа: переключение провайдера не должно терять
    /// настройки предыдущего — каждый провайдер хранится под своим ключом
    /// в `providers`, а не в общих полях, которые провайдеры делили бы.
    #[test]
    fn switching_provider_keeps_previous_providers_config_intact() {
        let dir = tmp();
        let mut providers = BTreeMap::new();
        providers.insert(
            "openai".to_string(),
            ProviderConfig {
                model: "gpt-4o-mini".to_string(),
                base_url: None,
            },
        );
        providers.insert(
            "openrouter".to_string(),
            ProviderConfig {
                model: "openai/gpt-4o-mini".to_string(),
                base_url: Some("https://openrouter.ai/api".to_string()),
            },
        );
        let mut s = Settings {
            ai: AiSettings {
                provider: "openai".into(),
                providers,
            },
            ..Settings::default()
        };
        save(&dir, &s).unwrap();

        // Переключились на другого провайдера и сохранили снова — запись
        // openai в карте должна остаться нетронутой.
        s.ai.provider = "openrouter".into();
        save(&dir, &s).unwrap();

        let loaded = load(&dir);
        assert_eq!(loaded.ai.provider, "openrouter");
        assert_eq!(loaded.ai.providers.get("openai").unwrap().model, "gpt-4o-mini");
        assert_eq!(
            loaded.ai.providers.get("openrouter").unwrap().model,
            "openai/gpt-4o-mini"
        );
    }

    #[test]
    fn capture_hotkey_defaults_to_ctrl_cmd_space() {
        let s = Settings::default();
        assert_eq!(s.capture_hotkey, "Ctrl+Super+Space");
    }

    #[test]
    fn missing_capture_hotkey_falls_back_to_default() {
        // Файл настроек от прежней версии не содержит этого поля вовсе —
        // оно обязано взять значение по умолчанию, а не уронить чтение.
        let dir = tmp();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"hotkey":"Alt+Space","language":"ru"}"#,
        )
        .unwrap();
        let s = load(&dir);
        assert_eq!(s.capture_hotkey, "Ctrl+Super+Space");
        assert_eq!(s.hotkey, "Alt+Space");
    }
}
