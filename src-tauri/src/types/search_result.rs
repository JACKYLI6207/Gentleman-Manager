use anyhow::Context;
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::{
    extensions::{AppHandleExt, ToAnyhow},
    utils::filename_filter,
};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    comics: Vec<ComicInSearch>,
    current_page: i64,
    total_page: i64,
    total_count: i64,
    is_search_by_tag: bool,
}

impl SearchResult {
    pub fn from_html(
        app: &AppHandle,
        html: &str,
        is_search_by_tag: bool,
    ) -> anyhow::Result<SearchResult> {
        let document = Html::parse_document(html);
        let comic_li_selector = Selector::parse(".li.gallary_item").to_anyhow()?;

        let mut comics = Vec::new();
        for comic_li in document.select(&comic_li_selector) {
            match ComicInSearch::from_li(app, &comic_li) {
                Ok(comic) => comics.push(comic),
                Err(err) => {
                    tracing::warn!(error = %err, "列表項目解析失敗，略過");
                }
            }
        }

        let current_page = match document
            .select(&Selector::parse(".thispage").to_anyhow()?)
            .next()
        {
            Some(span) => {
                let span_html = span.html();
                span.text()
                    .next()
                    .context(format!("沒有在當前頁碼的<span>中找到文本: {span_html}"))?
                    .parse::<i64>()
                    .context(format!("當前頁碼不是整數: {span_html}"))?
            }
            None => 1,
        };

        let (total_page, total_count) = if is_search_by_tag {
            const PAGE_SIZE: i64 = 20;
            let paginator_page = parse_album_list_total_page(&document, current_page);
            if let Some(exact) = try_parse_list_total_count(&document) {
                let total_page = ((exact + PAGE_SIZE - 1) / PAGE_SIZE).max(1);
                (total_page, exact)
            } else {
                finalize_album_list_totals(comics.len(), current_page, paginator_page, PAGE_SIZE)
            }
        } else {
            const PAGE_SIZE: i64 = 20;
            let document_html = document.html();

            let b = document
                .select(&Selector::parse("#bodywrap .result > b").to_anyhow()?)
                .next()
                .context(format!("沒有找到總結果數的<b>: {document_html}"))?;
            let b_html = b.html();

            let total_count = b
                .text()
                .next()
                .context(format!("沒有在總結果數的<b>中找到文本: {b_html}"))?
                .replace(',', "")
                .parse::<i64>()
                .context(format!("總結果數不是整數: {b_html}"))?;
            let total_page = (total_count + PAGE_SIZE - 1) / PAGE_SIZE;
            (total_page, total_count)
        };

        let (total_page, total_count) = if comics.is_empty() {
            (1, 0)
        } else {
            (total_page, total_count)
        };

        Ok(SearchResult {
            comics,
            current_page,
            total_page,
            total_count,
            is_search_by_tag,
        })
    }

    pub fn from_ranking_html(app: &AppHandle, html: &str) -> anyhow::Result<SearchResult> {
        const PAGE_SIZE: i64 = 20;

        let document = Html::parse_document(html);
        let comic_li_selector = Selector::parse(".li.gallary_item").to_anyhow()?;

        let mut comics = Vec::new();
        for comic_li in document.select(&comic_li_selector) {
            match ComicInSearch::from_ranking_li(app, &comic_li) {
                Ok(comic) => comics.push(comic),
                Err(err) => tracing::warn!(message = %err, "解析排行榜條目失敗，已略過"),
            }
        }

        let current_page = document
            .select(&Selector::parse(".thispage").to_anyhow()?)
            .next()
            .and_then(|span| {
                span.text()
                    .next()
                    .and_then(|text| text.trim().parse::<i64>().ok())
            })
            .unwrap_or(1);

        let mut total_count = parse_ranking_total_count(html, &document);
        let mut total_page = if total_count <= 0 {
            1
        } else {
            (total_count + PAGE_SIZE - 1) / PAGE_SIZE
        };
        total_page = parse_ranking_total_page(&document, current_page).max(total_page);
        (total_page, total_count) = finalize_ranking_totals(
            comics.len(),
            current_page,
            total_page,
            total_count,
            PAGE_SIZE,
        );

        Ok(SearchResult {
            comics,
            current_page,
            total_page,
            total_count,
            is_search_by_tag: false,
        })
    }

    pub fn from_collected(
        all_matches: Vec<ComicInSearch>,
        page_num: i64,
        page_size: i64,
        is_search_by_tag: bool,
    ) -> Self {
        let total_count = all_matches.len() as i64;
        let total_page = if total_count == 0 {
            1
        } else {
            (total_count + page_size - 1) / page_size
        };
        let page_num = page_num.clamp(1, total_page);
        let start = ((page_num - 1) * page_size) as usize;
        let end = (start + page_size as usize).min(all_matches.len());
        let comics = if start < all_matches.len() {
            all_matches[start..end].to_vec()
        } else {
            Vec::new()
        };

        SearchResult {
            comics,
            current_page: page_num,
            total_page,
            total_count,
            is_search_by_tag,
        }
    }

    pub fn comics(&self) -> &[ComicInSearch] {
        &self.comics
    }

    pub fn total_page(&self) -> i64 {
        self.total_page
    }
}

pub fn comic_title_matches_keyword(comic: &ComicInSearch, keyword_lower: &str) -> bool {
    comic.title().to_lowercase().contains(keyword_lower)
        || comic.title_html().to_lowercase().contains(keyword_lower)
}

fn comic_id_from_href(href: &str) -> Option<i64> {
    const MARKER: &str = "/photos-index-aid-";
    let rest = href.split(MARKER).nth(1)?;
    let id_str = rest.split(['.', '?', '#']).next()?;
    id_str.parse().ok()
}

fn page_num_from_album_href(href: &str) -> Option<i64> {
    const PREFIX: &str = "/albums-index-page-";
    let rest = href.strip_prefix(PREFIX)?;
    let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num_str.parse::<i64>().ok()
}

fn page_num_from_ranking_href(href: &str) -> Option<i64> {
    const PREFIX: &str = "/albums-favorite_ranking-page-";
    let rest = href.strip_prefix(PREFIX)?;
    let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    num_str.parse::<i64>().ok()
}

fn parse_ranking_total_count(html: &str, document: &Html) -> i64 {
    let mut best = 0i64;
    let mut search_from = 0usize;
    while let Some(rel) = html[search_from..].find("共有") {
        let abs = search_from + rel;
        let window_end = html.len().min(abs + 400);
        best = best.max(max_number_in_text(&html[abs..window_end]));
        search_from = abs.saturating_add("共有".len());
    }
    if best > 0 {
        return best;
    }

    if let Ok(selector) = Selector::parse(".result em") {
        for em in document.select(&selector) {
            let text: String = em.text().collect();
            if let Some(n) = parse_digits_from_text(&text) {
                best = best.max(n);
            }
        }
        if best > 0 {
            return best;
        }
    }

    if let Ok(selector) = Selector::parse("#bodywrap .result > b") {
        if let Some(b) = document.select(&selector).next() {
            if let Some(text) = b.text().next() {
                if let Ok(n) = text.replace(',', "").trim().parse::<i64>() {
                    if n > 0 {
                        return n;
                    }
                }
            }
        }
    }

    0
}

fn max_number_in_text(text: &str) -> i64 {
    let mut best = 0i64;
    let mut digits = String::new();
    for c in text.chars() {
        if c == ',' {
            digits.push(c);
        } else if let Some(d) = c.to_digit(10) {
            digits.push(char::from_u32(u32::from(b'0') + d).unwrap_or('0'));
        } else if !digits.is_empty() {
            if let Ok(n) = digits.replace(',', "").parse::<i64>() {
                best = best.max(n);
            }
            digits.clear();
        }
    }
    if !digits.is_empty() {
        if let Ok(n) = digits.replace(',', "").parse::<i64>() {
            best = best.max(n);
        }
    }
    best
}

fn parse_digits_from_text(text: &str) -> Option<i64> {
    let n = max_number_in_text(text);
    if n > 0 {
        Some(n)
    } else {
        None
    }
}

fn finalize_ranking_totals(
    comics_on_page: usize,
    current_page: i64,
    total_page: i64,
    total_count: i64,
    page_size: i64,
) -> (i64, i64) {
    let mut total_page = total_page.max(1);
    let mut total_count = total_count;

    if total_count <= 0 {
        if total_page > 1 {
            total_count = total_page * page_size;
        } else if comics_on_page > 0 {
            total_count = (current_page - 1).max(0) * page_size + comics_on_page as i64;
        }
    }

    if total_page <= 1 && total_count > page_size {
        total_page = (total_count + page_size - 1) / page_size;
    }

    (total_page, total_count)
}

#[cfg(test)]
pub(crate) fn parse_ranking_total_count_for_test(html: &str) -> i64 {
    let document = Html::parse_document(html);
    parse_ranking_total_count(html, &document)
}

#[cfg(test)]
mod ranking_total_tests {
    use super::*;

    #[test]
    fn finalize_ranking_totals_from_comics_on_page() {
        let (page, count) = finalize_ranking_totals(20, 1, 1, 0, 20);
        assert_eq!(count, 20);
        assert_eq!(page, 1);
    }

    #[test]
    fn finalize_ranking_totals_from_total_page() {
        let (page, count) = finalize_ranking_totals(20, 2, 5, 0, 20);
        assert_eq!(count, 100);
        assert_eq!(page, 5);
    }

    #[test]
    fn parse_ranking_total_count_picks_largest_near_gongyou() {
        let html = r#"共有 33 項 · 共有 <em style="color: #c33;">60118</em> 本漫畫入選"#;
        let document = Html::parse_document(html);
        assert_eq!(parse_ranking_total_count(html, &document), 60118);
    }
}

#[cfg(test)]
mod album_list_total_tests {
    use super::*;

    #[test]
    fn finalize_album_list_totals_last_page() {
        let (page, count) = finalize_album_list_totals(8, 2, 2, 20);
        assert_eq!(count, 28);
        assert_eq!(page, 2);
    }

    #[test]
    fn finalize_album_list_totals_single_page() {
        let (page, count) = finalize_album_list_totals(28, 1, 1, 20);
        assert_eq!(count, 28);
        assert_eq!(page, 2);
    }

    #[test]
    fn finalize_album_list_totals_middle_page() {
        let (page, count) = finalize_album_list_totals(20, 1, 5, 20);
        assert_eq!(count, 100);
        assert_eq!(page, 5);
    }
}

fn parse_ranking_total_page(document: &Html, current_page: i64) -> i64 {
    let Ok(selector) = Selector::parse(".f_left.paginator > a") else {
        return current_page;
    };

    let mut max_page = current_page;

    for a in document.select(&selector) {
        if let Some(text) = a.text().next() {
            if let Ok(n) = text.trim().parse::<i64>() {
                max_page = max_page.max(n);
            }
        }
        if let Some(href) = a.attr("href") {
            if let Some(n) = page_num_from_ranking_href(href) {
                max_page = max_page.max(n);
            }
        }
    }

    max_page
}

/// 從分頁列所有連結取最大頁碼（最後一個 `<a>` 常為「下一页」等非數字）
fn parse_album_list_total_page(document: &Html, current_page: i64) -> i64 {
    let Ok(selector) = Selector::parse(".f_left.paginator > a") else {
        return current_page;
    };

    let mut max_page = current_page;

    for a in document.select(&selector) {
        if let Some(text) = a.text().next() {
            if let Ok(n) = text.trim().parse::<i64>() {
                max_page = max_page.max(n);
            }
        }
        if let Some(href) = a.attr("href") {
            if let Some(n) = page_num_from_album_href(href) {
                max_page = max_page.max(n);
            }
        }
    }

    max_page
}

fn try_parse_list_total_count(document: &Html) -> Option<i64> {
    let selector = Selector::parse("#bodywrap .result > b").ok()?;
    let b = document.select(&selector).next()?;
    let text = b.text().next()?;
    let n: i64 = text.replace(',', "").trim().parse().ok()?;
    if n > 0 { Some(n) } else { None }
}

fn finalize_album_list_totals(
    comics_on_page: usize,
    current_page: i64,
    total_page: i64,
    page_size: i64,
) -> (i64, i64) {
    let mut total_page = total_page.max(current_page).max(1);
    let on_page = comics_on_page as i64;
    let mut total_count = if on_page < page_size || current_page >= total_page {
        (current_page - 1).max(0) * page_size + on_page
    } else {
        total_page * page_size
    };
    if total_page <= 1 && total_count > page_size {
        total_page = (total_count + page_size - 1) / page_size;
    }
    (total_page, total_count)
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ComicInSearch {
    /// 漫畫id
    id: i64,
    /// 漫畫標題(帶html標籤，用於顯示匹配關鍵詞)
    title_html: String,
    /// 漫畫標題
    title: String,
    /// 封面鏈接
    cover: String,
    /// 額外資訊(209張圖片， 創建於2025-01-05 18:33:19)
    additional_info: String,
    /// 是否已下載
    is_downloaded: bool,
    /// 列表項上的官網分類 id（pic_box cate-{id}），用於分類內標籤篩選
    list_cate_id: Option<i64>,
}

impl ComicInSearch {
    pub fn id(&self) -> i64 {
        self.id
    }

    pub fn from_ranking_li(app: &AppHandle, li: &ElementRef) -> anyhow::Result<ComicInSearch> {
        match Self::from_li(app, li) {
            Ok(comic) => return Ok(comic),
            Err(err) => tracing::trace!(message = %err, "排行榜條目標準解析失敗，嘗試備用解析"),
        }

        let li_html = li.html();
        let comic_link_selector = Selector::parse("a[href*=\"/photos-index-aid-\"]").to_anyhow()?;
        let caption_selector =
            Selector::parse(".caption a[href*=\"/photos-index-aid-\"]").to_anyhow()?;
        let title_a = li
            .select(&comic_link_selector)
            .chain(li.select(&caption_selector))
            .find(|a| {
                a.attr("href")
                    .is_some_and(|href| href.contains("/photos-index-aid-"))
            })
            .context(format!("沒有在<li>中找到漫畫連結: {li_html}"))?;

        Self::from_title_anchor(app, li, &title_a)
    }

    fn from_title_anchor(
        app: &AppHandle,
        li: &ElementRef,
        title_a: &ElementRef,
    ) -> anyhow::Result<ComicInSearch> {
        let title_a_html = title_a.html();

        let list_cate_id = li
            .select(&Selector::parse(".pic_box").to_anyhow()?)
            .next()
            .and_then(|pic_box| {
                pic_box.attr("class").and_then(|classes| {
                    classes
                        .split_whitespace()
                        .find_map(|class_name| class_name.strip_prefix("cate-"))
                })
            })
            .and_then(|id_str| id_str.parse::<i64>().ok());

        let href = title_a
            .attr("href")
            .context(format!("沒有在標題的<a>中找到href屬性: {title_a_html}"))?;
        let id =
            comic_id_from_href(href).context(format!("無法從 href 解析漫畫 id: {title_a_html}"))?;

        let title_html = title_a
            .attr("title")
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| title_a.text().collect::<String>().trim().to_string());

        let title = filename_filter(&title_a.text().collect::<String>());
        let title = if title.is_empty() {
            filename_filter(&title_html)
        } else {
            title
        };

        let cover = li
            .select(&Selector::parse("img").to_anyhow()?)
            .next()
            .and_then(|img| img.attr("src"))
            .map(|cover_src| {
                if cover_src.starts_with("http") {
                    cover_src.to_string()
                } else {
                    format!("https:{cover_src}")
                }
            })
            .unwrap_or_default();

        let additional_info = li
            .select(&Selector::parse(".info_col").to_anyhow()?)
            .next()
            .and_then(|div| div.text().next())
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| "排行榜".to_string());

        let is_downloaded = app.get_config().read().download_dir.join(&title).exists();

        Ok(ComicInSearch {
            id,
            title_html,
            title,
            cover,
            additional_info,
            is_downloaded,
            list_cate_id,
        })
    }

    pub fn from_li(app: &AppHandle, li: &ElementRef) -> anyhow::Result<ComicInSearch> {
        let li_html = li.html();

        let title_a = li
            .select(&Selector::parse(".title > a").to_anyhow()?)
            .next()
            .context(format!("沒有在<li>中找到標題的<a>: {li_html}"))?;

        Self::from_title_anchor(app, li, &title_a)
    }

    pub fn list_cate_id(&self) -> Option<i64> {
        self.list_cate_id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn title_html(&self) -> &str {
        &self.title_html
    }
}
