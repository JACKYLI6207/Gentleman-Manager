mod commands;
mod config;
mod download_manager;
mod download_task_store;
mod errors;
mod events;
mod extensions;
mod korean_series_folder;
mod korean_txt_catalog;
mod local_reader;
mod logger;
mod types;
mod utils;
mod wnacg_client;
mod zip_download;

use anyhow::Context;
use config::Config;
use download_manager::DownloadManager;
use events::{
    DownloadSleepingEvent, DownloadSpeedEvent, DownloadTaskEvent, LogEvent, SearchScanProgressEvent,
};
use parking_lot::RwLock;
use tauri::{Manager, Wry};
use wnacg_client::WnacgClient;

use crate::{commands::*, events::DownloadShelfEvent};

fn generate_context() -> tauri::Context<Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri_specta::Builder::<Wry>::new()
        .commands(tauri_specta::collect_commands![
            greet,
            get_config,
            save_config,
            login,
            get_user_profile,
            search_by_keyword,
            search_by_tag,
            cancel_scoped_search_scan,
            advance_scoped_search_scan,
            browse_by_category,
            browse_ranking,
            browse_albums_list,
            browse_home,
            get_comic,
            get_comic_tags,
            get_shelf,
            download_shelf,
            create_download_task,
            read_korean_txt_catalog,
            list_similar_korean_series_folders,
            prepare_korean_series_folder,
            pause_download_task,
            resume_download_task,
            cancel_download_task,
            remove_download_task_record,
            get_download_task_snapshots,
            get_downloaded_comics,
            get_logs_dir_size,
            show_path_in_file_manager,
            show_snapshot_data_file,
            write_snapshot_export_file,
            read_snapshot_export_file,
            write_snapshot_repair_file,
            write_snapshot_root_file,
            write_snapshot_website_file,
            get_cover_data,
            get_reader_image,
            list_local_reader_sources,
            load_local_reader_pages,
            get_local_reader_image,
            close_local_reader_zip_session,
        ])
        .events(tauri_specta::collect_events![
            LogEvent,
            DownloadTaskEvent,
            DownloadSpeedEvent,
            DownloadSleepingEvent,
            DownloadShelfEvent,
            SearchScanProgressEvent,
        ]);

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default()
                .bigint(specta_typescript::BigIntExportBehavior::Number)
                .formatter(specta_typescript::formatter::prettier)
                .header("// @ts-nocheck"), // 跳過檢查
            "../src/bindings.ts",
        )
        .expect("Failed to export typescript bindings");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            let app_data_dir = crate::utils::app_data_dir().context("獲取app_data_dir目錄失敗")?;

            std::fs::create_dir_all(&app_data_dir).context(format!(
                "創建app_data_dir目錄`{}`失敗",
                app_data_dir.display()
            ))?;

            let config = RwLock::new(Config::new(app.handle())?);
            app.manage(config);

            let wnacg_client = WnacgClient::new(app.handle().clone());
            app.manage(wnacg_client);

            let download_manager = DownloadManager::new(app.handle());
            app.manage(download_manager);

            logger::init(app.handle())?;

            Ok(())
        })
        .run(generate_context())
        .expect("error while running tauri application");
}
