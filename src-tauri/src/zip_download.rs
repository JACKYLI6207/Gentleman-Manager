use std::path::{Path, PathBuf};

use anyhow::Context;
use scraper::{Html, Selector};

/// 下載中的 zip 暫存路徑（例如 `漫畫.zip.part`）。
pub fn zip_part_path(save_path: &Path) -> PathBuf {
    let mut name = save_path.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

/// 是否為可正常開啟的完整 zip 檔。
pub fn is_valid_zip_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    zip::ZipArchive::new(file).is_ok()
}

pub fn remove_file_if_exists(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Err(err) = std::fs::remove_file(path) {
        tracing::debug!(path = %path.display(), message = %err, "刪除檔案失敗");
    }
}

/// 遞迴刪除下載目錄內殘留的 `*.zip.part` 暫存檔（程式異常關閉時可能留下）。
pub fn cleanup_orphaned_zip_part_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            cleanup_orphaned_zip_part_files(&path);
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let is_part = path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.ends_with(".zip.part"));
        if is_part {
            tracing::info!(path = %path.display(), "刪除殘留的 zip 暫存檔");
            remove_file_if_exists(&path);
        }
    }
}

#[derive(Debug, Clone)]
pub struct ZipDownloadInfo {
    pub file_name: String,
    pub backup_url: Option<String>,
}

pub fn parse_zip_download_page(html: &str) -> anyhow::Result<ZipDownloadInfo> {
    let file_name =
        extract_config_string(html, "FILE_NAME").context("無法從下載頁解析 FILE_NAME")?;
    let backup_url = parse_backup_zip_url(html);

    Ok(ZipDownloadInfo {
        file_name,
        backup_url,
    })
}

fn extract_config_string(html: &str, key: &str) -> Option<String> {
    let marker = format!("{key}: \"");
    let start = html.find(&marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn parse_backup_zip_url(html: &str) -> Option<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("#download-area a[href*='.zip']").ok()?;
    let href = document.select(&selector).next()?.value().attr("href")?;
    Some(normalize_download_url(href))
}

pub fn normalize_download_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("//") {
        format!("https://{rest}")
    } else if url.starts_with("http://") || url.starts_with("https://") {
        url.to_string()
    } else {
        format!("https://{url}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn zip_part_path_appends_suffix() {
        let save = PathBuf::from(r"C:\dl\每日攻略計畫 30話[完結].zip");
        assert_eq!(
            zip_part_path(&save),
            PathBuf::from(r"C:\dl\每日攻略計畫 30話[完結].zip.part")
        );
    }

    #[test]
    fn parse_config_from_reference_snippet() {
        let html = r#"
        const CONFIG = {
            WORKER_API: "https://d1.wcdn.date/api/generate-link",
            FILE_KEY: "down/3611/bcac55289e0065911e8feaeedfb4b526.zip",
            FILE_NAME: "每日攻略計畫 30話[完結].zip"
        };
        <div id="download-area">
            <a class="ads" href="//dl1.wn01.download/down/3611/bcac55289e0065911e8feaeedfb4b526.zip?n=test">
        "#;
        let info = parse_zip_download_page(html).unwrap();
        assert_eq!(info.file_name, "每日攻略計畫 30話[完結].zip");
        assert!(info.backup_url.as_ref().unwrap().starts_with("https://"));
    }
}
