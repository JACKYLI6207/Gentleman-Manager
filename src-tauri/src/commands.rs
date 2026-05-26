use std::{path::PathBuf, time::Duration};

use anyhow::Context;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;
use tauri_specta::Event;
use tokio::{task::JoinSet, time::sleep};

use crate::{
    config::Config,
    errors::{CommandError, CommandResult},
    events::DownloadShelfEvent,
    extensions::{AnyhowErrorToStringChain, AppHandleExt},
    local_reader::{self, LocalReaderPages, LocalReaderSource},
    logger,
    types::{Comic, GetShelfResult, RankingPeriod, SearchResult, UserProfile},
    utils::filename_filter,
};

#[tauri::command]
#[specta::specta]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command(async)]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn get_config(app: AppHandle) -> Config {
    let config = app.get_config();
    let config = config.read().clone();
    tracing::debug!("取得設定成功");
    config
}

#[tauri::command(async)]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn save_config(app: AppHandle, config: Config) -> CommandResult<()> {
    let config_state = app.get_config();
    let wnacg_client = app.get_wnacg_client();

    let proxy_changed = {
        let config_state = config_state.read();
        config_state.proxy_mode != config.proxy_mode
            || config_state.proxy_host != config.proxy_host
            || config_state.proxy_port != config.proxy_port
    };

    let enable_file_logger = config.enable_file_logger;
    let file_logger_changed = config_state.read().enable_file_logger != enable_file_logger;

    {
        // 包裹在大括號中，以便自動釋放寫鎖
        let mut config_state = config_state.write();
        *config_state = config;
        config_state
            .save(&app)
            .map_err(|err| CommandError::from("儲存設定失敗", err))?;
        tracing::debug!("儲存設定成功");
    }

    if proxy_changed {
        wnacg_client.reload_client();
    }

    if file_logger_changed {
        if enable_file_logger {
            logger::reload_file_logger()
                .map_err(|err| CommandError::from("重新加載檔案日誌失敗", err))?;
        } else {
            logger::disable_file_logger()
                .map_err(|err| CommandError::from("禁用檔案日誌失敗", err))?;
        }
    }

    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub async fn login(app: AppHandle, username: String, password: String) -> CommandResult<String> {
    let wnacg_client = app.get_wnacg_client();

    let cookie = wnacg_client
        .login(&username, &password)
        .await
        .map_err(|err| CommandError::from("登入失敗", err))?;
    tracing::debug!("登入成功");
    Ok(cookie)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn get_user_profile(app: AppHandle) -> CommandResult<UserProfile> {
    let wnacg_client = app.get_wnacg_client();

    let user_profile = wnacg_client
        .get_user_profile()
        .await
        .map_err(|err| CommandError::from("獲取使用者資訊失敗", err))?;
    tracing::debug!("獲取使用者資訊成功");
    Ok(user_profile)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn search_by_keyword(
    app: AppHandle,
    keyword: String,
    page_num: i64,
    cate_id: Option<i64>,
    scan_mode: Option<String>,
) -> CommandResult<SearchResult> {
    let wnacg_client = app.get_wnacg_client();

    let search_result = wnacg_client
        .search_by_keyword(&keyword, page_num, cate_id, scan_mode.as_deref())
        .await
        .map_err(|err| CommandError::from("關鍵詞搜尋失敗", err))?;
    tracing::debug!("關鍵詞搜尋成功");
    Ok(search_result)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn search_by_tag(
    app: AppHandle,
    tag_name: String,
    page_num: i64,
    cate_id: Option<i64>,
    scan_mode: Option<String>,
) -> CommandResult<SearchResult> {
    let wnacg_client = app.get_wnacg_client();

    let search_result = wnacg_client
        .search_by_tag(&tag_name, page_num, cate_id, scan_mode.as_deref())
        .await
        .map_err(|err| CommandError::from("按標籤搜尋失敗", err))?;
    tracing::debug!("標籤搜尋成功");
    Ok(search_result)
}

#[tauri::command]
#[specta::specta]
pub fn cancel_scoped_search_scan(app: AppHandle) -> CommandResult<()> {
    app.get_wnacg_client().cancel_scoped_scan();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn advance_scoped_search_scan(app: AppHandle) -> CommandResult<()> {
    app.get_wnacg_client().advance_scoped_scan();
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub async fn browse_by_category(
    app: AppHandle,
    cate_id: i64,
    page_num: i64,
) -> CommandResult<SearchResult> {
    let wnacg_client = app.get_wnacg_client();

    let search_result = wnacg_client
        .browse_by_category(cate_id, page_num)
        .await
        .map_err(|err| CommandError::from("瀏覽分類失敗", err))?;
    tracing::debug!("瀏覽分類成功");
    Ok(search_result)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn browse_ranking(
    app: AppHandle,
    period: String,
    cate_id: Option<i64>,
    page_num: i64,
) -> CommandResult<SearchResult> {
    let period = RankingPeriod::parse_str(&period)
        .map_err(|err| CommandError::from("排行榜時間範圍無效", err))?;
    let wnacg_client = app.get_wnacg_client();

    let search_result = wnacg_client
        .browse_ranking(period, cate_id, page_num)
        .await
        .map_err(|err| CommandError::from("瀏覽排行榜失敗", err))?;
    tracing::debug!("瀏覽排行榜成功");
    Ok(search_result)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn browse_albums_list(app: AppHandle, page_num: i64) -> CommandResult<SearchResult> {
    let wnacg_client = app.get_wnacg_client();

    let search_result = wnacg_client
        .browse_albums_list(page_num)
        .await
        .map_err(|err| CommandError::from("瀏覽更新列表失敗", err))?;
    tracing::debug!("瀏覽更新列表成功");
    Ok(search_result)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn browse_home(app: AppHandle, page_num: i64) -> CommandResult<SearchResult> {
    let wnacg_client = app.get_wnacg_client();

    let search_result = wnacg_client
        .browse_home(page_num)
        .await
        .map_err(|err| CommandError::from("瀏覽首頁失敗", err))?;
    tracing::debug!("瀏覽首頁成功");
    Ok(search_result)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn get_comic(app: AppHandle, id: i64) -> CommandResult<Comic> {
    let wnacg_client = app.get_wnacg_client();

    let comic = wnacg_client
        .get_comic(id)
        .await
        .map_err(|err| CommandError::from("獲取漫畫失敗", err))?;
    tracing::debug!("獲取漫畫成功");
    Ok(comic)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn get_comic_tags(app: AppHandle, id: i64) -> CommandResult<Vec<crate::types::Tag>> {
    let wnacg_client = app.get_wnacg_client();

    let tags = wnacg_client
        .get_comic_tags(id)
        .await
        .map_err(|err| CommandError::from("獲取漫畫標籤失敗", err))?;
    tracing::debug!("獲取漫畫標籤成功");
    Ok(tags)
}

#[tauri::command(async)]
#[specta::specta]
pub async fn get_shelf(
    app: AppHandle,
    shelf_id: i64,
    page_num: i64,
) -> CommandResult<GetShelfResult> {
    let wnacg_client = app.get_wnacg_client();

    let get_shelf_result = wnacg_client
        .get_shelf(shelf_id, page_num)
        .await
        .map_err(|err| CommandError::from("獲取書架失敗", err))?;
    tracing::debug!("獲取書架成功");
    Ok(get_shelf_result)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn create_download_task(app: AppHandle, comic: Comic, series_parent_dir: Option<String>) {
    let download_manager = app.get_download_manager();

    download_manager.create_download_task(comic, series_parent_dir);
    tracing::debug!("下載任務創建成功");
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
#[specta::specta]
pub fn prepare_korean_series_folder(
    app: AppHandle,
    series_label: String,
    episode_start: i32,
    episode_end: i32,
) -> CommandResult<String> {
    let download_dir = app.get_config().read().download_dir.clone();
    let safe_label = filename_filter(&series_label);
    let safe_label = if safe_label.is_empty() {
        "韓漫系列".to_string()
    } else {
        safe_label
    };
    let core_name = format!("{safe_label}-{episode_start}~{episode_end}-完");

    let mut has_any_subdirectory = false;
    let mut max_misc = 0u32;

    if let Ok(entries) = std::fs::read_dir(&download_dir) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            has_any_subdirectory = true;
            let name = entry.file_name().to_string_lossy().to_string();
            if let Some(rest) = name.strip_prefix("未分類") {
                if let Some((num_str, _)) = rest.split_once('.') {
                    if let Ok(n) = num_str.trim().parse::<u32>() {
                        max_misc = max_misc.max(n);
                    }
                }
            }
        }
    }

    let folder_name = if has_any_subdirectory {
        format!("未分類{}. {core_name}", max_misc + 1)
    } else {
        core_name
    };

    let full_path = download_dir.join(&folder_name);
    std::fs::create_dir_all(&full_path).map_err(|err| {
        CommandError::from(
            &format!("創建韓漫系列目錄`{folder_name}`"),
            anyhow::Error::from(err),
        )
    })?;

    tracing::debug!(folder = %folder_name, "韓漫系列目錄已就緒");
    Ok(folder_name)
}

#[tauri::command]
#[specta::specta]
pub fn read_korean_txt_catalog(catalog_dir: String) -> CommandResult<Vec<String>> {
    if catalog_dir.trim().is_empty() {
        return Ok(Vec::new());
    }
    let lines = crate::korean_txt_catalog::read_catalog_lines_from_config_value(catalog_dir.trim())
        .map_err(|err| CommandError::from("讀取韓漫 TXT 列表失敗", err))?;
    tracing::debug!(count = lines.len(), "已讀取韓漫 TXT 列表");
    Ok(lines)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn pause_download_task(app: AppHandle, comic_id: i64) -> CommandResult<()> {
    let download_manager = app.get_download_manager();

    download_manager
        .pause_download_task(comic_id)
        .map_err(|err| CommandError::from(&format!("暫停漫畫ID為`{comic_id}`的下載任務"), err))?;
    tracing::debug!("暫停漫畫ID為`{comic_id}`的下載任務成功");
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn resume_download_task(app: AppHandle, comic_id: i64) -> CommandResult<()> {
    let download_manager = app.get_download_manager();

    download_manager
        .resume_download_task(comic_id)
        .map_err(|err| CommandError::from(&format!("恢復漫畫ID為`{comic_id}`的下載任務"), err))?;
    tracing::debug!("恢復漫畫ID為`{comic_id}`的下載任務成功");
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn cancel_download_task(app: AppHandle, comic_id: i64) -> CommandResult<()> {
    let download_manager = app.get_download_manager();

    download_manager
        .cancel_download_task(comic_id)
        .map_err(|err| CommandError::from(&format!("取消漫畫ID為`{comic_id}`的下載任務"), err))?;
    tracing::debug!("取消漫畫ID為`{comic_id}`的下載任務成功");
    Ok(())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn remove_download_task_record(app: AppHandle, comic_id: i64) -> CommandResult<()> {
    let download_manager = app.get_download_manager();

    download_manager
        .remove_download_task_record(comic_id)
        .map_err(|err| CommandError::from(&format!("清除漫畫ID為`{comic_id}`的下載紀錄"), err))?;
    tracing::debug!("清除漫畫ID為`{comic_id}`的下載紀錄成功");
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn get_download_task_snapshots(
    app: AppHandle,
) -> CommandResult<Vec<crate::download_task_store::PersistedDownloadTask>> {
    let download_manager = app.get_download_manager();
    Ok(download_manager.list_persisted_tasks())
}

#[tauri::command(async)]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)]
pub fn get_downloaded_comics(app: AppHandle) -> CommandResult<Vec<Comic>> {
    let config = app.get_config();

    let download_dir = config.read().download_dir.clone();
    // 遍歷下載目錄，獲取所有元資料檔案的路徑和修改時間
    let mut metadata_path_with_modify_time = std::fs::read_dir(&download_dir)
        .map_err(|err| {
            let err_title = format!(
                "獲取已下載的漫畫失敗，讀取下載目錄`{}`失敗",
                download_dir.display()
            );
            CommandError::from(&err_title, err)
        })?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            if entry.file_name().to_string_lossy().starts_with(".下載中-") {
                return None;
            }
            let metadata_path = entry.path().join("元數據.json");
            if !metadata_path.exists() {
                return None;
            }
            let modify_time = metadata_path.metadata().ok()?.modified().ok()?;
            Some((metadata_path, modify_time))
        })
        .collect::<Vec<_>>();
    // 按照檔案修改時間排序，最新的排在最前面
    metadata_path_with_modify_time.sort_by(|(_, a), (_, b)| b.cmp(a));
    // 從元資料檔案中讀取Comic
    let downloaded_comics = metadata_path_with_modify_time
        .iter()
        .filter_map(
            |(metadata_path, _)| match Comic::from_metadata(&app, metadata_path) {
                Ok(comic) => Some(comic),
                Err(err) => {
                    let err_title = format!("讀取元資料檔案`{}`失敗", metadata_path.display());
                    let string_chain = err.to_string_chain();
                    tracing::error!(err_title, message = string_chain);
                    None
                }
            },
        )
        .collect::<Vec<_>>();

    tracing::debug!("獲取已下載的漫畫成功");
    Ok(downloaded_comics)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn get_logs_dir_size(app: AppHandle) -> CommandResult<u64> {
    let logs_dir = logger::logs_dir(&app)
        .context("獲取日誌目錄失敗")
        .map_err(|err| CommandError::from("獲取日誌目錄大小失敗", err))?;
    let logs_dir_size = std::fs::read_dir(&logs_dir)
        .context(format!("讀取日誌目錄`{}`失敗", logs_dir.display()))
        .map_err(|err| CommandError::from("獲取日誌目錄大小失敗", err))?
        .filter_map(Result::ok)
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum::<u64>();
    tracing::debug!("獲取日誌目錄大小成功");
    Ok(logs_dir_size)
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn show_path_in_file_manager(app: AppHandle, path: &str) -> CommandResult<()> {
    app.opener()
        .reveal_item_in_dir(path)
        .context(format!("在檔案總管中開啟`{path}`失敗"))
        .map_err(|err| CommandError::from("在檔案總管中開啟失敗", err))?;
    tracing::debug!("在檔案總管中開啟成功");
    Ok(())
}

fn latest_leveldb_data_file(dir: PathBuf) -> anyhow::Result<PathBuf> {
    let mut candidates = Vec::new();
    for entry in
        std::fs::read_dir(&dir).with_context(|| format!("讀取資料目錄`{}`失敗", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let is_data_file = (file_name.ends_with(".ldb") || file_name.ends_with(".log"))
            && file_name.chars().next().is_some_and(|c| c.is_ascii_digit());
        if !is_data_file {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        candidates.push((modified, path));
    }

    candidates
        .into_iter()
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
        .ok_or_else(|| anyhow::anyhow!("找不到快照資料檔"))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub fn show_snapshot_data_file(app: AppHandle, snapshot_kind: &str) -> CommandResult<String> {
    let app_data_dir = app
        .path()
        .app_local_data_dir()
        .context("取得快照資料資料夾失敗")
        .map_err(|err| CommandError::from("取得快照資料資料夾失敗", err))?;
    let data_dir = match snapshot_kind {
        "global" => app_data_dir
            .join("EBWebView")
            .join("Default")
            .join("IndexedDB")
            .join("http_tauri.localhost_0.indexeddb.leveldb"),
        "scoped" => app_data_dir
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb"),
        _ => {
            return Err(CommandError::from(
                "開啟快照資料檔失敗",
                anyhow::anyhow!("未知的快照種類：{snapshot_kind}"),
            ));
        }
    };
    let data_file = latest_leveldb_data_file(data_dir)
        .map_err(|err| CommandError::from("尋找快照資料檔失敗", err))?;
    let path_string = data_file.display().to_string();
    app.opener()
        .reveal_item_in_dir(&data_file)
        .context(format!("定位快照資料檔`{path_string}`失敗"))
        .map_err(|err| CommandError::from("定位快照資料檔失敗", err))?;
    tracing::debug!(path = %path_string, "定位快照資料檔成功");
    Ok(path_string)
}

#[tauri::command(async)]
#[specta::specta]
pub fn write_snapshot_export_file(path: &str, content: &str) -> CommandResult<()> {
    std::fs::write(path, content)
        .context(format!("寫入快照存檔`{path}`失敗"))
        .map_err(|err| CommandError::from("寫入快照存檔失敗", err))?;
    tracing::debug!(path, "寫入快照存檔成功");
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn read_snapshot_export_file(path: &str) -> CommandResult<String> {
    let content = std::fs::read_to_string(path)
        .context(format!("讀取快照存檔`{path}`失敗"))
        .map_err(|err| CommandError::from("讀取快照存檔失敗", err))?;
    tracing::debug!(path, "讀取快照存檔成功");
    Ok(content)
}

fn exe_base_dir() -> anyhow::Result<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .ok_or_else(|| anyhow::anyhow!("找不到 EXE 所在目錄"))
}

fn safe_output_file_name(file_name: &str) -> anyhow::Result<String> {
    let name = PathBuf::from(file_name)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .ok_or_else(|| anyhow::anyhow!("輸出檔名無效"))?;
    if name.trim().is_empty() || name.contains("..") {
        return Err(anyhow::anyhow!("輸出檔名無效"));
    }
    Ok(name)
}

#[tauri::command(async)]
#[specta::specta]
pub fn write_snapshot_repair_file(file_name: &str, content: &str) -> CommandResult<String> {
    let file_name = safe_output_file_name(file_name)
        .map_err(|err| CommandError::from("建立 repair 檔名失敗", err))?;
    let repair_dir = exe_base_dir()
        .map_err(|err| CommandError::from("建立 repair 目錄失敗", err))?
        .join("repair");
    std::fs::create_dir_all(&repair_dir)
        .context(format!("建立 repair 目錄`{}`失敗", repair_dir.display()))
        .map_err(|err| CommandError::from("建立 repair 目錄失敗", err))?;
    let path = repair_dir.join(file_name);
    std::fs::write(&path, content)
        .context(format!("寫入 repair 檔案`{}`失敗", path.display()))
        .map_err(|err| CommandError::from("寫入 repair 檔案失敗", err))?;
    Ok(path.display().to_string())
}

#[tauri::command(async)]
#[specta::specta]
pub fn write_snapshot_root_file(file_name: &str, content: &str) -> CommandResult<String> {
    let file_name = safe_output_file_name(file_name)
        .map_err(|err| CommandError::from("建立根目錄檔名失敗", err))?;
    let path = exe_base_dir()
        .map_err(|err| CommandError::from("建立根目錄輸出路徑失敗", err))?
        .join(file_name);
    std::fs::write(&path, content)
        .context(format!("寫入根目錄檔案`{}`失敗", path.display()))
        .map_err(|err| CommandError::from("寫入根目錄檔案失敗", err))?;
    Ok(path.display().to_string())
}

fn is_snapshot_timestamp(value: &str) -> bool {
    if value.len() != 19 {
        return false;
    }
    value.chars().enumerate().all(|(index, ch)| match index {
        4 | 7 | 10 | 13 | 16 => ch == '_',
        _ => ch.is_ascii_digit(),
    })
}

fn website_snapshot_file_prefix(file_name: &str) -> &str {
    let stem = file_name
        .strip_suffix(".gm-snapshot.json")
        .unwrap_or(file_name);
    if stem.len() > 20 {
        let split_at = stem.len() - 20;
        let (prefix, timestamp_with_space) = stem.split_at(split_at);
        if let Some(timestamp) = timestamp_with_space.strip_prefix(' ') {
            if is_snapshot_timestamp(timestamp) {
                return prefix;
            }
        }
    }
    stem
}

fn unique_old_snapshot_path(old_dir: &std::path::Path, file_name: &str) -> PathBuf {
    let candidate = old_dir.join(file_name);
    if !candidate.exists() {
        return candidate;
    }
    let stem = file_name
        .strip_suffix(".gm-snapshot.json")
        .unwrap_or(file_name);
    for index in 1.. {
        let candidate = old_dir.join(format!("{stem} ({index}).gm-snapshot.json"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!("unique snapshot path loop should always return")
}

fn archive_existing_website_snapshots(snapshot_dir: &std::path::Path, file_name: &str) -> anyhow::Result<()> {
    let prefix = website_snapshot_file_prefix(file_name);
    let mut old_dir_created = false;
    let old_dir = snapshot_dir.join("old");
    for entry in std::fs::read_dir(snapshot_dir)
        .context(format!("讀取 Website Snapshot 目錄`{}`失敗", snapshot_dir.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let existing_name = entry.file_name().to_string_lossy().to_string();
        if !existing_name.ends_with(".gm-snapshot.json") {
            continue;
        }
        if website_snapshot_file_prefix(&existing_name) != prefix {
            continue;
        }
        if !old_dir_created {
            std::fs::create_dir_all(&old_dir)
                .context(format!("建立 Website Snapshot old 目錄`{}`失敗", old_dir.display()))?;
            old_dir_created = true;
        }
        let destination = unique_old_snapshot_path(&old_dir, &existing_name);
        std::fs::rename(entry.path(), &destination).or_else(|_| {
            std::fs::copy(entry.path(), &destination)?;
            std::fs::remove_file(entry.path())
        })?;
    }
    Ok(())
}

#[tauri::command(async)]
#[specta::specta]
pub fn write_snapshot_website_file(file_name: &str, content: &str) -> CommandResult<String> {
    let file_name = safe_output_file_name(file_name)
        .map_err(|err| CommandError::from("建立 Website Snapshot 檔名失敗", err))?;
    let snapshot_dir = exe_base_dir()
        .map_err(|err| CommandError::from("建立 Website Snapshot 目錄失敗", err))?
        .join("Website Snapshot");
    std::fs::create_dir_all(&snapshot_dir)
        .context(format!("建立 Website Snapshot 目錄`{}`失敗", snapshot_dir.display()))
        .map_err(|err| CommandError::from("建立 Website Snapshot 目錄失敗", err))?;
    archive_existing_website_snapshots(&snapshot_dir, &file_name)
        .map_err(|err| CommandError::from("移置 Website Snapshot 舊檔失敗", err))?;
    let path = snapshot_dir.join(file_name);
    std::fs::write(&path, content)
        .context(format!("寫入 Website Snapshot 檔案`{}`失敗", path.display()))
        .map_err(|err| CommandError::from("寫入 Website Snapshot 檔案失敗", err))?;
    Ok(path.display().to_string())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub async fn get_cover_data(app: AppHandle, cover_url: String) -> CommandResult<Vec<u8>> {
    let wnacg_client = app.get_wnacg_client();

    let cover_data = wnacg_client
        .get_cover_data(&cover_url)
        .await
        .map_err(|err| CommandError::from("獲取封面失敗", err))?;
    Ok(cover_data.to_vec())
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command(async)]
#[specta::specta]
pub async fn get_reader_image(
    app: AppHandle,
    comic_id: i64,
    img_url: String,
) -> CommandResult<Vec<u8>> {
    let url = if img_url.starts_with("//") {
        format!("https:{img_url}")
    } else if img_url.starts_with("http://") || img_url.starts_with("https://") {
        img_url
    } else {
        format!("https://{img_url}")
    };

    let wnacg_client = app.get_wnacg_client();
    let (image_data, _) = wnacg_client
        .get_img_data_and_format(&url)
        .await
        .map_err(|err| CommandError::from(&format!("獲取閱讀圖片失敗(漫畫ID={comic_id})"), err))?;
    Ok(image_data.to_vec())
}

#[tauri::command]
#[specta::specta]
pub fn list_local_reader_sources(folder_path: String) -> CommandResult<Vec<LocalReaderSource>> {
    local_reader::list_local_reader_sources(&folder_path)
        .map_err(|err| CommandError::from("列出本地漫畫來源失敗", err))
}

#[tauri::command]
#[specta::specta]
pub fn load_local_reader_pages(source_path: String) -> CommandResult<LocalReaderPages> {
    local_reader::load_local_reader_pages(&source_path)
        .map_err(|err| CommandError::from("載入本地漫畫頁面失敗", err))
}

#[tauri::command]
#[specta::specta]
pub fn get_local_reader_image(page_id: String) -> CommandResult<Vec<u8>> {
    local_reader::read_local_reader_image(&page_id)
        .map_err(|err| CommandError::from("讀取本地漫畫圖片失敗", err))
}

#[tauri::command]
#[specta::specta]
pub fn close_local_reader_zip_session() -> CommandResult<()> {
    local_reader::close_zip_reader_session();
    Ok(())
}

#[allow(clippy::cast_possible_wrap)]
#[tauri::command(async)]
#[specta::specta]
pub async fn download_shelf(app: AppHandle, shelf_id: i64) -> CommandResult<()> {
    let config = app.get_config();
    let wnacg_client = app.get_wnacg_client().inner().clone();
    let download_manager = app.get_download_manager();

    let mut shelf_comics = Vec::new();
    let _ = DownloadShelfEvent::GettingShelfComics.emit(&app);

    // 獲取書架第一頁
    let first_page = wnacg_client
        .get_shelf(shelf_id, 1)
        .await
        .context("獲取書架的第`1`頁失敗")
        .map_err(|err| CommandError::from("下載書架失敗", err))?;
    // 先把書架的第一頁放進去
    shelf_comics.extend(first_page.comics);
    let page_count = first_page.total_page;
    // 獲取書架剩餘頁
    let mut join_set = JoinSet::new();
    for page in 2..=page_count {
        let pica_client = wnacg_client.clone();
        join_set.spawn(async move {
            let page = pica_client
                .get_shelf(shelf_id, page)
                .await
                .context(format!("獲取書架的第`{page}`頁失敗"))?;
            Ok::<_, anyhow::Error>(page)
        });
    }
    // 等待所有請求完成
    while let Some(Ok(get_shelf_result)) = join_set.join_next().await {
        // 如果有請求失敗，直接返回錯誤
        let page = get_shelf_result.map_err(|err| CommandError::from("下載書架失敗", err))?;
        shelf_comics.extend(page.comics);
    }
    // 至此，書架的漫畫已經全部獲取完畢
    // 去掉已下載的漫畫
    shelf_comics.retain(|comic| !comic.is_downloaded);
    let total = shelf_comics.len() as i64;

    let interval_ms = config.read().download_shelf_interval_ms;
    for (i, shelf_comic) in shelf_comics.into_iter().enumerate() {
        let comic_title = &shelf_comic.title;
        let comic_id = shelf_comic.id;

        let comic = match wnacg_client
            .get_comic(comic_id)
            .await
            .context(format!("獲取ID為`{comic_id}`的漫畫失敗"))
        {
            Ok(comic) => comic,
            Err(err) => {
                let err_title = format!("下載書架過程中，獲取漫畫`{comic_title}`失敗，已跳過");
                let err = err.context("可能是頻率太高，請手動去`設定`裡調整`下載書架時，每為一本漫畫創建下載任務後休息`");
                tracing::error!(err_title, message = err.to_string_chain());
                sleep(Duration::from_millis(interval_ms)).await;
                continue;
            }
        };

        let current = (i + 1) as i64;
        let _ = DownloadShelfEvent::CreatingDownloadTask { current, total }.emit(&app);

        download_manager.create_download_task(comic, None);
        sleep(Duration::from_millis(interval_ms)).await;
    }

    let _ = DownloadShelfEvent::End.emit(&app);

    Ok(())
}
