//! Конвертации форматов для round-trip захваченного текста.
//!
//! Внутри приложения текст всегда Markdown: rich-выделение из чужого окна
//! приходит HTML'ом и сразу переводится сюда (`html_to_markdown`), правится и
//! хранится как Markdown, а при вставке разворачивается в один из трёх видов —
//! живой HTML (`markdown_to_html`), голый текст без разметки
//! (`markdown_to_plain`) или сам Markdown-исходник (отдаётся как есть, без этой
//! функции). Один внутренний формат вместо матрицы «из чего во что».

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// Набор расширений Markdown, общий для обоих направлений разбора: то, что
/// Slack и прочие редакторы кладут в HTML (таблицы, зачёркивание, списки
/// задач), должно переживать круг html→md→html без потерь.
fn options() -> Options {
    Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS
}

/// HTML-выделение → Markdown. Тонкий переходник к html2md: вся возня с тегами
/// живёт там, здесь — только точка входа и место, где это решение задокументировано.
pub fn html_to_markdown(html: &str) -> String {
    html2md::parse_html(html).trim().to_string()
}

/// Markdown → HTML для «живой» вставки (жирный снова жирный). alt-текст для
/// буфера обмена делается отдельно через `markdown_to_plain`.
pub fn markdown_to_html(markdown: &str) -> String {
    let parser = Parser::new_ext(markdown, options());
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, parser);
    html
}

/// Markdown → голый текст: разметка срезана, остаётся читаемое содержимое.
/// Идём по событиям, а не регэкспами по исходнику: только так `**a**` и
/// код-блок с теми же звёздочками внутри различимы (первое — разметка,
/// второе — текст, который обязан уцелеть дословно).
pub fn markdown_to_plain(markdown: &str) -> String {
    let mut out = String::new();
    for event in Parser::new_ext(markdown, options()) {
        match event {
            // Текст и инлайн-код — само содержимое. Код-блок приходит теми же
            // Text-событиями между Start/End(CodeBlock), поэтому отдельной
            // ветки на него не нужно: его текст попадает сюда дословно.
            Event::Text(t) | Event::Code(t) => out.push_str(&t),
            // Мягкий перенос (перенос строки внутри абзаца) в голом тексте —
            // пробел; жёсткий (два пробела/`\` в конце строки) — перенос.
            Event::SoftBreak => out.push(' '),
            Event::HardBreak => out.push('\n'),
            // Конец блочного элемента — пустая строка-разделитель. Список и его
            // пункты дают перенос, чтобы строки не слипались.
            Event::End(TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock) => {
                out.push_str("\n\n")
            }
            Event::End(TagEnd::Item) => out.push('\n'),
            // Начало пункта списка — маркер, иначе перечисление теряется как факт.
            Event::Start(Tag::Item) => out.push_str("- "),
            _ => {}
        }
    }
    // Схлопываем хвосты переносов, накопленные разделителями блоков.
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_bold_becomes_markdown_bold() {
        let md = html_to_markdown("<p>Hello <b>world</b></p>");
        assert!(md.contains("**world**"), "жирный не стал Markdown: {md:?}");
    }

    #[test]
    fn markdown_bold_becomes_html_strong() {
        let html = markdown_to_html("Hello **world**");
        assert!(html.contains("<strong>world</strong>"), "жирный не стал HTML: {html:?}");
    }

    #[test]
    fn plain_strips_inline_markup_but_keeps_text() {
        let plain = markdown_to_plain("Hello **world** and `code`");
        assert_eq!(plain, "Hello world and code");
    }

    #[test]
    fn plain_keeps_code_block_contents_verbatim() {
        // Звёздочки внутри код-блока — это текст, а не разметка: срезать их
        // нельзя. Ровно тот случай, ради которого разбор идёт по событиям.
        let plain = markdown_to_plain("```\na * b = c\n```");
        assert!(plain.contains("a * b = c"), "код-блок потерял содержимое: {plain:?}");
    }

    #[test]
    fn plain_marks_list_items() {
        let plain = markdown_to_plain("- one\n- two");
        assert!(plain.contains("- one") && plain.contains("- two"), "список потерялся: {plain:?}");
    }
}
