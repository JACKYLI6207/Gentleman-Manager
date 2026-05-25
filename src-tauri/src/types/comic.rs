use std::path::Path;

use anyhow::Context;
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::{
    extensions::{AppHandleExt, ToAnyhow},
    utils::filename_filter,
};

use super::{ImgList, Tag};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
#[allow(clippy::struct_field_names)]
pub struct Comic {
    /// 漫畫id
    pub id: i64,
    /// 漫畫標題
    pub title: String,
    /// 封面鏈接
    pub cover: String,
    /// 分類
    pub category: String,
    /// 漫畫有多少張圖片
    pub image_count: i64,
    /// 標籤
    pub tags: Vec<Tag>,
    /// 簡介
    pub intro: String,
    /// 是否已下載
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_downloaded: Option<bool>,
    /// 圖片列表
    pub img_list: ImgList,
}

impl Comic {
    // TODO: 拆分成多個函數
    #[allow(clippy::too_many_lines)]
    pub fn from_html(app: &AppHandle, html: &str, img_list: ImgList) -> anyhow::Result<Comic> {
        let document = Html::parse_document(html);

        let document_html = document.html();

        let link = document
            .select(&Selector::parse("head > link").to_anyhow()?)
            .next()
            .context(format!("沒有找到漫畫id的<link>: {document_html}"))?;
        let link_html = link.html();

        let id = link
            .attr("href")
            .context(format!("漫畫id的<link>沒有href屬性: {link_html}"))?
            .strip_prefix("/feed-index-aid-")
            .context(format!(
                "漫畫id的<link>不是以`/feed-index-aid-`開頭: {link_html}"
            ))?
            .strip_suffix(".html")
            .context(format!("漫畫id的<link>不是以`.html`結尾: {link_html}"))?
            .parse::<i64>()
            .context(format!("漫畫id不是整數: {link_html}"))?;

        let h2 = document
            .select(&Selector::parse("#bodywrap > h2").to_anyhow()?)
            .next()
            .context(format!("沒有找到漫畫標題的<h2>: {document_html}"))?;
        let h2_html = h2.html();

        let title = h2
            .text()
            .next()
            .context(format!("漫畫標題的<h2>沒有文本: {h2_html}"))?;
        let title = filename_filter(title);

        let img = document
            .select(&Selector::parse(".asTBcell.uwthumb > img").to_anyhow()?)
            .next()
            .context(format!("沒有找到封面的<img>: {document_html}"))?;
        let img_html = img.html();

        let cover_src = img
            .attr("src")
            .context(format!("封面的<img>沒有src屬性: {img_html}"))?
            .trim_start_matches('/')
            .to_string();
        let cover = format!("https://{cover_src}");

        let label = document
            .select(&Selector::parse(".asTBcell.uwconn > label").to_anyhow()?)
            .next()
            .context(format!("沒有找到分類的<label>: {document_html}"))?;
        let label_html = label.html();

        let category = label
            .text()
            .next()
            .context(format!("分類的<label>沒有文本: {label_html}"))?
            .strip_prefix("分類：")
            .context(format!("分類<label>的文本不是以`分類：`開頭: {label_html}"))?
            .to_string();

        let label = document
            .select(&Selector::parse(".asTBcell.uwconn > label").to_anyhow()?)
            .nth(1)
            .context(format!("沒有找到圖片數量的<label>: {document_html}"))?;
        let label_html = label.html();

        let image_count = label
            .text()
            .next()
            .context(format!("圖片數量的<label>沒有文本: {label_html}"))?
            .strip_prefix("頁數：")
            .context(format!("圖片數量的文本不是以`頁數：`開頭: {label_html}"))?
            .strip_suffix("P")
            .context(format!("圖片數量的文本不是以`P`結尾: {label_html}"))?
            .parse::<i64>()
            .context(format!("圖片數量不是整數: {label_html}"))?;

        let tags = Self::parse_tags_from_document(app, &document)?;

        let intro = document
            .select(&Selector::parse(".asTBcell.uwconn > p").to_anyhow()?)
            .next()
            .context(format!("沒有找到簡介的<p>: {document_html}"))?
            .html();

        let is_downloaded = app.get_config().read().download_dir.join(&title).exists();
        let is_downloaded = Some(is_downloaded);

        Ok(Comic {
            id,
            title,
            cover,
            category,
            image_count,
            tags,
            intro,
            is_downloaded,
            img_list,
        })
    }

    pub fn parse_tags_from_html(app: &AppHandle, html: &str) -> anyhow::Result<Vec<Tag>> {
        let document = Html::parse_document(html);
        Self::parse_tags_from_document(app, &document)
    }

    pub fn parse_tags_from_document(app: &AppHandle, document: &Html) -> anyhow::Result<Vec<Tag>> {
        let api_domain = app.get_config().read().get_api_domain();
        let tag_selector = Selector::parse(".tagshow").to_anyhow()?;
        let mut tags = Vec::new();
        for a in document.select(&tag_selector) {
            let Some(text) = a.text().next() else {
                continue;
            };
            let name = text.trim().to_string();
            let a_html = a.html();
            let href = a
                .attr("href")
                .context(format!("標籤的<a>沒有href屬性: {a_html}"))?
                .to_string();
            let url = format!("https://{api_domain}{href}");
            tags.push(Tag { name, url });
        }
        Ok(tags)
    }

    pub fn from_metadata(app: &AppHandle, metadata_path: &Path) -> anyhow::Result<Comic> {
        let comic_json = std::fs::read_to_string(metadata_path).context(format!(
            "從元數據轉為Comic失敗，讀取元資料檔案`{}`失敗",
            metadata_path.display()
        ))?;
        let mut comic = serde_json::from_str::<Comic>(&comic_json).context(format!(
            "從元數據轉為Comic失敗，將`{}`反序列化為Comic失敗",
            metadata_path.display()
        ))?;
        // 這個comic中的is_downloaded欄位是None，需要重新計算

        let is_downloaded = app
            .get_config()
            .read()
            .download_dir
            .join(&comic.title)
            .exists();
        comic.is_downloaded = Some(is_downloaded);
        Ok(comic)
    }
}
