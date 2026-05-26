use std::{
    cmp::Ordering,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use anyhow::{anyhow, Context};
use parking_lot::Mutex as ParkingMutex;
use specta::Type;

use crate::extensions::PathIsImg;

const PAGE_ID_SEP: char = '\x1E';

struct ZipSession {
    path: PathBuf,
    archive: zip::ZipArchive<File>,
}

static ZIP_SESSION: OnceLock<ParkingMutex<Option<ZipSession>>> = OnceLock::new();

fn zip_session() -> &'static ParkingMutex<Option<ZipSession>> {
    ZIP_SESSION.get_or_init(|| ParkingMutex::new(None))
}

/// 關閉已開啟的 ZIP 書庫（切換漫畫或結束閱讀時呼叫）。
pub fn close_zip_reader_session() {
    *zip_session().lock() = None;
}

fn open_zip_session(path: &Path) -> anyhow::Result<()> {
    let mut guard = zip_session().lock();
    if guard.as_ref().is_some_and(|session| session.path == path) {
        return Ok(());
    }
    let file = File::open(path).context("開啟 ZIP 檔案失敗")?;
    let archive = zip::ZipArchive::new(file).context("解析 ZIP 檔案失敗")?;
    *guard = Some(ZipSession {
        path: path.to_path_buf(),
        archive,
    });
    Ok(())
}

fn with_zip_archive<F, R>(path: &Path, f: F) -> anyhow::Result<R>
where
    F: FnOnce(&mut zip::ZipArchive<File>) -> anyhow::Result<R>,
{
    open_zip_session(path)?;
    let mut guard = zip_session().lock();
    let session = guard.as_mut().ok_or_else(|| anyhow!("ZIP 書庫未開啟"))?;
    if session.path != path {
        return Err(anyhow!("ZIP 書庫路徑不符"));
    }
    f(&mut session.archive)
}

fn read_zip_entry(path: &Path, entry: &str) -> anyhow::Result<Vec<u8>> {
    with_zip_archive(path, |archive| {
        let mut zip_entry = archive
            .by_name(entry)
            .context(format!("ZIP 內找不到 `{entry}`"))?;
        let mut data = Vec::new();
        zip_entry
            .read_to_end(&mut data)
            .context(format!("讀取 ZIP 項目 `{entry}` 失敗"))?;
        Ok(data)
    })
}

#[derive(Debug, Clone, Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReaderSource {
    pub path: String,
    pub label: String,
    pub kind: LocalReaderSourceKind,
}

#[derive(Debug, Clone, Copy, Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalReaderSourceKind {
    Zip,
    Folder,
}

#[derive(Debug, Clone, Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReaderPage {
    pub caption: String,
    pub page_id: String,
}

#[derive(Debug, Clone, Type, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalReaderPages {
    pub title: String,
    pub pages: Vec<LocalReaderPage>,
}

fn is_shoucang_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("shoucang.jpg")
}

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            let ext = ext.to_ascii_lowercase();
            ext == "zip" || ext == "cbz"
        })
}

fn compare_natural(a: &str, b: &str) -> Ordering {
    let mut a_chars = a.chars().peekable();
    let mut b_chars = b.chars().peekable();

    loop {
        match (a_chars.peek(), b_chars.peek()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(a_c), Some(b_c)) if a_c.is_ascii_digit() && b_c.is_ascii_digit() => {
                let a_num = read_number(&mut a_chars);
                let b_num = read_number(&mut b_chars);
                match a_num.cmp(&b_num) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
            (Some(_), Some(_)) => {
                let a_c = a_chars.next().unwrap();
                let b_c = b_chars.next().unwrap();
                match a_c.to_ascii_lowercase().cmp(&b_c.to_ascii_lowercase()) {
                    Ordering::Equal => {}
                    other => return other,
                }
            }
        }
    }
}

fn read_number<I: Iterator<Item = char>>(iter: &mut std::iter::Peekable<I>) -> u64 {
    let mut value = 0_u64;
    while let Some(c) = iter.peek() {
        if c.is_ascii_digit() {
            value = value
                .saturating_mul(10)
                .saturating_add(u64::from(c.to_digit(10).unwrap_or(0)));
            iter.next();
        } else {
            break;
        }
    }
    value
}

fn sort_paths_natural(paths: &mut [PathBuf]) {
    paths.sort_by(|a, b| {
        compare_natural(
            &a.file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default(),
            &b.file_name()
                .map(|name| name.to_string_lossy())
                .unwrap_or_default(),
        )
    });
}

fn encode_page_id(source: &Path, entry: &str) -> String {
    format!("{}{PAGE_ID_SEP}{}", source.display(), entry)
}

fn decode_page_id(page_id: &str) -> anyhow::Result<(PathBuf, String)> {
    let (source, entry) = page_id
        .split_once(PAGE_ID_SEP)
        .ok_or_else(|| anyhow!("無效的 pageId"))?;
    Ok((PathBuf::from(source), entry.to_string()))
}

fn dir_has_images(dir: &Path) -> bool {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return false;
    };
    read_dir.filter_map(Result::ok).any(|entry| {
        let path = entry.path();
        path.is_file() && path.is_img() && !is_shoucang_name(&file_name_lossy(&path))
    })
}

fn file_name_lossy(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn source_label(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.display().to_string())
}

pub fn list_local_reader_sources(folder_path: &str) -> anyhow::Result<Vec<LocalReaderSource>> {
    let folder = Path::new(folder_path);
    if !folder.is_dir() {
        return Err(anyhow!("路徑不是資料夾"));
    }

    let mut sources = Vec::new();

    if dir_has_images(folder) {
        sources.push(LocalReaderSource {
            path: folder.display().to_string(),
            label: format!("{}（根目錄）", source_label(folder)),
            kind: LocalReaderSourceKind::Folder,
        });
    }

    let mut entries: Vec<PathBuf> = std::fs::read_dir(folder)
        .context("讀取資料夾失敗")?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();
    sort_paths_natural(&mut entries);

    for path in entries {
        if path.is_dir() {
            if dir_has_images(&path) {
                sources.push(LocalReaderSource {
                    path: path.display().to_string(),
                    label: source_label(&path),
                    kind: LocalReaderSourceKind::Folder,
                });
            }
            continue;
        }
        if path.is_file() && is_zip_path(&path) {
            sources.push(LocalReaderSource {
                path: path.display().to_string(),
                label: source_label(&path),
                kind: LocalReaderSourceKind::Zip,
            });
        }
    }

    sources.sort_by(|a, b| compare_natural(&a.label, &b.label));
    Ok(sources)
}

fn list_folder_pages(source: &Path) -> anyhow::Result<Vec<(String, String)>> {
    let mut pages = Vec::new();
    for entry in std::fs::read_dir(source).context("讀取漫畫資料夾失敗")? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || !path.is_img() {
            continue;
        }
        let name = file_name_lossy(&path);
        if is_shoucang_name(&name) {
            continue;
        }
        pages.push((name.clone(), encode_page_id(source, &name)));
    }
    pages.sort_by(|a, b| compare_natural(&a.0, &b.0));
    Ok(pages)
}

fn normalize_zip_entry_name(name: &str) -> String {
    name.replace('\\', "/")
}

fn list_zip_pages(zip_path: &Path) -> anyhow::Result<Vec<(String, String)>> {
    close_zip_reader_session();
    with_zip_archive(zip_path, |archive| {
        let mut pages = Vec::new();

        for index in 0..archive.len() {
            let entry = archive.by_index(index).context("讀取 ZIP 項目失敗")?;
            if entry.is_dir() {
                continue;
            }
            let name = normalize_zip_entry_name(entry.name());
            let file_name = name.rsplit('/').next().unwrap_or(&name);
            if !Path::new(file_name).is_img() || is_shoucang_name(file_name) {
                continue;
            }
            pages.push((name.clone(), encode_page_id(zip_path, &name)));
        }

        pages.sort_by(|a, b| compare_natural(&a.0, &b.0));
        Ok(pages)
    })
}

pub fn load_local_reader_pages(source_path: &str) -> anyhow::Result<LocalReaderPages> {
    let source = Path::new(source_path);
    if !source.exists() {
        return Err(anyhow!("路徑不存在"));
    }

    let pages = if source.is_file() {
        if !is_zip_path(source) {
            close_zip_reader_session();
            return Err(anyhow!("僅支援 ZIP/CBZ 檔案或圖片資料夾"));
        }
        list_zip_pages(source)?
    } else if source.is_dir() {
        close_zip_reader_session();
        list_folder_pages(source)?
    } else {
        close_zip_reader_session();
        return Err(anyhow!("無法讀取此路徑"));
    };

    if pages.is_empty() {
        return Err(anyhow!("找不到可閱讀的圖片"));
    }

    let title = source_label(source);
    Ok(LocalReaderPages {
        title,
        pages: pages
            .into_iter()
            .map(|(sort_key, page_id)| {
                let caption = sort_key.rsplit('/').next().unwrap_or(&sort_key).to_string();
                LocalReaderPage { caption, page_id }
            })
            .collect(),
    })
}

pub fn read_local_reader_image(page_id: &str) -> anyhow::Result<Vec<u8>> {
    let (source, entry) = decode_page_id(page_id)?;
    if !source.exists() {
        return Err(anyhow!("來源檔案不存在"));
    }

    if source.is_file() {
        return read_zip_entry(&source, &entry);
    }

    if source.is_dir() {
        let image_path = source.join(&entry);
        if !image_path.is_file() {
            return Err(anyhow!("圖片檔案不存在"));
        }
        return std::fs::read(&image_path).context("讀取本地圖片失敗");
    }

    Err(anyhow!("無效的圖片來源"))
}

#[cfg(test)]
mod tests {
    use super::compare_natural;
    use std::cmp::Ordering;

    #[test]
    fn natural_sort_orders_numeric_segments() {
        assert_eq!(compare_natural("2.jpg", "10.jpg"), Ordering::Less);
        assert_eq!(compare_natural("0010.jpg", "0002.jpg"), Ordering::Greater);
        assert_eq!(compare_natural("page-2.jpg", "page-10.jpg"), Ordering::Less);
    }
}
