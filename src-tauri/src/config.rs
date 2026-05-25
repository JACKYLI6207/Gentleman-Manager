use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::types::DownloadFormat;

const DEFAULT_API_DOMAIN: &str = "www.wn07.ru";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub cookie: String,
    pub download_dir: PathBuf,
    pub enable_file_logger: bool,
    pub download_format: DownloadFormat,
    pub proxy_mode: ProxyMode,
    pub proxy_host: String,
    pub proxy_port: u16,
    pub comic_concurrency: usize,
    pub comic_download_interval_sec: u64,
    pub img_concurrency: usize,
    pub img_download_interval_sec: u64,
    pub download_shelf_interval_ms: u64,
    pub batch_download_interval_ms: u64,
    pub use_original_filename: bool,
    pub api_domain_mode: ApiDomainMode,
    pub custom_api_domain: String,
    /// 單次下載請求失敗後，最多再嘗試的次數（總嘗試次數 = 1 + 此值）
    pub download_retry_count: u32,
    /// 韓漫 TXT 收藏列表目錄（用於重複檢查）
    pub korean_txt_catalog_dir: PathBuf,
    /// 開啟韓漫下載模式時是否自動比對 TXT 目錄
    pub korean_txt_duplicate_check_enabled: bool,
}

impl Config {
    pub fn new(app: &AppHandle) -> anyhow::Result<Config> {
        let app_data_dir = crate::utils::app_data_dir()?;
        let _ = app; // app_data_dir 已改為固定路徑，不再需要 app
        let config_path = app_data_dir.join("config.json");

        let config = if config_path.exists() {
            let config_string = std::fs::read_to_string(config_path)?;
            match serde_json::from_str(&config_string) {
                // 如果能夠直接解析為Config，則直接返回
                Ok(config) => config,
                // 否則，將預設設定與檔案中已有的設定合併
                // 以免新版本添加了新的設定項，用戶升級到新版本後，所有設定項都被重置
                Err(_) => Config::merge_config(&config_string, &app_data_dir),
            }
        } else {
            Config::default(&app_data_dir)
        };
        config.save(app)?;
        Ok(config)
    }

    pub fn save(&self, app: &AppHandle) -> anyhow::Result<()> {
        let app_data_dir = crate::utils::app_data_dir()?;
        let _ = app;
        let config_path = app_data_dir.join("config.json");
        let config_string = serde_json::to_string_pretty(self)?;
        std::fs::write(config_path, config_string)?;
        Ok(())
    }

    pub fn get_api_domain(&self) -> String {
        if self.api_domain_mode == ApiDomainMode::Custom {
            self.custom_api_domain.clone()
        } else {
            DEFAULT_API_DOMAIN.to_string()
        }
    }

    fn merge_config(config_string: &str, app_data_dir: &Path) -> Config {
        let Ok(mut json_value) = serde_json::from_str::<serde_json::Value>(config_string) else {
            return Config::default(app_data_dir);
        };
        let serde_json::Value::Object(ref mut map) = json_value else {
            return Config::default(app_data_dir);
        };
        let Ok(default_config_value) = serde_json::to_value(Config::default(app_data_dir)) else {
            return Config::default(app_data_dir);
        };
        let serde_json::Value::Object(default_map) = default_config_value else {
            return Config::default(app_data_dir);
        };
        for (key, value) in default_map {
            map.entry(key).or_insert(value);
        }
        let Ok(config) = serde_json::from_value(json_value) else {
            return Config::default(app_data_dir);
        };
        config
    }

    fn default(app_data_dir: &Path) -> Config {
        // 首次使用時，預設下載目錄為 EXE 所在資料夾；取得失敗才退回 AppData。
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| app_data_dir.join("漫畫下載"));

        Config {
            cookie: String::new(),
            download_dir: exe_dir,
            enable_file_logger: true,
            download_format: DownloadFormat::Server2Zip,
            proxy_mode: ProxyMode::System,
            proxy_host: "127.0.0.1".to_string(),
            proxy_port: 7890,
            comic_concurrency: 1,
            comic_download_interval_sec: 0,
            img_concurrency: 10,
            img_download_interval_sec: 1,
            download_shelf_interval_ms: 100,
            batch_download_interval_ms: 100,
            use_original_filename: false,
            api_domain_mode: ApiDomainMode::Default,
            custom_api_domain: DEFAULT_API_DOMAIN.to_string(),
            download_retry_count: 1,
            korean_txt_catalog_dir: PathBuf::new(),
            korean_txt_duplicate_check_enabled: true,
        }
    }
}

impl Config {
    /// 下載請求總嘗試次數（至少 1 次，至多 21 次）
    pub fn download_max_attempts(&self) -> u32 {
        self.download_retry_count.saturating_add(1).clamp(1, 21)
    }
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Type)]
pub enum ProxyMode {
    #[default]
    System,
    NoProxy,
    Custom,
}

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub enum ApiDomainMode {
    #[default]
    Default,
    Custom,
}
