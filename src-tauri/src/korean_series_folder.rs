use std::path::Path;

use anyhow::Context;

use crate::utils::filename_filter;

const STANDALONE_META_TOKENS: &[&str] = &[
    "韓漫",
    "漢化",
    "生肉",
    "日語",
    "English",
    "同人誌",
    "單行本",
    "雜誌&短篇",
    "3D&漫畫",
    "AI圖集",
];

const COMPLETION_PHRASES: &[&str] = &["未完結", "已完結", "連載中", "完結", "完结", "完"];

const MIN_COMPARABLE_LEN: usize = 2;

/// 去掉標題開頭的分類／語系標記（如「韓漫 / 漢化 」）及「韓漫 · 系列名」搜尋範圍前綴。
pub fn strip_series_label_meta(label: &str) -> String {
    let mut rest = label.trim().to_string();
    if rest.contains('·') {
        let parts: Vec<&str> = rest
            .split('·')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        if parts.len() > 1 {
            if let Some(last) = parts.last() {
                if extract_comparable_text(last).len() >= MIN_COMPARABLE_LEN {
                    rest = (*last).to_string();
                }
            }
        }
    }

    let mut changed = true;
    while changed {
        changed = false;
        for token in STANDALONE_META_TOKENS {
            for sep in [" / ", "/", " ", "／"] {
                let prefix = format!("{token}{sep}");
                if rest.starts_with(&prefix) {
                    rest = rest[prefix.len()..].trim().to_string();
                    changed = true;
                    break;
                }
            }
            if rest == *token {
                rest.clear();
                changed = true;
            }
            if rest.starts_with(&format!("{token} ")) || rest.starts_with(&format!("{token}/")) {
                rest = rest[token.len()..]
                    .trim_start_matches([' ', '/', '／'])
                    .trim()
                    .to_string();
                changed = true;
            }
        }
    }
    rest
}

pub fn build_core_folder_name(clean_label: &str, episode_start: i32, episode_end: i32) -> String {
    let safe_label = filename_filter(clean_label);
    let safe_label = if safe_label.is_empty() {
        "韓漫系列".to_string()
    } else {
        safe_label
    };
    format!("{safe_label}-{episode_start}~{episode_end}-完")
}

/// `{系列名}-{起}~{迄}-完`；下載目錄已有任一子資料夾時為 `未分類N. {核心名}`。
pub fn resolve_korean_series_folder_name(sibling_dir_names: &[String], core_name: &str) -> String {
    let mut has_any_subdirectory = false;
    let mut max_misc = 0u32;

    for name in sibling_dir_names {
        has_any_subdirectory = true;
        if let Some(rest) = name.strip_prefix("未分類") {
            if let Some((num_str, _)) = rest.split_once('.') {
                if let Ok(n) = num_str.trim().parse::<u32>() {
                    max_misc = max_misc.max(n);
                }
            }
        }
    }

    if has_any_subdirectory {
        format!("未分類{}. {core_name}", max_misc + 1)
    } else {
        core_name.to_string()
    }
}

fn extract_comparable_text(text: &str) -> String {
    let mut buf = String::new();
    for ch in text.chars() {
        if ('\u{4e00}'..='\u{9fff}').contains(&ch)
            || ('\u{3400}'..='\u{4dbf}').contains(&ch)
            || ch.is_ascii_alphabetic()
        {
            buf.push(ch);
        }
    }
    let mut result = buf.to_lowercase();
    for phrase in COMPLETION_PHRASES {
        result = result.replace(phrase, "");
    }
    result
}

fn strip_catalog_line_prefix(line: &str) -> String {
    let trimmed = line.trim();
    if let Some(rest) = trimmed.strip_prefix("未分類") {
        if let Some((_, after)) = rest.split_once('.') {
            return after.trim().to_string();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("分類") {
        if let Some((_, after)) = rest.split_once('.') {
            return after.trim().to_string();
        }
    }
    trimmed.to_string()
}

fn strip_episode_suffix(text: &str) -> String {
    let mut rest = text.trim().to_string();
    if let Some(idx) = rest.rfind('-') {
        let tail = &rest[idx + 1..];
        if tail.contains('~') || tail.contains('～') {
            if tail.ends_with("完") || tail.ends_with("完结") {
                rest = rest[..idx].trim().to_string();
            }
        }
    }
    rest
}

fn split_series_name_aliases(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let segments: Vec<String> = trimmed
        .split(['/', '／', '|', '｜'])
        .map(str::trim)
        .filter(|s| extract_comparable_text(s).len() >= MIN_COMPARABLE_LEN)
        .map(ToString::to_string)
        .collect();
    if segments.is_empty() {
        vec![trimmed.to_string()]
    } else {
        segments
    }
}

fn name_candidates_from_label(label: &str) -> Vec<String> {
    let stripped = strip_series_label_meta(label);
    let mut out = Vec::new();
    for alias in split_series_name_aliases(&stripped) {
        out.push(alias.clone());
        out.push(strip_episode_suffix(&alias));
    }
    out.retain(|s| extract_comparable_text(s).len() >= MIN_COMPARABLE_LEN);
    out.sort();
    out.dedup();
    out
}

fn name_candidates_from_folder(folder_name: &str) -> Vec<String> {
    let stripped = strip_catalog_line_prefix(folder_name);
    let mut out = Vec::new();
    for alias in split_series_name_aliases(&stripped) {
        out.push(alias.clone());
        out.push(strip_episode_suffix(&alias));
        out.push(strip_episode_suffix(&strip_catalog_line_prefix(&alias)));
    }
    out.retain(|s| extract_comparable_text(s).len() >= MIN_COMPARABLE_LEN);
    out.sort();
    out.dedup();
    out
}

fn comparable_forms(text: &str) -> Vec<String> {
    let base = extract_comparable_text(text);
    if base.len() < MIN_COMPARABLE_LEN {
        return Vec::new();
    }
    vec![base]
}

fn names_match(a: &str, b: &str) -> bool {
    let a_forms = comparable_forms(a);
    let b_forms = comparable_forms(b);
    if a_forms.is_empty() || b_forms.is_empty() {
        return false;
    }
    for af in &a_forms {
        for bf in &b_forms {
            if af == bf {
                return true;
            }
            if af.len() >= MIN_COMPARABLE_LEN && bf.contains(af.as_str()) {
                return true;
            }
            if bf.len() >= 3 && af.len() > bf.len() && af.contains(bf.as_str()) {
                return true;
            }
        }
    }
    false
}

fn folder_matches_series_label(folder_name: &str, series_label: &str) -> bool {
    let label_candidates = name_candidates_from_label(series_label);
    let folder_candidates = name_candidates_from_folder(folder_name);
    if label_candidates.is_empty() || folder_candidates.is_empty() {
        return false;
    }
    for lc in &label_candidates {
        for fc in &folder_candidates {
            if names_match(lc, fc) {
                return true;
            }
        }
    }
    false
}

/// 在下載目錄現有子資料夾中找出與系列名相似的資料夾名稱。
pub fn find_similar_folder_names(sibling_dir_names: &[String], series_label: &str) -> Vec<String> {
    let mut matches: Vec<String> = sibling_dir_names
        .iter()
        .filter(|name| !name.starts_with('.') && folder_matches_series_label(name, series_label))
        .cloned()
        .collect();
    matches.sort();
    matches.dedup();
    matches
}

/// 下載中途產生的暫存檔／目錄（取消後可一併清除，不算「已載好的話數」）。
fn is_series_incomplete_artifact(name: &str, is_dir: bool) -> bool {
    if is_dir {
        return name.starts_with(".下載中-") || name.starts_with('.');
    }
    name.ends_with(".part") || name == "元數據.json"
}

/// 是否為已下載完成的話數（完整 ZIP 或非臨時子目錄）。
fn is_series_completed_content(name: &str, is_dir: bool) -> bool {
    if is_series_incomplete_artifact(name, is_dir) {
        return false;
    }
    if is_dir {
        return true;
    }
    name.ends_with(".zip")
}

/// 資料夾內是否已有下載完成的話數（ZIP 或非臨時子目錄／檔案）。
pub fn series_folder_has_downloaded_content(dir: &Path) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if is_series_completed_content(&name, file_type.is_dir()) {
            return true;
        }
    }
    false
}

/// 若系列資料夾內無已下載內容則刪除（含 `.下載中-*` 臨時目錄）。
pub fn try_remove_empty_series_folder(
    download_dir: &Path,
    folder_name: &str,
) -> anyhow::Result<bool> {
    let path = download_dir.join(folder_name);
    if !path.exists() {
        return Ok(false);
    }
    if series_folder_has_downloaded_content(&path) {
        return Ok(false);
    }
    std::fs::remove_dir_all(&path)
        .with_context(|| format!("刪除韓漫系列目錄 `{folder_name}` 失敗"))?;
    tracing::info!(folder = folder_name, "已刪除空的韓漫系列目錄");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_meta_removes_korean_prefix() {
        assert_eq!(strip_series_label_meta("韓漫 / 漢化 傀儡"), "傀儡");
    }

    #[test]
    fn find_similar_matches_existing_folder() {
        let siblings = vec![
            "未分類1. 傀儡-1~100-完".to_string(),
            "其他作品-1~10-完".to_string(),
        ];
        let matches = find_similar_folder_names(&siblings, "韓漫 傀儡");
        assert_eq!(matches, vec!["未分類1. 傀儡-1~100-完"]);
    }

    #[test]
    fn zip_part_alone_is_not_downloaded_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("這裡不行啦 1-37話[完結].zip.part"),
            b"partial",
        )
        .unwrap();
        assert!(!series_folder_has_downloaded_content(dir.path()));
    }

    #[test]
    fn completed_zip_counts_as_downloaded_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("作品.zip"), b"pk").unwrap();
        assert!(series_folder_has_downloaded_content(dir.path()));
    }
}
