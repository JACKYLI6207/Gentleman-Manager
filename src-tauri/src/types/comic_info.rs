use serde::{Deserialize, Serialize};
use specta::Type;
use yaserde::{YaDeserialize, YaSerialize};

use super::Comic;

/// <https://wiki.kavitareader.com/guides/metadata/comics/>
#[derive(
    Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type, YaSerialize, YaDeserialize,
)]
#[serde(rename_all = "camelCase")]
pub struct ComicInfo {
    #[yaserde(rename = "Manga")]
    pub manga: String,
    /// 漫畫名
    #[yaserde(rename = "Series")]
    pub series: String,
    /// 出版社
    #[yaserde(rename = "Publisher")]
    pub publisher: String,
    /// 漫畫類型
    #[yaserde(rename = "Genre")]
    pub genre: String,
    /// 漫畫標籤
    #[yaserde(rename = "Tags")]
    pub tags: String,
    /// 簡介
    #[yaserde(rename = "Summary")]
    pub summary: String,
    /// 普通章節序號
    #[yaserde(rename = "Number")]
    pub number: Option<String>,
    /// 卷序號
    #[yaserde(rename = "Volume")]
    pub volume: Option<String>,
    /// 如果值為Special，則該章節會被Kavita視為特刊
    #[yaserde(rename = "Format")]
    pub format: Option<String>,
    /// 該章節的有多少頁
    #[yaserde(rename = "PageCount")]
    pub page_count: i64,
    /// 章節總數
    /// - `0` => Ongoing  
    /// - `非零`且與`Number`或`Volume`一致 => Completed  
    /// - `其他非零值` => Ended
    #[yaserde(rename = "Count")]
    pub count: i64,
}

impl From<Comic> for ComicInfo {
    fn from(comic: Comic) -> Self {
        ComicInfo {
            manga: "Yes".to_string(),
            series: comic.title,
            publisher: "紳士漫畫".to_string(),
            genre: comic.category,
            tags: comic
                .tags
                .iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            summary: comic.intro,
            number: Some("1".to_string()),
            volume: None,
            format: Some("Special".to_string()),
            page_count: comic.image_count,
            count: 1,
        }
    }
}
