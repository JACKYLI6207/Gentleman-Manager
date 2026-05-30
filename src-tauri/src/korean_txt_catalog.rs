use std::path::Path;

use anyhow::Context;

/// 多個路徑以 `|` 分隔（路徑本身不含此字元）。
pub const PATH_LIST_SEPARATOR: char = '|';

fn push_lines_from_content(content: &str, lines: &mut Vec<String>) {
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
            continue;
        }
        lines.push(trimmed.to_string());
    }
}

fn read_lines_from_txt_file(path: &Path) -> anyhow::Result<Vec<String>> {
    let content = std::fs::read_to_string(path)?;
    let mut lines = Vec::new();
    push_lines_from_content(&content, &mut lines);
    Ok(lines)
}

/// 遞迴讀取目錄內所有 `.txt` 的非空行。
pub fn read_catalog_lines(dir: &Path) -> anyhow::Result<Vec<String>> {
    let mut lines = Vec::new();
    if !dir.is_dir() {
        return Ok(lines);
    }

    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(err) => {
                tracing::warn!(
                    path = %current.display(),
                    message = %err,
                    "讀取韓漫 TXT 目錄項目失敗，已略過"
                );
                continue;
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
                continue;
            };
            if !ext.eq_ignore_ascii_case("txt") {
                continue;
            }
            match read_lines_from_txt_file(&path) {
                Ok(mut file_lines) => lines.append(&mut file_lines),
                Err(err) => {
                    tracing::warn!(
                        path = %path.display(),
                        message = %err,
                        "讀取 TXT 檔失敗，已略過"
                    );
                }
            }
        }
    }

    Ok(lines)
}

/// 單一路徑：`.txt` 檔讀該檔；資料夾則遞迴讀取其中所有 `.txt`。
pub fn read_catalog_lines_from_path(path: &Path) -> anyhow::Result<Vec<String>> {
    if path.is_file() {
        return read_lines_from_txt_file(path);
    }
    if path.is_dir() {
        return read_catalog_lines(path);
    }
    Ok(Vec::new())
}

/// 設定值：單一路徑，或多個以 `|` 分隔的路徑。
pub fn read_catalog_lines_from_config_value(value: &str) -> anyhow::Result<Vec<String>> {
    let mut lines = Vec::new();
    for part in value
        .split(PATH_LIST_SEPARATOR)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let path = Path::new(part);
        if !path.exists() {
            tracing::warn!(path = %path.display(), "韓漫 TXT 路徑不存在，已略過");
            continue;
        }
        let mut part_lines = read_catalog_lines_from_path(path)?;
        lines.append(&mut part_lines);
    }
    lines.sort();
    lines.dedup();
    Ok(lines)
}

/// 解析設定中的第一個 `.txt` 檔作為追加寫入目標。
fn resolve_append_target_file(config_value: &str) -> anyhow::Result<std::path::PathBuf> {
    for part in config_value
        .split(PATH_LIST_SEPARATOR)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let path = Path::new(part);
        if path.is_file()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("txt"))
        {
            return Ok(path.to_path_buf());
        }
    }
    Err(anyhow::anyhow!(
        "請在設定中指定至少一個 .txt 檔案作為韓漫收藏列表"
    ))
}

/// 追加新行前與既有內容之間保留一個空行。
fn write_blank_line_separator<W: std::io::Write>(writer: &mut W, existing: &str) -> std::io::Result<()> {
    if existing.is_empty() {
        return Ok(());
    }
    if existing.ends_with("\n\n") || existing.ends_with("\n\r\n") {
        return Ok(());
    }
    if existing.ends_with('\n') {
        writer.write_all(b"\n")?;
    } else {
        writer.write_all(b"\n\n")?;
    }
    Ok(())
}

/// 將韓漫系列資料夾名稱追加到 TXT 列表（若該行尚不存在）。
pub fn append_folder_line_to_catalog(
    config_value: &str,
    folder_line: &str,
) -> anyhow::Result<bool> {
    let trimmed = folder_line.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let target = resolve_append_target_file(config_value)?;
    let existing_lines = read_lines_from_txt_file(&target).unwrap_or_default();
    if existing_lines.iter().any(|line| line.trim() == trimmed) {
        return Ok(false);
    }
    let existing_raw = std::fs::read_to_string(&target).unwrap_or_default();
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&target)
        .with_context(|| format!("無法開啟 TXT 檔 `{}`", target.display()))?;
    write_blank_line_separator(&mut file, &existing_raw)?;
    writeln!(file, "{trimmed}")?;
    tracing::info!(path = %target.display(), line = trimmed, "已追加韓漫收藏列表");
    Ok(true)
}

/// 從 TXT 列表移除指定資料夾名稱行（精確比對 trim 後內容）。
pub fn remove_folder_line_from_catalog(
    config_value: &str,
    folder_line: &str,
) -> anyhow::Result<bool> {
    let trimmed = folder_line.trim();
    if trimmed.is_empty() {
        return Ok(false);
    }
    let target = resolve_append_target_file(config_value)?;
    let existing_raw = std::fs::read_to_string(&target).unwrap_or_default();
    if existing_raw.is_empty() {
        return Ok(false);
    }
    let mut removed = false;
    let mut kept_lines: Vec<&str> = Vec::new();
    for line in existing_raw.lines() {
        if line.trim() == trimmed {
            removed = true;
        } else {
            kept_lines.push(line);
        }
    }
    if !removed {
        return Ok(false);
    }
    while kept_lines.last().is_some_and(|line| line.trim().is_empty()) {
        kept_lines.pop();
    }
    let mut new_content = kept_lines.join("\n");
    if !new_content.is_empty() {
        new_content.push('\n');
    }
    std::fs::write(&target, new_content)
        .with_context(|| format!("無法寫入 TXT 檔 `{}`", target.display()))?;
    tracing::info!(path = %target.display(), line = trimmed, "已從韓漫收藏列表移除");
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn append_inserts_blank_line_before_new_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("list.txt");
        std::fs::write(&path, "5星06. 傀儡-1~345-完\n").unwrap();
        assert!(append_folder_line_to_catalog(&path.to_string_lossy(), "新作-1~10-完").unwrap());
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("5星06. 傀儡-1~345-完\n\n新作-1~10-完"));
    }

    #[test]
    fn read_catalog_lines_reads_txt_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut file = std::fs::File::create(dir.path().join("list.txt")).unwrap();
        writeln!(file, "5星06. 傀儡-1~345-完").unwrap();
        writeln!(file, "").unwrap();
        writeln!(file, "# comment").unwrap();
        writeln!(file, "其他作品-1~10-完").unwrap();

        let lines = read_catalog_lines(dir.path()).unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains('傀'));
    }

    #[test]
    fn read_single_txt_file() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("only.txt");
        std::fs::write(&file_path, "5星06. 傀儡-1~345-完\n").unwrap();

        let lines = read_catalog_lines_from_path(&file_path).unwrap();
        assert_eq!(lines.len(), 1);
        assert!(lines[0].contains("傀儡"));
    }

    #[test]
    fn read_multiple_paths_from_config_value() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.txt");
        let b = dir.path().join("b.txt");
        std::fs::write(&a, "作品A\n").unwrap();
        std::fs::write(&b, "作品B\n").unwrap();

        let value = format!("{}|{}", a.display(), b.display());
        let lines = read_catalog_lines_from_config_value(&value).unwrap();
        assert_eq!(lines.len(), 2);
    }
}
