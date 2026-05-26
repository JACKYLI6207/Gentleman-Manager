use std::{
    collections::HashMap,
    io::Cursor,
    ops::ControlFlow,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use bytes::Bytes;
use image::ImageFormat;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;
use tokio::{
    sync::{watch, Semaphore, SemaphorePermit},
    task::JoinSet,
    time::sleep,
};

use crate::{
    download_task_store::{DownloadTaskStore, PersistedDownloadTask},
    events::{DownloadSleepingEvent, DownloadSpeedEvent, DownloadTaskEvent, ZipDownloadServer},
    extensions::{AnyhowErrorToStringChain, AppHandleExt},
    korean_txt_catalog,
    types::Comic,
    utils::filename_filter,
    wnacg_client::WnacgClient,
    zip_download::{self, is_valid_zip_file, zip_part_path},
};

fn download_max_attempts(app: &AppHandle) -> u32 {
    app.get_config().read().download_max_attempts()
}

const DOWNLOAD_CANCELLED_ERR: &str = "download cancelled by user";

fn download_cancelled_err() -> anyhow::Error {
    anyhow!(DOWNLOAD_CANCELLED_ERR)
}

fn is_download_cancelled(err: &anyhow::Error) -> bool {
    err.to_string() == DOWNLOAD_CANCELLED_ERR
}

async fn retry_download_request<T, F, Fut>(
    max_attempts: u32,
    mut should_abort: impl FnMut() -> bool,
    mut operation: F,
) -> Result<T, anyhow::Error>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, anyhow::Error>>,
{
    let mut last_err = anyhow!("下載請求失敗");
    for attempt in 1..=max_attempts {
        if should_abort() {
            return Err(download_cancelled_err());
        }
        match operation().await {
            Ok(value) => return Ok(value),
            Err(err) => {
                last_err = err;
                if should_abort() {
                    return Err(download_cancelled_err());
                }
                if attempt < max_attempts {
                    sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }
    Err(last_err)
}

/// 用於管理下載任務
///
/// 克隆 `DownloadManager` 的開銷極小，性能開銷幾乎可以忽略不計。
/// 可以放心地在多個線程中傳遞和使用它的克隆副本。
///
/// 具體來說：
/// - `app` 是 `AppHandle` 類型，根據 `Tauri` 文檔，它的克隆開銷是極小的。
/// - 其他欄位都被 `Arc` 包裹，這些欄位的克隆操作僅僅是增加引用計數。
#[derive(Clone)]
pub struct DownloadManager {
    app: AppHandle,
    comic_sem: Arc<Semaphore>,
    img_sem: Arc<Semaphore>,
    byte_per_sec: Arc<AtomicU64>,
    download_tasks: Arc<RwLock<HashMap<i64, DownloadTask>>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum DownloadTaskState {
    Pending,
    Downloading,
    Paused,
    Cancelled,
    Completed,
    Failed,
}

impl DownloadManager {
    pub fn new(app: &AppHandle) -> Self {
        let (comic_concurrency, img_concurrency) = {
            let config = app.get_config();
            let config = config.read();
            // 同一時間僅允許一本漫畫佔用下載槽（休息秒數在釋放槽位前執行）
            let _ = config.comic_concurrency;
            (1_usize, config.img_concurrency)
        };

        let manager = DownloadManager {
            app: app.clone(),
            comic_sem: Arc::new(Semaphore::new(comic_concurrency)),
            img_sem: Arc::new(Semaphore::new(img_concurrency)),
            byte_per_sec: Arc::new(AtomicU64::new(0)),
            download_tasks: Arc::new(RwLock::new(HashMap::new())),
        };

        tauri::async_runtime::spawn(manager.clone().emit_download_speed_loop());

        manager.initialize_on_startup();

        manager
    }

    pub fn list_persisted_tasks(&self) -> Vec<PersistedDownloadTask> {
        DownloadTaskStore::load(&self.app)
    }

    fn initialize_on_startup(&self) {
        let manager = self.clone();
        tauri::async_runtime::spawn(async move {
            manager.cleanup_incomplete_zip_downloads_on_startup();
            manager.cleanup_cancelled_temp_directories();
            manager.restore_persisted_tasks();
            manager.scan_incomplete_temp_directories();
        });
    }

    fn cleanup_incomplete_zip_downloads_on_startup(&self) {
        let download_dir = self.app.get_config().read().download_dir.clone();
        zip_download::cleanup_orphaned_zip_part_files(&download_dir);

        if !self
            .app
            .get_config()
            .read()
            .download_format
            .is_server2_zip()
        {
            return;
        }

        use DownloadTaskState::Completed;
        for record in DownloadTaskStore::load(&self.app) {
            if record.state == Completed {
                continue;
            }
            let Some(path_str) = record.download_path.as_ref() else {
                continue;
            };
            let path = PathBuf::from(path_str);
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("zip"))
                && path.is_file()
                && !is_valid_zip_file(&path)
            {
                tracing::info!(path = %path.display(), "刪除不完整 zip");
                zip_download::remove_file_if_exists(&path);
            }
        }
    }

    fn restore_persisted_tasks(&self) {
        let records = DownloadTaskStore::load(&self.app);
        for record in records {
            use DownloadTaskState::{Cancelled, Completed, Downloading, Failed, Paused, Pending};
            match record.state {
                Completed | Cancelled | Paused | Failed => {}
                Pending | Downloading => {
                    if self.download_tasks.read().contains_key(&record.comic_id) {
                        continue;
                    }
                    let comic = record.comic;
                    let series_parent_dir = record.series_parent_dir;
                    self.create_download_task(comic, series_parent_dir);
                }
            }
        }
    }

    fn cleanup_cancelled_temp_directories(&self) {
        let download_dir = self.app.get_config().read().download_dir.clone();
        for record in DownloadTaskStore::load(&self.app) {
            if record.state != DownloadTaskState::Cancelled {
                continue;
            }
            let root = match &record.series_parent_dir {
                Some(name) => download_dir.join(name),
                None => download_dir.clone(),
            };
            let temp = root.join(format!(".下載中-{}", record.comic.title));
            if temp.is_dir() {
                tracing::info!(
                    comic_id = record.comic_id,
                    path = %temp.display(),
                    "清理已取消任務的臨時下載目錄"
                );
                if let Err(err) = std::fs::remove_dir_all(&temp) {
                    tracing::warn!(path = %temp.display(), message = %err, "刪除臨時目錄失敗");
                }
            }
        }
    }

    fn scan_incomplete_temp_directories(&self) {
        let download_dir = self.app.get_config().read().download_dir.clone();
        let mut metadata_paths = Vec::new();
        Self::collect_temp_metadata_paths(&download_dir, None, &mut metadata_paths);

        for (metadata_path, series_parent_dir) in metadata_paths {
            let Ok(comic) = Comic::from_metadata(&self.app, &metadata_path) else {
                continue;
            };
            if self.download_tasks.read().contains_key(&comic.id) {
                continue;
            }
            let persisted = DownloadTaskStore::load(&self.app);
            let record = persisted.iter().find(|r| r.comic_id == comic.id);
            if let Some(record) = record {
                use DownloadTaskState::{Cancelled, Completed, Failed, Paused};
                if matches!(record.state, Completed | Cancelled | Paused | Failed) {
                    continue;
                }
            }
            tracing::info!(
                comic_id = comic.id,
                comic_title = %comic.title,
                "發現未完成下載暫存，將恢復下載"
            );
            self.create_download_task(comic, series_parent_dir);
        }
    }

    fn collect_temp_metadata_paths(
        dir: &Path,
        series_parent_dir: Option<String>,
        out: &mut Vec<(PathBuf, Option<String>)>,
    ) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if name.starts_with(".下載中-") {
                let metadata = path.join("元數據.json");
                if metadata.is_file() {
                    out.push((metadata, series_parent_dir.clone()));
                }
            } else if !name.starts_with('.') {
                Self::collect_temp_metadata_paths(&path, Some(name), out);
            }
        }
    }

    fn maybe_append_korean_series_to_catalog(&self, series_folder: &str) {
        let config_holder = self.app.get_config();
        let config = config_holder.read();
        if !config.korean_txt_duplicate_check_enabled {
            return;
        }
        let catalog_value = config.korean_txt_catalog_dir.to_string_lossy().to_string();
        if catalog_value.trim().is_empty() {
            return;
        }
        drop(config);

        let records = DownloadTaskStore::load(&self.app);
        let series_tasks: Vec<_> = records
            .iter()
            .filter(|r| r.series_parent_dir.as_deref() == Some(series_folder))
            .collect();
        if series_tasks.is_empty() {
            return;
        }
        if !series_tasks
            .iter()
            .all(|r| r.state == DownloadTaskState::Completed)
        {
            return;
        }
        match korean_txt_catalog::append_folder_line_to_catalog(&catalog_value, series_folder) {
            Ok(true) => tracing::info!(series_folder, "韓漫系列下載完成，已追加至 TXT 收藏列表"),
            Ok(false) => {}
            Err(err) => tracing::warn!(
                series_folder,
                message = %err,
                "追加韓漫 TXT 收藏列表失敗"
            ),
        }
    }

    pub fn create_download_task(&self, comic: Comic, series_parent_dir: Option<String>) {
        use DownloadTaskState::{Cancelled, Downloading, Paused, Pending};
        let comic_id = comic.id;
        let mut tasks = self.download_tasks.write();
        if let Some(task) = tasks.get(&comic_id) {
            let state = *task.state_sender.borrow();
            if matches!(state, Pending | Downloading | Paused) {
                // 已在佇列且系列目錄一致則保留；否則取消舊任務後重建（如韓漫批次換資料夾）
                if task.series_parent_dir == series_parent_dir {
                    return;
                }
                task.set_state(Cancelled);
                task.emit_download_task_event();
            }
            tasks.remove(&comic_id);
        }
        drop(tasks);
        let task = DownloadTask::new(self.app.clone(), comic, series_parent_dir);
        self.download_tasks.write().insert(comic_id, task);
        if let Some(task) = self.download_tasks.read().get(&comic_id).cloned() {
            task.emit_download_task_event();
            tauri::async_runtime::spawn(task.process());
        }
    }

    pub fn pause_download_task(&self, comic_id: i64) -> anyhow::Result<()> {
        let tasks = self.download_tasks.read();
        let Some(task) = tasks.get(&comic_id) else {
            let mut record = DownloadTaskStore::load(&self.app)
                .into_iter()
                .find(|record| record.comic_id == comic_id)
                .ok_or_else(|| anyhow!("未找到漫畫ID為`{comic_id}`的下載任務"))?;
            record.state = DownloadTaskState::Paused;
            DownloadTaskStore::upsert(&self.app, record);
            return Ok(());
        };
        task.set_state(DownloadTaskState::Paused);
        task.emit_download_task_event();
        Ok(())
    }

    pub fn resume_download_task(&self, comic_id: i64) -> anyhow::Result<()> {
        use DownloadTaskState::{Cancelled, Completed, Failed, Pending};
        let recreate = {
            let tasks = self.download_tasks.read();
            let Some(task) = tasks.get(&comic_id) else {
                let record = DownloadTaskStore::load(&self.app)
                    .into_iter()
                    .find(|record| record.comic_id == comic_id)
                    .ok_or_else(|| anyhow!("未找到漫畫ID為`{comic_id}`的下載任務"))?;
                drop(tasks);
                self.create_download_task(record.comic, record.series_parent_dir);
                return Ok(());
            };
            let task_state = *task.state_sender.borrow();

            if matches!(task_state, Failed | Cancelled | Completed) {
                Some((task.comic.as_ref().clone(), task.series_parent_dir.clone()))
            } else {
                task.set_state(Pending);
                task.emit_download_task_event();
                None
            }
        };
        if let Some((comic, series_parent_dir)) = recreate {
            self.create_download_task(comic, series_parent_dir);
        }
        Ok(())
    }

    pub fn cancel_download_task(&self, comic_id: i64) -> anyhow::Result<()> {
        let task = {
            let tasks = self.download_tasks.read();
            let Some(task) = tasks.get(&comic_id) else {
                return Err(anyhow!("未找到漫畫ID為`{comic_id}`的下載任務"));
            };
            task.clone()
        };
        task.set_state(DownloadTaskState::Cancelled);
        task.emit_download_task_event();
        Ok(())
    }

    pub fn remove_download_task_record(&self, comic_id: i64) -> anyhow::Result<()> {
        use DownloadTaskState::{Cancelled, Completed, Downloading, Failed, Paused, Pending};
        let mut tasks = self.download_tasks.write();
        if let Some(task) = tasks.get(&comic_id) {
            let state = *task.state_sender.borrow();
            if matches!(state, Pending | Downloading | Paused) {
                return Err(anyhow!("進行中的下載任務無法清除紀錄"));
            }
            if !matches!(state, Completed | Failed | Cancelled) {
                return Err(anyhow!("目前狀態無法清除紀錄"));
            }
            tasks.remove(&comic_id);
        }
        drop(tasks);
        DownloadTaskStore::remove(&self.app, comic_id);
        Ok(())
    }

    #[allow(clippy::cast_precision_loss)]
    async fn emit_download_speed_loop(self) {
        let mut interval = tokio::time::interval(Duration::from_secs(1));

        loop {
            interval.tick().await;
            let byte_per_sec = self.byte_per_sec.swap(0, Ordering::Relaxed);
            let mega_byte_per_sec = byte_per_sec as f64 / 1024.0 / 1024.0;
            let speed = format!("{mega_byte_per_sec:.2} MB/s");
            // 發送總進度條下載速度事件
            let _ = DownloadSpeedEvent { speed }.emit(&self.app);
        }
    }
}

enum AcquireComicPermitError {
    Cancelled,
    Paused,
    Semaphore(anyhow::Error),
}

#[derive(Clone)]
struct DownloadTask {
    app: AppHandle,
    download_manager: DownloadManager,
    comic: Arc<Comic>,
    state_sender: watch::Sender<DownloadTaskState>,
    downloaded_img_count: Arc<AtomicU32>,
    total_img_count: Arc<AtomicU32>,
    download_path: Arc<RwLock<Option<String>>>,
    zip_server: Arc<RwLock<Option<ZipDownloadServer>>>,
    downloaded_bytes: Arc<AtomicU64>,
    total_bytes: Arc<AtomicU64>,
    /// 韓漫系列子目錄名稱（位於下載目錄之下）
    series_parent_dir: Option<String>,
}

impl DownloadTask {
    pub fn new(app: AppHandle, comic: Comic, series_parent_dir: Option<String>) -> Self {
        let download_manager = app.get_download_manager().inner().clone();
        let (state_sender, _) = watch::channel(DownloadTaskState::Pending);
        Self {
            app,
            download_manager,
            comic: Arc::new(comic),
            state_sender,
            downloaded_img_count: Arc::new(AtomicU32::new(0)),
            total_img_count: Arc::new(AtomicU32::new(0)),
            download_path: Arc::new(RwLock::new(None)),
            zip_server: Arc::new(RwLock::new(None)),
            downloaded_bytes: Arc::new(AtomicU64::new(0)),
            total_bytes: Arc::new(AtomicU64::new(0)),
            series_parent_dir,
        }
    }

    fn effective_download_root(&self) -> PathBuf {
        let root = self.app.get_config().read().download_dir.clone();
        match &self.series_parent_dir {
            Some(name) => root.join(name),
            None => root,
        }
    }

    fn is_cancelled(&self) -> bool {
        *self.state_sender.borrow() == DownloadTaskState::Cancelled
    }

    /// 佇列佔位任務（`img_list` 為空）在實際下載 JPEG 系列時才向官網取得完整漫畫資料
    async fn resolve_comic_for_download(&self) -> anyhow::Result<Comic> {
        if !self.comic.img_list.is_empty() {
            return Ok(self.comic.as_ref().clone());
        }
        self.app
            .get_wnacg_client()
            .inner()
            .clone()
            .get_comic(self.comic.id)
            .await
    }

    async fn process(self) {
        let download_comic_task = self.download_comic();
        tokio::pin!(download_comic_task);

        let mut state_receiver = self.state_sender.subscribe();
        state_receiver.mark_changed();
        let mut permit = None;
        loop {
            let state_is_downloading = *state_receiver.borrow() == DownloadTaskState::Downloading;
            let state_is_pending = *state_receiver.borrow() == DownloadTaskState::Pending;
            tokio::select! {
                () = &mut download_comic_task, if state_is_downloading && permit.is_some() => break,
                control_flow = self.acquire_comic_permit(&mut permit), if state_is_pending => {
                    match control_flow {
                        ControlFlow::Continue(()) => continue,
                        ControlFlow::Break(()) => break,
                    }
                },
                _ = state_receiver.changed() => {
                    match self.handle_state_change(&mut permit, &mut state_receiver) {
                        ControlFlow::Continue(()) => continue,
                        ControlFlow::Break(()) => break,
                    }
                }
            }
        }
    }

    #[allow(clippy::cast_possible_truncation)]
    async fn download_comic(&self) {
        if self
            .app
            .get_config()
            .read()
            .download_format
            .is_server2_zip()
        {
            self.download_comic_as_zip().await;
            return;
        }

        let max_attempts = download_max_attempts(&self.app);
        for attempt in 1..=max_attempts {
            if *self.state_sender.borrow() == DownloadTaskState::Cancelled {
                return;
            }
            if self.download_comic_images_once().await {
                return;
            }
            if attempt < max_attempts {
                let comic_id = self.comic.id;
                let comic_title = &self.comic.title;
                tracing::warn!(
                    comic_id,
                    comic_title,
                    attempt,
                    max_attempts,
                    "漫畫下載不完整，將重試"
                );
            }
        }

        let comic_title = &self.comic.title;
        let downloaded_img_count = self.downloaded_img_count.load(Ordering::Relaxed);
        let total_img_count = self.total_img_count.load(Ordering::Relaxed);
        let err_title = format!("`{comic_title}`下載不完整");
        let err_msg = format!(
            "總共有`{total_img_count}`張圖片，但只下載了`{downloaded_img_count}`張（已重試 {max_attempts} 次）"
        );
        tracing::error!(err_title, message = err_msg);
        self.set_state(DownloadTaskState::Failed);
        self.emit_download_task_event();
    }

    /// 執行一次圖片下載流程；全部成功並完成目錄重命名時返回 `true`
    #[allow(clippy::cast_possible_truncation)]
    async fn download_comic_images_once(&self) -> bool {
        let comic = match self.resolve_comic_for_download().await {
            Ok(comic) => comic,
            Err(err) => {
                let comic_id = self.comic.id;
                let comic_title = &self.comic.title;
                let err_title = format!("`{comic_title}`取得漫畫下載資訊失敗");
                let string_chain = err.to_string_chain();
                tracing::error!(comic_id, err_title, message = string_chain);
                self.set_state(DownloadTaskState::Failed);
                self.emit_download_task_event();
                return true;
            }
        };

        let comic_id = comic.id;
        let comic_title = &comic.title;
        // 獲取此漫畫每張圖片的下載鏈接
        let img_urls = comic
            .img_list
            .iter()
            .map(|img| &img.url)
            .filter(|url| !url.ends_with("shoucang.jpg")) // 過濾掉最後一張圖片
            .map(|url| format!("https:{url}"))
            .collect::<Vec<_>>();
        // 總共需要下載的圖片數量
        self.total_img_count
            .store(img_urls.len() as u32, Ordering::Relaxed);

        // 創建臨時下載目錄
        let Some(temp_download_dir) = self.create_temp_download_dir() else {
            return true;
        };
        // 清理臨時下載目錄中與`config.download_format`對不上的文件
        self.clean_temp_download_dir(&temp_download_dir);

        let mut join_set = JoinSet::new();
        // 開始下載之前，先儲存元數據
        if let Err(err) = self.save_metadata_for(&comic, &temp_download_dir) {
            let err_title = format!("`{comic_title}`儲存元數據失敗");
            let string_chain = err.to_string_chain();
            tracing::error!(err_title, message = string_chain);
            return true;
        }
        // 逐一創建下載任務
        for (i, url) in img_urls.into_iter().enumerate() {
            let url = url.clone();
            let temp_download_dir = temp_download_dir.clone();
            let download_img_task = DownloadImgTask::new(self, url, temp_download_dir, i);
            // 創建下載任務
            join_set.spawn(download_img_task.process());
        }
        // 等待所有下載任務完成
        join_set.join_all().await;
        tracing::trace!(comic_id, comic_title, "所有圖片下載任務完成");
        let downloaded_img_count = self.downloaded_img_count.load(Ordering::Relaxed);
        let total_img_count = self.total_img_count.load(Ordering::Relaxed);
        if downloaded_img_count != total_img_count {
            return false;
        }

        let zip_path = match self.pack_temp_dir_to_zip(&temp_download_dir) {
            Ok(path) => path,
            Err(err) => {
                let err_title = format!("`{comic_title}`打包 ZIP 失敗");
                let string_chain = err.to_string_chain();
                tracing::error!(err_title, message = string_chain);

                self.set_state(DownloadTaskState::Failed);
                self.emit_download_task_event();

                return true;
            }
        };
        tracing::trace!(
            comic_id,
            comic_title,
            "打包 ZIP`{}`成功",
            zip_path.display()
        );
        *self.download_path.write() = Some(zip_path.to_string_lossy().to_string());
        tracing::info!(comic_id, comic_title, "漫畫 JPEG 打包 ZIP 下載成功");

        self.sleep_between_comics().await;
        self.set_state(DownloadTaskState::Completed);
        self.emit_download_task_event();
        true
    }

    async fn download_comic_as_zip(&self) {
        let comic_id = self.comic.id;
        let comic_title = &self.comic.title;
        if self.is_cancelled() {
            return;
        }
        self.total_img_count.store(0, Ordering::Relaxed);
        self.downloaded_img_count.store(0, Ordering::Relaxed);
        self.downloaded_bytes.store(0, Ordering::Relaxed);
        self.total_bytes.store(0, Ordering::Relaxed);
        *self.zip_server.write() = None;
        *self.download_path.write() = None;
        self.emit_download_task_event();

        let download_dir = self.effective_download_root();
        let api_domain = self.app.get_config().read().get_api_domain();
        let referer = format!("https://{api_domain}/download-index-aid-{comic_id}.html");

        let client = self.app.get_wnacg_client().inner().clone();
        let max_attempts = download_max_attempts(&self.app);
        let zip_info = match retry_download_request(
            max_attempts,
            || self.is_cancelled(),
            || {
                let client = client.clone();
                async move { client.get_zip_download_info(comic_id).await }
            },
        )
        .await
        {
            Ok(info) => info,
            Err(err) => {
                if self.is_cancelled() || is_download_cancelled(&err) {
                    return;
                }
                let err_title =
                    format!("`{comic_title}`獲取 zip 下載資訊失敗（已重試 {max_attempts} 次）");
                let string_chain = err.to_string_chain();
                tracing::error!(err_title, message = string_chain);
                self.set_state(DownloadTaskState::Failed);
                self.emit_download_task_event();
                return;
            }
        };

        if self.is_cancelled() {
            return;
        }

        let save_path = download_dir.join(&zip_info.file_name);
        let part_path = zip_part_path(&save_path);
        zip_download::remove_file_if_exists(&part_path);

        if save_path.is_file() {
            if is_valid_zip_file(&save_path) {
                tracing::trace!(
                    comic_id,
                    comic_title,
                    "zip 已存在於`{}`，跳過下載",
                    save_path.display()
                );
                self.downloaded_img_count.store(1, Ordering::Relaxed);
                self.total_img_count.store(1, Ordering::Relaxed);
                *self.download_path.write() = Some(save_path.to_string_lossy().to_string());
                self.emit_download_task_event();
                tracing::info!(comic_id, comic_title, "漫畫 zip 下載成功（已存在）");
                self.sleep_between_comics().await;
                self.set_state(DownloadTaskState::Completed);
                self.emit_download_task_event();
                return;
            }
            tracing::warn!(
                comic_id,
                comic_title,
                path = %save_path.display(),
                "發現不完整 zip，將重新下載"
            );
            zip_download::remove_file_if_exists(&save_path);
        }

        *self.download_path.write() = Some(save_path.to_string_lossy().to_string());
        self.emit_download_task_event();

        let download_url = {
            let mut last_err = anyhow!("獲取 zip 下載鏈接失敗");
            let mut url = None;
            for attempt in 1..=max_attempts {
                if self.is_cancelled() {
                    return;
                }
                match WnacgClient::get_zip_backup_url(&zip_info) {
                    Ok(parsed_url) => {
                        url = Some(parsed_url);
                        break;
                    }
                    Err(err) => {
                        last_err = err;
                        if attempt < max_attempts {
                            sleep(Duration::from_millis(500)).await;
                        }
                    }
                }
            }
            match url {
                Some(parsed_url) => parsed_url,
                None => {
                    if self.is_cancelled() {
                        return;
                    }
                    let err_title = format!(
                        "`{comic_title}`獲取 Server 2 zip 下載鏈接失敗（已重試 {max_attempts} 次）"
                    );
                    let string_chain = last_err.to_string_chain();
                    tracing::error!(err_title, message = string_chain);
                    self.set_state(DownloadTaskState::Failed);
                    self.emit_download_task_event();
                    return;
                }
            }
        };
        *self.zip_server.write() = Some(ZipDownloadServer::Server2);
        self.emit_download_task_event();

        tracing::info!(comic_id, comic_title, url = %download_url, "開始下載 zip (Server 2)");

        let mut part_guard = ZipPartGuard::new(part_path.clone());
        let mut download_ok = false;
        for attempt in 1..=max_attempts {
            if *self.state_sender.borrow() == DownloadTaskState::Cancelled {
                return;
            }

            self.downloaded_bytes.store(0, Ordering::Relaxed);
            self.total_bytes.store(0, Ordering::Relaxed);
            self.emit_download_task_event();

            zip_download::remove_file_if_exists(&part_path);

            let emit_progress = {
                let task = self.clone();
                move || task.emit_download_task_event()
            };

            match client
                .download_zip_to_path(
                    &download_url,
                    &part_path,
                    &self.download_manager.byte_per_sec,
                    &referer,
                    &self.downloaded_bytes,
                    &self.total_bytes,
                    emit_progress,
                )
                .await
            {
                Ok(()) => {
                    if !is_valid_zip_file(&part_path) {
                        zip_download::remove_file_if_exists(&part_path);
                        if attempt < max_attempts {
                            tracing::warn!(
                                comic_id,
                                comic_title,
                                attempt,
                                max_attempts,
                                "zip 暫存檔不完整，重試"
                            );
                            sleep(Duration::from_millis(500)).await;
                            continue;
                        }
                        let err_title = format!(
                            "`{comic_title}`Server 2 下載 zip 不完整（已重試 {max_attempts} 次）"
                        );
                        tracing::error!(err_title);
                        self.set_state(DownloadTaskState::Failed);
                        self.emit_download_task_event();
                        return;
                    }

                    if let Err(err) = std::fs::rename(&part_path, &save_path) {
                        zip_download::remove_file_if_exists(&part_path);
                        let err_title = format!("`{comic_title}`移動 zip 檔案失敗");
                        tracing::error!(err_title, message = %err);
                        self.set_state(DownloadTaskState::Failed);
                        self.emit_download_task_event();
                        return;
                    }
                    part_guard.mark_complete();
                    download_ok = true;
                    break;
                }
                Err(err) => {
                    zip_download::remove_file_if_exists(&part_path);
                    let string_chain = err.to_string_chain();
                    if attempt < max_attempts {
                        tracing::warn!(
                            comic_id,
                            comic_title,
                            attempt,
                            max_attempts,
                            message = string_chain,
                            "Server 2 下載失敗，重試"
                        );
                        sleep(Duration::from_millis(500)).await;
                    } else {
                        let err_title = format!(
                            "`{comic_title}`Server 2 下載 zip 失敗（已重試 {max_attempts} 次）"
                        );
                        tracing::error!(err_title, message = string_chain);
                        self.set_state(DownloadTaskState::Failed);
                        self.emit_download_task_event();
                        return;
                    }
                }
            }
        }

        if !download_ok {
            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_event();
            return;
        }

        self.downloaded_img_count.store(1, Ordering::Relaxed);
        self.total_img_count.store(1, Ordering::Relaxed);
        self.emit_download_task_event();
        tracing::info!(
            comic_id,
            comic_title,
            "zip 下載成功: {}",
            save_path.display()
        );

        self.sleep_between_comics().await;
        self.set_state(DownloadTaskState::Completed);
        self.emit_download_task_event();
    }

    fn temp_download_dir_path(&self) -> PathBuf {
        self.effective_download_root()
            .join(format!(".下載中-{}", self.comic.title))
    }

    fn remove_temp_download_dir(&self) {
        let temp_download_dir = self.temp_download_dir_path();
        if !temp_download_dir.exists() {
            return;
        }
        let comic_id = self.comic.id;
        let comic_title = &self.comic.title;
        if let Err(err) = std::fs::remove_dir_all(&temp_download_dir) {
            tracing::warn!(
                comic_id,
                comic_title,
                path = %temp_download_dir.display(),
                message = %err,
                "刪除已取消下載的臨時目錄失敗"
            );
        } else {
            tracing::debug!(
                comic_id,
                comic_title,
                path = %temp_download_dir.display(),
                "已刪除已取消下載的臨時目錄"
            );
        }
    }

    fn create_temp_download_dir(&self) -> Option<PathBuf> {
        let comic_id = self.comic.id;
        let comic_title = &self.comic.title;

        let temp_download_dir = self.temp_download_dir_path(); // 以 `.下載中-` 開頭，表示是臨時目錄

        if let Err(err) = std::fs::create_dir_all(&temp_download_dir).map_err(anyhow::Error::from) {
            // 如果創建目錄失敗，則發送下載漫畫結束事件，並返回
            let err_title = format!(
                "`{comic_title}`創建目錄`{}`失敗",
                temp_download_dir.display()
            );
            let string_chain = err.to_string_chain();
            tracing::error!(err_title, message = string_chain);

            self.set_state(DownloadTaskState::Failed);
            self.emit_download_task_event();

            return None;
        }

        tracing::trace!(
            comic_id,
            comic_title,
            "創建臨時下載目錄`{}`成功",
            temp_download_dir.display()
        );

        Some(temp_download_dir)
    }

    /// 刪除臨時下載目錄中與`config.download_format`對不上的文件
    fn clean_temp_download_dir(&self, temp_download_dir: &Path) {
        let comic_id = self.comic.id;
        let comic_title = &self.comic.title;

        let entries = match std::fs::read_dir(temp_download_dir).map_err(anyhow::Error::from) {
            Ok(entries) => entries,
            Err(err) => {
                let err_title = format!(
                    "`{comic_title}`讀取臨時下載目錄`{}`失敗",
                    temp_download_dir.display()
                );
                let string_chain = err.to_string_chain();
                tracing::error!(err_title, message = string_chain);
                return;
            }
        };

        let download_format = self.app.get_config().read().download_format;
        let extension = download_format.image_extension();
        for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
            // path有擴展名，且能轉換為utf8，並與`config.download_format`一致或是gif，則保留
            let should_keep = path
                .extension()
                .and_then(|ext| ext.to_str())
                .is_some_and(|ext| ext == "gif" || Some(ext) == extension);
            if should_keep {
                continue;
            }
            // 否則刪除文件
            if let Err(err) = std::fs::remove_file(&path).map_err(anyhow::Error::from) {
                let err_title =
                    format!("`{comic_title}`刪除臨時下載目錄的`{}`失敗", path.display());
                let string_chain = err.to_string_chain();
                tracing::error!(err_title, message = string_chain);
            }
        }

        tracing::trace!(
            comic_id,
            comic_title,
            "清理臨時下載目錄`{}`成功",
            temp_download_dir.display()
        );
    }

    async fn acquire_comic_permit<'a>(
        &'a self,
        permit: &mut Option<SemaphorePermit<'a>>,
    ) -> ControlFlow<()> {
        let comic_id = self.comic.id;
        let comic_title = &self.comic.title;

        tracing::debug!(comic_id, comic_title, "漫畫開始排隊");

        self.emit_download_task_event();

        *permit = match permit.take() {
            // 如果有permit，則直接用
            Some(permit) => Some(permit),
            // 如果沒有permit，則獲取permit（排隊期間可響應取消/暫停）
            None => match self.acquire_comic_semaphore_permit().await {
                Ok(permit) => Some(permit),
                Err(AcquireComicPermitError::Cancelled) => return ControlFlow::Break(()),
                Err(AcquireComicPermitError::Paused) => return ControlFlow::Continue(()),
                Err(AcquireComicPermitError::Semaphore(err)) => {
                    let err_title = format!("`{comic_title}`獲取下載漫畫的permit失敗");
                    let string_chain = err.to_string_chain();
                    tracing::error!(err_title, message = string_chain);

                    self.set_state(DownloadTaskState::Failed);
                    self.emit_download_task_event();

                    return ControlFlow::Break(());
                }
            },
        };
        // 如果當前任務狀態不是`Pending`，則不將任務狀態設置為`Downloading`
        if *self.state_sender.borrow() != DownloadTaskState::Pending {
            return ControlFlow::Continue(());
        }
        // 將任務狀態設置為`Downloading`
        if let Err(err) = self
            .state_sender
            .send(DownloadTaskState::Downloading)
            .map_err(anyhow::Error::from)
        {
            let err_title = format!("`{comic_title}`發送狀態`Downloading`失敗");
            let string_chain = err.to_string_chain();
            tracing::error!(err_title, message = string_chain);
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }

    async fn acquire_comic_semaphore_permit(
        &self,
    ) -> Result<SemaphorePermit<'_>, AcquireComicPermitError> {
        loop {
            let state = *self.state_sender.borrow();
            if state == DownloadTaskState::Cancelled {
                return Err(AcquireComicPermitError::Cancelled);
            }
            if state == DownloadTaskState::Paused {
                return Err(AcquireComicPermitError::Paused);
            }

            let mut state_receiver = self.state_sender.subscribe();
            tokio::select! {
                acquired = self.download_manager.comic_sem.acquire() => {
                    match acquired {
                        Ok(permit) => return Ok(permit),
                        Err(err) => return Err(AcquireComicPermitError::Semaphore(err.into())),
                    }
                }
                _ = state_receiver.changed() => {}
            }
        }
    }

    fn handle_state_change<'a>(
        &'a self,
        permit: &mut Option<SemaphorePermit<'a>>,
        state_receiver: &mut watch::Receiver<DownloadTaskState>,
    ) -> ControlFlow<()> {
        let comic_id = self.comic.id;
        let comic_title = &self.comic.title;

        self.emit_download_task_event();
        let state = *state_receiver.borrow();
        match state {
            DownloadTaskState::Paused => {
                tracing::debug!(comic_id, comic_title, "漫畫暫停中");
                if let Some(permit) = permit.take() {
                    drop(permit);
                }
                ControlFlow::Continue(())
            }
            DownloadTaskState::Cancelled => {
                tracing::debug!(comic_id, comic_title, "漫畫取消下載");
                if let Some(permit) = permit.take() {
                    drop(permit);
                }
                self.remove_temp_download_dir();
                ControlFlow::Break(())
            }
            _ => ControlFlow::Continue(()),
        }
    }

    async fn sleep_between_comics(&self) {
        let comic_id = self.comic.id;
        let mut remaining_sec = self.app.get_config().read().comic_download_interval_sec;
        while remaining_sec > 0 {
            // 發送章節休眠事件
            let _ = DownloadSleepingEvent {
                comic_id,
                remaining_sec,
            }
            .emit(&self.app);
            sleep(Duration::from_secs(1)).await;
            remaining_sec -= 1;
        }
    }

    fn set_state(&self, state: DownloadTaskState) {
        let comic_title = &self.comic.title;
        if let Err(err) = self.state_sender.send(state).map_err(anyhow::Error::from) {
            let err_title = format!("`{comic_title}`發送狀態`{state:?}`失敗");
            let string_chain = err.to_string_chain();
            tracing::error!(err_title, message = string_chain);
        }
    }

    fn emit_download_task_event(&self) {
        let event = DownloadTaskEvent {
            state: *self.state_sender.borrow(),
            comic: self.comic.as_ref().clone(),
            downloaded_img_count: self.downloaded_img_count.load(Ordering::Relaxed),
            total_img_count: self.total_img_count.load(Ordering::Relaxed),
            download_path: self.download_path.read().clone(),
            zip_server: *self.zip_server.read(),
            downloaded_bytes: self.downloaded_bytes.load(Ordering::Relaxed),
            total_bytes: self.total_bytes.load(Ordering::Relaxed),
            series_parent_dir: self.series_parent_dir.clone(),
        };
        let _ = event.emit(&self.app);
        DownloadTaskStore::upsert_event(&self.app, &event);
        if event.state == DownloadTaskState::Completed {
            if let Some(ref series_folder) = event.series_parent_dir {
                self.download_manager
                    .maybe_append_korean_series_to_catalog(series_folder);
            }
        }
    }

    #[allow(clippy::needless_pass_by_value)]
    pub fn save_metadata(&self, temp_download_dir: &Path) -> anyhow::Result<()> {
        self.save_metadata_for(self.comic.as_ref(), temp_download_dir)
    }

    fn save_metadata_for(&self, comic: &Comic, temp_download_dir: &Path) -> anyhow::Result<()> {
        let mut comic = comic.clone();
        // 將所有comic的is_downloaded欄位設置為None，這樣能使is_downloaded欄位在序列化時被忽略
        comic.is_downloaded = None;

        let comic_title = &comic.title;
        let comic_json = serde_json::to_string_pretty(&comic).context(format!(
            "`{comic_title}`的元數據儲存失敗，將Comic序列化為json失敗"
        ))?;

        let metadata_path = temp_download_dir.join("元數據.json");

        std::fs::write(&metadata_path, comic_json).context(format!(
            "`{comic_title}`的元數據儲存失敗，寫入檔案`{}`失敗",
            metadata_path.display()
        ))?;

        Ok(())
    }

    fn pack_temp_dir_to_zip(&self, temp_download_dir: &Path) -> anyhow::Result<PathBuf> {
        use std::fs::File;
        use zip::write::SimpleFileOptions;
        use zip::{CompressionMethod, ZipWriter};

        let Some(parent) = temp_download_dir.parent() else {
            return Err(anyhow!("無法獲取`{}`的父目錄", temp_download_dir.display()));
        };

        let safe_title = filename_filter(&self.comic.title);
        let zip_file_name = if safe_title.is_empty() {
            format!("comic-{}.zip", self.comic.id)
        } else {
            format!("{safe_title}.zip")
        };
        let zip_path = parent.join(&zip_file_name);

        if zip_path.exists() {
            std::fs::remove_file(&zip_path)
                .with_context(|| format!("刪除舊 ZIP`{}`失敗", zip_path.display()))?;
        }

        let file = File::create(&zip_path)
            .with_context(|| format!("創建 ZIP`{}`失敗", zip_path.display()))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        let mut entries: Vec<_> = std::fs::read_dir(temp_download_dir)
            .with_context(|| format!("讀取目錄`{}`失敗", temp_download_dir.display()))?
            .flatten()
            .filter(|entry| entry.path().is_file())
            .filter(|entry| entry.file_name() != "元數據.json")
            .collect();
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            zip.start_file(&name, options)
                .with_context(|| format!("ZIP 寫入檔頭`{name}`失敗"))?;
            let mut source =
                File::open(&path).with_context(|| format!("開啟`{}`失敗", path.display()))?;
            std::io::copy(&mut source, &mut zip)
                .with_context(|| format!("寫入 ZIP 條目`{name}`失敗"))?;
        }

        zip.finish()
            .context(format!("完成 ZIP`{}`失敗", zip_path.display()))?;

        std::fs::remove_dir_all(temp_download_dir)
            .with_context(|| format!("刪除臨時目錄`{}`失敗", temp_download_dir.display()))?;

        Ok(zip_path)
    }
}

#[derive(Clone)]
struct DownloadImgTask {
    app: AppHandle,
    download_manager: DownloadManager,
    download_task: DownloadTask,
    url: String,
    temp_download_dir: PathBuf,
    index: usize,
}

impl DownloadImgTask {
    pub fn new(
        download_task: &DownloadTask,
        url: String,
        temp_download_dir: PathBuf,
        index: usize,
    ) -> Self {
        Self {
            app: download_task.app.clone(),
            download_manager: download_task.download_manager.clone(),
            download_task: download_task.clone(),
            url,
            temp_download_dir,
            index,
        }
    }

    async fn process(self) {
        let download_img_task = self.download_img();
        tokio::pin!(download_img_task);

        let mut state_receiver = self.download_task.state_sender.subscribe();
        state_receiver.mark_changed();
        let mut permit = None;

        loop {
            let state_is_downloading = *state_receiver.borrow() == DownloadTaskState::Downloading;
            tokio::select! {
                () = &mut download_img_task, if state_is_downloading && permit.is_some() => break,
                control_flow = self.acquire_img_permit(&mut permit), if state_is_downloading && permit.is_none() => {
                    match control_flow {
                        ControlFlow::Continue(()) => continue,
                        ControlFlow::Break(()) => break,
                    }
                },
                _ = state_receiver.changed() => {
                    match self.handle_state_change(&mut permit, &mut state_receiver) {
                        ControlFlow::Continue(()) => continue,
                        ControlFlow::Break(()) => break,
                    }
                }
            }
        }
    }

    async fn download_img(&self) {
        let url = &self.url;
        let comic_id = self.download_task.comic.id;
        let comic_title = &self.download_task.comic.title;
        let temp_download_dir = &self.temp_download_dir;

        let (use_original_filename, download_format) = {
            let config = self.app.get_config();
            let config = config.read();
            (config.use_original_filename, config.download_format)
        };

        let index_filename = format!("{:04}", self.index + 1);
        let original_filename = self
            .url
            .rsplit('/')
            .next()
            .and_then(|s| s.split('.').next())
            .unwrap_or(&index_filename);
        let img_filename = if use_original_filename {
            original_filename
        } else {
            &index_filename
        };

        if let Some(ext) = download_format.image_extension() {
            let user_format_path = temp_download_dir.join(format!("{img_filename}.{ext}"));
            let gif_path = temp_download_dir.join(format!("{img_filename}.gif"));

            if user_format_path.exists() || gif_path.exists() {
                // 如果圖片已存在，則跳過下載
                tracing::trace!(comic_id, comic_title, url, "圖片已存在，跳過下載");
                self.download_task
                    .downloaded_img_count
                    .fetch_add(1, Ordering::Relaxed);
                self.download_task.emit_download_task_event();
                return;
            }
        }

        tracing::trace!(comic_id, comic_title, url, "開始下載圖片");

        let max_attempts = download_max_attempts(&self.app);
        let client = self.app.get_wnacg_client().inner().clone();
        let url_owned = url.clone();
        let download_task = self.download_task.clone();
        let (img_data, img_format) = match retry_download_request(
            max_attempts,
            || download_task.is_cancelled(),
            || {
                let client = client.clone();
                let url_owned = url_owned.clone();
                async move { client.get_img_data_and_format(&url_owned).await }
            },
        )
        .await
        {
            Ok(data_and_format) => data_and_format,
            Err(err) => {
                if download_task.is_cancelled() || is_download_cancelled(&err) {
                    return;
                }
                let err_title = format!("下載圖片`{url}`失敗（已重試 {max_attempts} 次）");
                let string_chain = err.to_string_chain();
                tracing::error!(err_title, message = string_chain);
                return;
            }
        };
        let img_data_len = img_data.len() as u64;

        tracing::trace!(comic_id, comic_title, url, "圖片成功下載到內存");

        // 獲取圖片格式的擴展名
        let src_img_ext = match img_format {
            ImageFormat::Jpeg => "jpg",
            ImageFormat::Png => "png",
            ImageFormat::WebP => "webp",
            ImageFormat::Gif => "gif",
            _ => {
                let err_title = format!("儲存圖片`{url}`失敗");
                let err_msg = format!("遇到了預料之外的圖片格式`{img_format:?}`，請反饋給開發者");
                tracing::error!(err_title, message = err_msg);
                return;
            }
        };

        let ext = match img_format {
            ImageFormat::Gif => "gif",
            _ => download_format.image_extension().unwrap_or(src_img_ext),
        };
        let save_path = temp_download_dir.join(format!("{img_filename}.{ext}"));

        let target_format = match img_format {
            ImageFormat::Gif => ImageFormat::Gif,
            _ => download_format.to_image_format().unwrap_or(img_format),
        };

        let save_path_owned = save_path.clone();
        if let Err(err) = retry_download_request(
            max_attempts,
            || download_task.is_cancelled(),
            || {
                let save_path_owned = save_path_owned.clone();
                let img_data = img_data.clone();
                async move {
                    save_img(
                        &save_path_owned,
                        target_format,
                        img_data.clone(),
                        img_format,
                    )
                    .await
                }
            },
        )
        .await
        {
            if download_task.is_cancelled() || is_download_cancelled(&err) {
                return;
            }
            let err_title = format!(
                "儲存圖片`{}`失敗（已重試 {max_attempts} 次）",
                save_path.display()
            );
            let string_chain = err.to_string_chain();
            tracing::error!(err_title, message = string_chain);
            return;
        }

        tracing::trace!(
            comic_id,
            url,
            comic_title,
            "圖片成功儲存到`{}`",
            save_path.display()
        );

        // 記錄下載字節數
        self.download_manager
            .byte_per_sec
            .fetch_add(img_data_len, Ordering::Relaxed);

        self.download_task
            .downloaded_img_count
            .fetch_add(1, Ordering::Relaxed);
        self.download_task.emit_download_task_event();

        let img_download_interval_sec = self.app.get_config().read().img_download_interval_sec;
        sleep(Duration::from_secs(img_download_interval_sec)).await;
    }

    async fn acquire_img_permit<'a>(
        &'a self,
        permit: &mut Option<SemaphorePermit<'a>>,
    ) -> ControlFlow<()> {
        let url = &self.url;
        let comic_id = self.download_task.comic.id;
        let comic_title = &self.download_task.comic.title;

        tracing::trace!(comic_id, comic_title, url, "圖片開始排隊");

        *permit = match permit.take() {
            // 如果有permit，則直接用
            Some(permit) => Some(permit),
            // 如果沒有permit，則獲取permit
            None => match self
                .download_manager
                .img_sem
                .acquire()
                .await
                .map_err(anyhow::Error::from)
            {
                Ok(permit) => Some(permit),
                Err(err) => {
                    let err_title = format!("`{comic_title}`獲取下載圖片的permit失敗");
                    let string_chain = err.to_string_chain();
                    tracing::error!(err_title, message = string_chain);
                    return ControlFlow::Break(());
                }
            },
        };
        ControlFlow::Continue(())
    }

    fn handle_state_change<'a>(
        &'a self,
        permit: &mut Option<SemaphorePermit<'a>>,
        state_receiver: &mut watch::Receiver<DownloadTaskState>,
    ) -> ControlFlow<()> {
        let url = &self.url;
        let comic_id = self.download_task.comic.id;
        let comic_title = &self.download_task.comic.title;

        let state = *state_receiver.borrow();
        match state {
            DownloadTaskState::Paused => {
                tracing::trace!(comic_id, comic_title, url, "圖片暫停下載");
                if let Some(permit) = permit.take() {
                    drop(permit);
                }
                ControlFlow::Continue(())
            }
            DownloadTaskState::Cancelled => {
                tracing::trace!(comic_id, comic_title, url, "圖片取消下載");
                ControlFlow::Break(())
            }
            _ => ControlFlow::Continue(()),
        }
    }
}

/// 下載 zip 時寫入 `.part` 暫存檔；若未完成（取消、中斷、失敗）則在 drop 時自動刪除。
struct ZipPartGuard {
    path: PathBuf,
    keep: bool,
}

impl ZipPartGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, keep: false }
    }

    fn mark_complete(&mut self) {
        self.keep = true;
    }
}

impl Drop for ZipPartGuard {
    fn drop(&mut self) {
        if self.keep {
            return;
        }
        if self.path.exists() {
            tracing::debug!(path = %self.path.display(), "刪除未完成的 zip 暫存檔");
            zip_download::remove_file_if_exists(&self.path);
        }
    }
}

async fn save_img(
    save_path: &Path,
    target_format: ImageFormat,
    src_img_data: Bytes,
    src_format: ImageFormat,
) -> anyhow::Result<()> {
    if target_format == src_format {
        // 如果target_format與src_format匹配，則直接儲存
        std::fs::write(save_path, &src_img_data)
            .context(format!("將圖片數據寫入`{}`失敗", save_path.display()))?;
        return Ok(());
    }

    let save_path = save_path.to_path_buf();
    // 圖像處理的閉包
    let process_img = move || -> anyhow::Result<()> {
        // 如果target_format與src_format不匹配，則需要轉換格式
        let img = image::load_from_memory(&src_img_data).context("加載圖片數據失敗")?;

        let mut converted_data = Vec::new();

        match target_format {
            ImageFormat::Jpeg => img
                .to_rgb8()
                .write_to(&mut Cursor::new(&mut converted_data), target_format)
                .context(format!("將`{src_format:?}`轉換為`{target_format:?}`失敗"))?,

            ImageFormat::Png | ImageFormat::WebP => img
                .to_rgba8()
                .write_to(&mut Cursor::new(&mut converted_data), target_format)
                .context(format!("將`{src_format:?}`轉換為`{target_format:?}`失敗"))?,

            _ => return Err(anyhow!("不支持的圖片格式: {target_format:?}")),
        }

        std::fs::write(&save_path, &converted_data)
            .context(format!("將圖片數據寫入`{}`失敗", save_path.display()))?;

        Ok(())
    };

    // 因為圖像處理是CPU密集型操作，所以使用rayon併發處理
    let (sender, receiver) = tokio::sync::oneshot::channel::<anyhow::Result<()>>();
    rayon::spawn(move || {
        let _ = sender.send(process_img());
    });
    // 在tokio任務中等待rayon任務的完成，避免阻塞worker threads
    receiver.await?
}
