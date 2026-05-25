use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri_specta::Event;

use crate::{
    download_manager::DownloadTaskState,
    types::{Comic, LogLevel},
};

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub timestamp: String,
    pub level: LogLevel,
    pub fields: HashMap<String, serde_json::Value>,
    pub target: String,
    pub filename: String,
    #[serde(rename = "line_number")]
    pub line_number: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum ZipDownloadServer {
    Server1,
    Server2,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTaskEvent {
    pub state: DownloadTaskState,
    pub comic: Comic,
    pub downloaded_img_count: u32,
    pub total_img_count: u32,
    /// 下載完成後在檔案總管中開啟用的路徑（zip 為檔案路徑，逐張為資料夾路徑）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_path: Option<String>,
    /// zip 下載時使用的線路
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zip_server: Option<ZipDownloadServer>,
    /// zip 下載已寫入位元組數
    pub downloaded_bytes: u64,
    /// zip 下載總位元組數（未知時為 0）
    pub total_bytes: u64,
    /// 韓漫系列子目錄名稱（位於下載目錄之下）；有值時前端可合併為批次任務列
    #[serde(skip_serializing_if = "Option::is_none")]
    pub series_parent_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSpeedEvent {
    pub speed: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSleepingEvent {
    pub comic_id: i64,
    pub remaining_sec: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(rename_all = "camelCase")]
pub struct SearchScanProgressEvent {
    pub current: i64,
    pub total: i64,
    pub matched_count: i64,
    /// "category" | "tag" | "search"
    pub scan_kind: String,
    pub finished: bool,
    pub paused: bool,
    pub retry_in_secs: Option<i64>,
    pub cancelled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
#[serde(tag = "event", content = "data")]
pub enum DownloadShelfEvent {
    #[serde(rename_all = "camelCase")]
    GettingShelfComics,

    #[serde(rename_all = "camelCase")]
    CreatingDownloadTask { current: i64, total: i64 },

    #[serde(rename_all = "camelCase")]
    End,
}
