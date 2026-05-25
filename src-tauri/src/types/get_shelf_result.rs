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
pub struct GetShelfResult {
    pub comics: Vec<ComicInShelf>,
    pub current_page: i64,
    pub total_page: i64,
    pub shelf: Shelf,
    pub shelves: Vec<Shelf>,
}

impl GetShelfResult {
    pub fn from_html(app: &AppHandle, html: &str) -> anyhow::Result<GetShelfResult> {
        let document = Html::parse_document(html);

        let mut comics = Vec::new();
        for comic_div in document.select(&Selector::parse(".asTB").to_anyhow()?) {
            if let Ok(comic) = ComicInShelf::from_div(app, &comic_div) {
                comics.push(comic);
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

        let total_page = match document
            .select(&Selector::parse(".f_left.paginator > a").to_anyhow()?)
            .next_back()
        {
            Some(a) => {
                let a_html = a.html();
                a.text()
                    .next()
                    .context(format!("沒有在最後一頁的<a>中找到文本: {a_html}"))?
                    .parse::<i64>()
                    .context(format!("最後一頁不是整數: {a_html}"))?
            }
            .max(current_page), // 如果是最後一頁，那麼當前頁碼就是最後一頁
            None => 1,
        };

        let shelf = Self::get_shelf(&document)?;

        let shelves = Self::get_shelves(&document)?;

        Ok(GetShelfResult {
            comics,
            current_page,
            total_page,
            shelf,
            shelves,
        })
    }

    fn get_shelf(document: &Html) -> anyhow::Result<Shelf> {
        let document_html = document.html();
        let a = document
            .select(&Selector::parse(".cur").to_anyhow()?)
            .next()
            .context(format!("沒有找到當前書架的<a>: {document_html}"))?;

        let a_html = a.html();
        let id = a
            .attr("href")
            .context(format!("沒有在當前書架的<a>中找到href屬性: {a_html}"))?
            .trim()
            .strip_prefix("/users-users_fav-c-")
            .and_then(|s| s.strip_suffix(".html"))
            .unwrap_or("0")
            .parse::<i64>()
            .context(format!("書架id不是整數: {a_html}"))?;

        let name = a
            .text()
            .next()
            .context(format!("沒有在當前書架的<a>中找到文本: {a_html}"))?
            .trim()
            .to_string();

        Ok(Shelf { id, name })
    }

    fn get_shelves(document: &Html) -> anyhow::Result<Vec<Shelf>> {
        let mut shelves = Vec::new();
        for a in document.select(&Selector::parse(".nav_list > a").to_anyhow()?) {
            let a_html = a.html();
            let id = a
                .attr("href")
                .context(format!("沒有在書架的<a>中找到href屬性: {a_html}"))?
                .trim()
                .strip_prefix("/users-users_fav-c-")
                .and_then(|s| s.strip_suffix(".html"))
                .unwrap_or("0")
                .parse::<i64>()
                .context(format!("書架id不是整數: {a_html}"))?;

            let name = a
                .text()
                .next()
                .context(format!("沒有在書架的<a>中找到文本: {a_html}"))?
                .trim()
                .to_string();

            shelves.push(Shelf { id, name });
        }

        Ok(shelves)
    }
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ComicInShelf {
    /// 漫畫id
    pub id: i64,
    /// 漫畫標題
    pub title: String,
    /// 漫畫封面鏈接
    pub cover: String,
    /// 加入書架的時間
    /// 2025-01-04 16:04:34
    pub favorite_time: String,
    /// 這個漫畫屬於的書架
    pub shelf: Shelf,
    /// 是否已下載
    pub is_downloaded: bool,
}

impl ComicInShelf {
    pub fn from_div(app: &AppHandle, div: &ElementRef) -> anyhow::Result<ComicInShelf> {
        let (id, title) = Self::get_id_and_title(div)?;

        let div_html = div.html();
        let cover_src = div
            .select(&Selector::parse(".asTBcell.thumb img").to_anyhow()?)
            .next()
            .context(format!("沒有在漫畫的<div>中找到<img>: {div_html}"))?
            .attr("src")
            .context(format!("沒有在封面的<img>中找到src屬性: {div_html}"))?;
        let cover = format!("https:{cover_src}");

        let favorite_time = div
            .select(&Selector::parse(".l_catg > span").to_anyhow()?)
            .next()
            .context(format!(
                "沒有在漫畫的<div>中找到收藏時間的<span>: {div_html}"
            ))?
            .text()
            .next()
            .context(format!("沒有在標題的<span>中找到文本: {div_html}"))?
            .strip_prefix("創建時間：")
            .context(format!("收藏時間不是以`創建時間：`開頭: {div_html}"))?
            .trim()
            .to_string();

        let shelf = Self::get_shelf(div)?;

        let is_downloaded = app.get_config().read().download_dir.join(&title).exists();

        Ok(ComicInShelf {
            id,
            title,
            cover,
            favorite_time,
            shelf,
            is_downloaded,
        })
    }

    fn get_id_and_title(div: &ElementRef) -> anyhow::Result<(i64, String)> {
        let div_html = div.html();
        let a = div
            .select(&Selector::parse(".l_title > a").to_anyhow()?)
            .next()
            .context(format!("沒有在漫畫的<div>中找到標題的<a>: {div_html}"))?;

        let a_html = a.html();
        let id = a
            .attr("href")
            .context(format!("沒有在標題的<a>中找到href屬性: {a_html}"))?
            .strip_prefix("/photos-index-aid-")
            .context(format!("href不是以`/photos-index-aid-`開頭: {a_html}"))?
            .strip_suffix(".html")
            .context(format!("href不是以`.html`結尾: {a_html}"))?
            .parse::<i64>()
            .context(format!("id不是整數: {a_html}"))?;

        let title = a
            .text()
            .next()
            .context(format!("沒有在標題的<a>中找到文本: {a_html}"))?
            .trim()
            .to_string();
        let title = filename_filter(&title);

        Ok((id, title))
    }

    fn get_shelf(div: &ElementRef) -> anyhow::Result<Shelf> {
        let div_html = div.html();
        let a = div
            .select(&Selector::parse(".l_catg > a").to_anyhow()?)
            .next()
            .context(format!("沒有在漫畫的<div>中找到書架的<a>: {div_html}"))?;

        let a_html = a.html();
        let id = a
            .attr("href")
            .context(format!("沒有在書架的<a>中找到href屬性: {a_html}"))?
            .strip_prefix("/users-users_fav-c-")
            .and_then(|s| s.strip_suffix(".html"))
            .unwrap_or("0")
            .parse::<i64>()
            .context(format!("書架id不是整數: {a_html}"))?;

        let name = a.text().next().unwrap_or_default().trim().to_string();

        Ok(Shelf { id, name })
    }
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    /// 書架id
    pub id: i64,
    /// 書架名稱
    pub name: String,
}
