use std::path::PathBuf;

use anyhow::Context;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::{
    download_manager::DownloadTaskState,
    events::{DownloadTaskEvent, ZipDownloadServer},
    types::Comic,
};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PersistedDownloadTask {
    pub comic_id: i64,
    pub comic: Comic,
    pub state: DownloadTaskState,
    pub series_parent_dir: Option<String>,
    pub downloaded_img_count: u32,
    pub total_img_count: u32,
    pub download_path: Option<String>,
    pub zip_server: Option<ZipDownloadServer>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

impl From<&DownloadTaskEvent> for PersistedDownloadTask {
    fn from(event: &DownloadTaskEvent) -> Self {
        Self {
            comic_id: event.comic.id,
            comic: event.comic.clone(),
            state: event.state,
            series_parent_dir: event.series_parent_dir.clone(),
            downloaded_img_count: event.downloaded_img_count,
            total_img_count: event.total_img_count,
            download_path: event.download_path.clone(),
            zip_server: event.zip_server,
            downloaded_bytes: event.downloaded_bytes,
            total_bytes: event.total_bytes,
        }
    }
}

pub struct DownloadTaskStore;

impl DownloadTaskStore {
    pub fn store_path(app: &AppHandle) -> anyhow::Result<PathBuf> {
        let _ = app;
        Ok(crate::utils::app_data_dir()?.join("download_tasks.json"))
    }

    pub fn load(app: &AppHandle) -> Vec<PersistedDownloadTask> {
        let Ok(path) = Self::store_path(app) else {
            return Vec::new();
        };
        if !path.exists() {
            return Vec::new();
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            return Vec::new();
        };
        serde_json::from_str(&content).unwrap_or_default()
    }

    fn save(app: &AppHandle, records: &[PersistedDownloadTask]) -> anyhow::Result<()> {
        let path = Self::store_path(app)?;
        let json = serde_json::to_string_pretty(records)?;
        std::fs::write(path, json).context("寫入 download_tasks.json 失敗")?;
        Ok(())
    }

    pub fn upsert(app: &AppHandle, record: PersistedDownloadTask) {
        let mut records = Self::load(app);
        if let Some(existing) = records.iter_mut().find(|r| r.comic_id == record.comic_id) {
            *existing = record;
        } else {
            records.push(record);
        }
        if let Err(err) = Self::save(app, &records) {
            tracing::warn!(message = %err, "儲存下載任務紀錄失敗");
        }
    }

    pub fn upsert_event(app: &AppHandle, event: &DownloadTaskEvent) {
        Self::upsert(app, PersistedDownloadTask::from(event));
    }

    pub fn remove(app: &AppHandle, comic_id: i64) {
        let mut records = Self::load(app);
        let before = records.len();
        records.retain(|r| r.comic_id != comic_id);
        if records.len() == before {
            return;
        }
        if let Err(err) = Self::save(app, &records) {
            tracing::warn!(message = %err, "刪除下載任務紀錄失敗");
        }
    }
}
