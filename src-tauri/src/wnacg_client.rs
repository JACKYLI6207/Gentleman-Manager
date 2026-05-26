use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context};
use bytes::Bytes;
use image::ImageFormat;
use parking_lot::RwLock;
use reqwest::{Client, StatusCode};
use reqwest_middleware::ClientWithMiddleware;
use reqwest_retry::{policies::ExponentialBackoff, Jitter, RetryTransientMiddleware};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;
use tauri_specta::Event;

use crate::{
    config::ProxyMode,
    events::SearchScanProgressEvent,
    extensions::{AnyhowErrorToStringChain, AppHandleExt},
    types::{
        build_favorite_ranking_url, Comic, ComicInSearch, GetShelfResult, ImgList, RankingPeriod,
        SearchResult, Tag, UserProfile,
    },
    zip_download::{normalize_download_url, parse_zip_download_page, ZipDownloadInfo},
};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResp {
    pub ret: bool,
    pub html: String,
}

#[derive(Clone)]
struct ScopedSearchCacheEntry {
    comics: Vec<ComicInSearch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopedScanMode {
    Conservative,
    Aggressive,
}

impl ScopedScanMode {
    fn from_value(value: Option<&str>) -> Self {
        match value {
            Some("aggressive") => Self::Aggressive,
            _ => Self::Conservative,
        }
    }
}

#[derive(Debug, Clone)]
struct ScopedPageFailure {
    page: i64,
    category: String,
}

#[derive(Debug, Clone)]
struct ScopedBatchOutcome {
    completed: bool,
    page_failures: Vec<ScopedPageFailure>,
}

#[derive(Clone)]
pub struct WnacgClient {
    app: AppHandle,
    api_client: Arc<RwLock<ClientWithMiddleware>>,
    img_client: Arc<RwLock<ClientWithMiddleware>>,
    cover_client: Client,
    scoped_search_cache: Arc<RwLock<Option<(String, ScopedSearchCacheEntry)>>>,
    scoped_scan_cancelled: Arc<AtomicBool>,
    scoped_scan_request_signal: Arc<AtomicU64>,
}

impl WnacgClient {
    pub fn new(app: AppHandle) -> Self {
        let api_client = create_api_client(&app);
        let api_client = Arc::new(RwLock::new(api_client));

        let img_client = create_img_client(&app);
        let img_client = Arc::new(RwLock::new(img_client));

        let cover_client = Client::new();
        Self {
            app,
            api_client,
            img_client,
            cover_client,
            scoped_search_cache: Arc::new(RwLock::new(None)),
            scoped_scan_cancelled: Arc::new(AtomicBool::new(false)),
            scoped_scan_request_signal: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn cancel_scoped_scan(&self) {
        self.scoped_scan_cancelled.store(true, Ordering::Relaxed);
    }

    pub fn advance_scoped_scan(&self) {
        self.scoped_scan_request_signal
            .fetch_add(1, Ordering::Relaxed);
    }

    fn begin_scoped_scan(&self) {
        self.scoped_scan_cancelled.store(false, Ordering::Relaxed);
        self.scoped_scan_request_signal.store(0, Ordering::Relaxed);
    }

    fn is_scoped_scan_cancelled(&self) -> bool {
        self.scoped_scan_cancelled.load(Ordering::Relaxed)
    }

    fn clear_scoped_search_cache(&self) {
        *self.scoped_search_cache.write() = None;
    }

    fn emit_search_scan_progress(
        &self,
        current: i64,
        total: i64,
        matched_count: i64,
        scan_kind: &str,
        finished: bool,
        paused: bool,
        retry_in_secs: Option<i64>,
        paused_reason: Option<&str>,
        cancelled: bool,
    ) {
        let _ = SearchScanProgressEvent {
            current,
            total,
            matched_count,
            scan_kind: scan_kind.to_string(),
            finished,
            paused,
            retry_in_secs,
            paused_reason: paused_reason.map(str::to_string),
            cancelled,
        }
        .emit(&self.app);
    }

    fn emit_scoped_scan_cancelled(
        &self,
        current: i64,
        total: i64,
        matched_count: i64,
        scan_kind: &str,
    ) {
        self.emit_search_scan_progress(
            current,
            total,
            matched_count,
            scan_kind,
            true,
            false,
            None,
            None,
            true,
        );
    }

    async fn wait_scoped_scan_retry(
        &self,
        current: i64,
        total: i64,
        matched_count: i64,
        scan_kind: &str,
    ) -> anyhow::Result<bool> {
        const RETRY_SECS: i64 = 20;
        for remain in (1..=RETRY_SECS).rev() {
            if self.is_scoped_scan_cancelled() {
                return Ok(false);
            }
            self.emit_search_scan_progress(
                current,
                total,
                matched_count,
                scan_kind,
                false,
                true,
                Some(remain),
                None,
                false,
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        Ok(true)
    }

    async fn wait_manual_scoped_scan_request(
        &self,
        current: i64,
        total: i64,
        matched_count: i64,
        scan_kind: &str,
        paused_reason: Option<&str>,
    ) -> anyhow::Result<bool> {
        let signal = self.scoped_scan_request_signal.load(Ordering::Relaxed);
        self.emit_search_scan_progress(
            current,
            total,
            matched_count,
            scan_kind,
            false,
            true,
            None,
            paused_reason,
            false,
        );
        loop {
            if self.is_scoped_scan_cancelled() {
                return Ok(false);
            }
            if self.scoped_scan_request_signal.load(Ordering::Relaxed) != signal {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub fn reload_client(&self) {
        let api_client = create_api_client(&self.app);
        *self.api_client.write() = api_client;
        let img_client = create_img_client(&self.app);
        *self.img_client.write() = img_client;
    }

    pub async fn login(&self, username: &str, password: &str) -> anyhow::Result<String> {
        let form = json!({
            "login_name": username,
            "login_pass": password,
        });
        // 發送登入請求
        let api_domain = self.get_api_domain();
        let request = self
            .api_client
            .read()
            .post(format!("https://{api_domain}/users-check_login.html"))
            .header("referer", format!("https://{api_domain}/"))
            .form(&form);
        let http_resp = request.send().await?;
        // 檢查http響應狀態碼
        let status = http_resp.status();
        let headers = http_resp.headers().clone();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        // 嘗試將body解析為LoginResp
        let login_resp = serde_json::from_str::<LoginResp>(&body)
            .context(format!("將body解析為LoginResp失敗: {body}"))?;
        // 檢查LoginResp的ret欄位，如果為false則登入失敗
        if !login_resp.ret {
            return Err(anyhow!("登入失敗: {login_resp:?}"));
        }
        // 獲取resp header中的set-cookie欄位
        let cookie = headers
            .get("set-cookie")
            .ok_or(anyhow!("響應中沒有set-cookie欄位: {login_resp:?}"))?
            .to_str()
            .context(format!(
                "響應中的set-cookie欄位不是utf-8字串: {login_resp:?}"
            ))?
            .to_string();

        Ok(cookie)
    }

    pub async fn get_user_profile(&self) -> anyhow::Result<UserProfile> {
        let cookie = self.app.get_config().read().cookie.clone();
        // 發送獲取使用者資訊請求
        let api_domain = self.get_api_domain();
        let request = self
            .api_client
            .read()
            .get(format!("https://{api_domain}/users.html"))
            .header("cookie", cookie)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        // 檢查http響應狀態碼
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        // 嘗試將body解析為UserProfile
        let user_profile = UserProfile::from_html(&self.app, &body)
            .context(format!("將body解析為UserProfile失敗: {body}"))?;
        Ok(user_profile)
    }

    pub async fn search_by_keyword(
        &self,
        keyword: &str,
        page_num: i64,
        cate_id: Option<i64>,
        scan_mode: Option<&str>,
    ) -> anyhow::Result<SearchResult> {
        if let Some(cate_id) = cate_id {
            return self
                .search_keyword_in_category(keyword, cate_id, page_num, scan_mode)
                .await;
        }

        self.clear_scoped_search_cache();

        self.fetch_keyword_search_page(keyword, page_num).await
    }

    async fn fetch_keyword_search_page(
        &self,
        keyword: &str,
        page_num: i64,
    ) -> anyhow::Result<SearchResult> {
        let params = json!({
            "q": keyword,
            "syn": "yes",
            "f": "_all",
            "s": "create_time_DESC",
            "p": page_num,
        });
        let api_domain = self.get_api_domain();
        let request = self
            .api_client
            .read()
            .get(format!("https://{api_domain}/search/index.php"))
            .header("referer", format!("https://{api_domain}/"))
            .query(&params);
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        let search_result = SearchResult::from_html(&self.app, &body, false)
            .context(format!("將html解析為SearchResult失敗: {body}"))?;
        Ok(search_result)
    }

    /// 在指定分類內搜尋關鍵詞：先走官網關鍵詞搜尋，再依 list_cate_id 篩選
    async fn search_keyword_in_category(
        &self,
        keyword: &str,
        cate_id: i64,
        page_num: i64,
        scan_mode: Option<&str>,
    ) -> anyhow::Result<SearchResult> {
        const PAGE_SIZE: i64 = 20;

        let cache_key = format!("k:{keyword}");
        let all_comics = if page_num <= 1 {
            let comics = self
                .collect_keyword_pages_for_scoped_cache(keyword, cate_id, scan_mode)
                .await?;
            self.store_scoped_cache(&cache_key, &comics);
            comics
        } else {
            self.get_or_build_scoped_cache(&cache_key, || async {
                self.collect_keyword_pages_for_scoped_cache(keyword, cate_id, scan_mode)
                    .await
            })
            .await?
        };
        let mut all_matches = Self::filter_comics_by_cate(&all_comics, cate_id);
        all_matches.sort_by(|left, right| right.id().cmp(&left.id()));

        Ok(SearchResult::from_collected(
            all_matches,
            page_num,
            PAGE_SIZE,
            false,
        ))
    }

    async fn collect_keyword_pages_for_scoped_cache(
        &self,
        keyword: &str,
        cate_id: i64,
        scan_mode: Option<&str>,
    ) -> anyhow::Result<Vec<ComicInSearch>> {
        let first_page = self.fetch_keyword_search_page(keyword, 1).await?;
        self.collect_scoped_matches_paced(
            cate_id,
            "search",
            first_page,
            keyword.to_string(),
            false,
            ScopedScanMode::from_value(scan_mode),
        )
        .await
    }

    pub async fn search_by_tag(
        &self,
        tag_name: &str,
        page_num: i64,
        cate_id: Option<i64>,
        scan_mode: Option<&str>,
    ) -> anyhow::Result<SearchResult> {
        if let Some(cate_id) = cate_id {
            return self
                .search_tag_in_category(tag_name, cate_id, page_num, scan_mode)
                .await;
        }

        self.clear_scoped_search_cache();

        self.fetch_tag_page(tag_name, page_num).await
    }

    async fn fetch_tag_page(&self, tag_name: &str, page_num: i64) -> anyhow::Result<SearchResult> {
        let api_domain = self.get_api_domain();
        // 第 1 頁常見為 albums-index-tag-{tag}.html；分頁為 albums-index-page-{n}-tag-{tag}.html
        let url = if page_num <= 1 {
            format!("https://{api_domain}/albums-index-tag-{tag_name}.html")
        } else {
            format!("https://{api_domain}/albums-index-page-{page_num}-tag-{tag_name}.html")
        };
        let request = self
            .api_client
            .read()
            .get(url)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        // 嘗試將body解析為SearchResult
        let search_result = SearchResult::from_html(&self.app, &body, true)
            .context(format!("將html解析為SearchResult失敗: {body}"))?;
        Ok(search_result)
    }

    /// 標籤列表為全站結果，依列表項上的 list_cate_id 篩選分類
    async fn search_tag_in_category(
        &self,
        tag_name: &str,
        cate_id: i64,
        page_num: i64,
        scan_mode: Option<&str>,
    ) -> anyhow::Result<SearchResult> {
        const PAGE_SIZE: i64 = 20;

        let cache_key = format!("t:{tag_name}");
        let all_comics = if page_num <= 1 {
            let comics = self
                .collect_tag_pages_for_scoped_cache(tag_name, cate_id, scan_mode)
                .await?;
            self.store_scoped_cache(&cache_key, &comics);
            comics
        } else {
            self.get_or_build_scoped_cache(&cache_key, || async {
                self.collect_tag_pages_for_scoped_cache(tag_name, cate_id, scan_mode)
                    .await
            })
            .await?
        };
        let mut all_matches = Self::filter_comics_by_cate(&all_comics, cate_id);
        all_matches.sort_by(|left, right| right.id().cmp(&left.id()));

        Ok(SearchResult::from_collected(
            all_matches,
            page_num,
            PAGE_SIZE,
            true,
        ))
    }

    async fn collect_tag_pages_for_scoped_cache(
        &self,
        tag_name: &str,
        cate_id: i64,
        scan_mode: Option<&str>,
    ) -> anyhow::Result<Vec<ComicInSearch>> {
        let first_page = self.fetch_tag_page(tag_name, 1).await?;
        self.collect_scoped_matches_paced(
            cate_id,
            "tag",
            first_page,
            tag_name.to_string(),
            true,
            ScopedScanMode::from_value(scan_mode),
        )
        .await
    }

    fn filter_comics_by_cate(comics: &[ComicInSearch], cate_id: i64) -> Vec<ComicInSearch> {
        comics
            .iter()
            .filter(|comic| Self::comic_matches_cate_scope(comic, cate_id))
            .cloned()
            .collect()
    }

    fn comic_matches_cate_scope(comic: &ComicInSearch, cate_id: i64) -> bool {
        let Some(list_cate_id) = comic.list_cate_id() else {
            return false;
        };
        Self::cate_id_matches_scope(list_cate_id, cate_id)
    }

    fn cate_id_matches_scope(list_cate_id: i64, cate_id: i64) -> bool {
        list_cate_id == cate_id
            || match cate_id {
                5 => matches!(list_cate_id, 1 | 12 | 16 | 2 | 37 | 22 | 3),
                6 => matches!(list_cate_id, 9 | 13 | 17),
                7 => matches!(list_cate_id, 10 | 14 | 18),
                19 => matches!(list_cate_id, 20 | 21),
                _ => false,
            }
    }

    async fn wait_scoped_search_page_turn(&self, next_page: i64) -> anyhow::Result<bool> {
        const BASE_DELAY_MS: u64 = 500;
        const JITTER_MS: u64 = 1000;
        const COOLDOWN_EVERY_PAGES: i64 = 25;
        const COOLDOWN_MS: u64 = 6000;

        let page = next_page.max(1) as u64;
        let mut delay_ms = BASE_DELAY_MS + ((page * 137) % JITTER_MS);
        if next_page > 2 && (next_page - 2) % COOLDOWN_EVERY_PAGES == 0 {
            delay_ms += COOLDOWN_MS;
        }

        let mut elapsed_ms = 0_u64;
        while elapsed_ms < delay_ms {
            if self.is_scoped_scan_cancelled() {
                return Ok(false);
            }
            let step_ms = (delay_ms - elapsed_ms).min(250);
            tokio::time::sleep(Duration::from_millis(step_ms)).await;
            elapsed_ms += step_ms;
        }
        Ok(true)
    }

    async fn fetch_scoped_search_page(
        &self,
        query: &str,
        page: i64,
        is_tag: bool,
    ) -> anyhow::Result<SearchResult> {
        if is_tag {
            self.fetch_tag_page(query, page).await
        } else {
            self.fetch_keyword_search_page(query, page).await
        }
    }

    fn random_page_span(min: i64, max: i64, salt: i64) -> i64 {
        let range = (max - min + 1).max(1) as u64;
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos() as u64)
            .unwrap_or_default();
        let mut seed = nanos ^ (salt as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
        seed ^= seed >> 30;
        seed = seed.wrapping_mul(0xBF58_476D_1CE4_E5B9);
        seed ^= seed >> 27;
        seed = seed.wrapping_mul(0x94D0_49BB_1331_11EB);
        seed ^= seed >> 31;
        min + (seed % range) as i64
    }

    fn classify_scan_failure(reason: &str) -> &'static str {
        let lower = reason.to_lowercase();
        if lower.contains("timeout") || lower.contains("timed out") || lower.contains("deadline") {
            "超時"
        } else if lower.contains("just a moment")
            || lower.contains("challenges.cloudflare.com")
            || lower.contains("/cdn-cgi/challenge-platform")
            || lower.contains("cf-chl-")
            || lower.contains("enable javascript and cookies")
        {
            "被拒絕"
        } else if lower.contains("429") || lower.contains("too many") {
            "請求過於頻繁"
        } else if lower.contains("status") || lower.contains("狀態碼") {
            "HTTP錯誤"
        } else {
            "其他錯誤"
        }
    }

    fn append_scoped_page_result(
        &self,
        cate_id: i64,
        total_pages: i64,
        scan_kind: &str,
        page_result: &SearchResult,
        all_comics: &mut Vec<ComicInSearch>,
        matched_count: &mut i64,
        completed: &mut i64,
    ) {
        *matched_count += Self::filter_comics_by_cate(page_result.comics(), cate_id).len() as i64;
        all_comics.extend(page_result.comics().iter().cloned());
        *completed += 1;
        self.emit_search_scan_progress(
            *completed,
            total_pages,
            *matched_count,
            scan_kind,
            *completed >= total_pages,
            false,
            None,
            None,
            false,
        );
    }

    async fn fetch_scoped_search_page_with_retry(
        &self,
        query: &str,
        page: i64,
        is_tag: bool,
        completed: i64,
        total_pages: i64,
        matched_count: i64,
        scan_kind: &str,
    ) -> anyhow::Result<Option<SearchResult>> {
        let mut attempt = 0_u32;
        loop {
            if self.is_scoped_scan_cancelled() {
                return Ok(None);
            }

            attempt += 1;
            if attempt > 1
                && !self
                    .wait_scoped_scan_retry(completed, total_pages, matched_count, scan_kind)
                    .await?
            {
                return Ok(None);
            }

            if let Ok(result) = self.fetch_scoped_search_page(query, page, is_tag).await {
                return Ok(Some(result));
            }
        }
    }

    async fn collect_scoped_matches_parallel_batch(
        &self,
        cate_id: i64,
        scan_kind: &str,
        total_pages: i64,
        query: &str,
        is_tag: bool,
        start_page: i64,
        end_page: i64,
        retry_failed: bool,
        all_comics: &mut Vec<ComicInSearch>,
        matched_count: &mut i64,
        completed: &mut i64,
    ) -> anyhow::Result<ScopedBatchOutcome> {
        let mut join_set = tokio::task::JoinSet::new();
        let mut page_results: Vec<(i64, SearchResult)> =
            Vec::with_capacity((end_page - start_page + 1).max(0) as usize);
        let mut failed_pages = Vec::new();
        let mut page_failures = Vec::new();

        for page in start_page..=end_page {
            if self.is_scoped_scan_cancelled() {
                return Ok(ScopedBatchOutcome {
                    completed: false,
                    page_failures,
                });
            }

            let client = self.clone();
            let page_query = query.to_string();
            join_set.spawn(async move {
                let result = client
                    .fetch_scoped_search_page(&page_query, page, is_tag)
                    .await;
                (page, result)
            });
        }

        while !join_set.is_empty() {
            tokio::select! {
                joined = join_set.join_next() => {
                    let Some(joined) = joined else {
                        break;
                    };
                    let (page, page_result) = joined.context("分類快速掃描任務失敗")?;
                    match page_result {
                        Ok(page_result) => page_results.push((page, page_result)),
                        Err(err) => {
                            let reason = err.to_string_chain();
                            page_failures.push(ScopedPageFailure {
                                page,
                                category: Self::classify_scan_failure(&reason).to_string(),
                            });
                            failed_pages.push((page, reason));
                        }
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(200)) => {}
            }

            if self.is_scoped_scan_cancelled() {
                join_set.abort_all();
                return Ok(ScopedBatchOutcome {
                    completed: false,
                    page_failures,
                });
            }
        }

        failed_pages.sort_unstable_by_key(|(page, _)| *page);
        if !retry_failed && !failed_pages.is_empty() {
            page_results.sort_by_key(|(page, _)| *page);
            for (_, page_result) in page_results.drain(..) {
                self.append_scoped_page_result(
                    cate_id,
                    total_pages,
                    scan_kind,
                    &page_result,
                    all_comics,
                    matched_count,
                    completed,
                );
            }
            return Ok(ScopedBatchOutcome {
                completed: false,
                page_failures,
            });
        }
        for (page, _) in failed_pages {
            let Some(page_result) = self
                .fetch_scoped_search_page_with_retry(
                    query,
                    page,
                    is_tag,
                    *completed,
                    total_pages,
                    *matched_count,
                    scan_kind,
                )
                .await?
            else {
                page_results.sort_by_key(|(page, _)| *page);
                for (_, page_result) in page_results.drain(..) {
                    self.append_scoped_page_result(
                        cate_id,
                        total_pages,
                        scan_kind,
                        &page_result,
                        all_comics,
                        matched_count,
                        completed,
                    );
                }
                return Ok(ScopedBatchOutcome {
                    completed: false,
                    page_failures,
                });
            };
            page_results.push((page, page_result));
        }

        page_results.sort_by_key(|(page, _)| *page);
        for (_, page_result) in page_results {
            self.append_scoped_page_result(
                cate_id,
                total_pages,
                scan_kind,
                &page_result,
                all_comics,
                matched_count,
                completed,
            );
        }

        Ok(ScopedBatchOutcome {
            completed: true,
            page_failures,
        })
    }

    async fn collect_scoped_matches_paced_batch(
        &self,
        cate_id: i64,
        scan_kind: &str,
        total_pages: i64,
        query: &str,
        is_tag: bool,
        start_page: i64,
        end_page: i64,
        all_comics: &mut Vec<ComicInSearch>,
        matched_count: &mut i64,
        completed: &mut i64,
    ) -> anyhow::Result<bool> {
        for page in (start_page..=end_page).rev() {
            if self.is_scoped_scan_cancelled() {
                return Ok(false);
            }

            if !self.wait_scoped_search_page_turn(page).await? {
                return Ok(false);
            }

            let Some(page_result) = self
                .fetch_scoped_search_page_with_retry(
                    query,
                    page,
                    is_tag,
                    *completed,
                    total_pages,
                    *matched_count,
                    scan_kind,
                )
                .await?
            else {
                return Ok(false);
            };

            self.append_scoped_page_result(
                cate_id,
                total_pages,
                scan_kind,
                &page_result,
                all_comics,
                matched_count,
                completed,
            );
        }

        Ok(true)
    }

    async fn collect_scoped_matches_parallel_fast(
        &self,
        cate_id: i64,
        scan_kind: &str,
        total_pages: i64,
        first_page: SearchResult,
        query: String,
        is_tag: bool,
        mut all_comics: Vec<ComicInSearch>,
        mut matched_count: i64,
        mut completed: i64,
    ) -> anyhow::Result<Vec<ComicInSearch>> {
        let outcome = self
            .collect_scoped_matches_parallel_batch(
                cate_id,
                scan_kind,
                total_pages,
                &query,
                is_tag,
                2,
                total_pages,
                true,
                &mut all_comics,
                &mut matched_count,
                &mut completed,
            )
            .await?;
        if !outcome.completed {
            self.emit_scoped_scan_cancelled(completed, total_pages, matched_count, scan_kind);
            return Ok(all_comics);
        }

        self.append_scoped_page_result(
            cate_id,
            total_pages,
            scan_kind,
            &first_page,
            &mut all_comics,
            &mut matched_count,
            &mut completed,
        );

        Ok(all_comics)
    }

    async fn collect_scoped_matches_manual_aggressive(
        &self,
        cate_id: i64,
        scan_kind: &str,
        total_pages: i64,
        first_page: SearchResult,
        query: String,
        is_tag: bool,
    ) -> anyhow::Result<Vec<ComicInSearch>> {
        const BATCH_MIN: i64 = 100;
        const BATCH_MAX: i64 = 200;
        let mut all_comics = Vec::new();
        let mut matched_count = 0_i64;
        let mut completed = 0_i64;
        let mut page = total_pages;
        let mut retry_pages: Vec<i64> = Vec::new();
        let mut paused_reason: Option<&'static str> = None;
        let mut pending_page_after_retries: Option<i64> = None;

        while page >= 1 {
            if self.is_scoped_scan_cancelled() {
                self.emit_scoped_scan_cancelled(completed, total_pages, matched_count, scan_kind);
                return Ok(all_comics);
            }
            if paused_reason.is_some()
                && !self
                    .wait_manual_scoped_scan_request(
                        completed,
                        total_pages,
                        matched_count,
                        scan_kind,
                        paused_reason,
                    )
                    .await?
            {
                self.emit_scoped_scan_cancelled(completed, total_pages, matched_count, scan_kind);
                return Ok(all_comics);
            }
            paused_reason = None;

            let is_retry_batch = !retry_pages.is_empty();
            let batch_size = if is_retry_batch {
                retry_pages.len() as i64
            } else {
                Self::random_page_span(BATCH_MIN, BATCH_MAX, page ^ completed ^ total_pages)
            };
            let start_page = if is_retry_batch {
                *retry_pages.iter().min().unwrap_or(&page)
            } else {
                1_i64.max(page - batch_size + 1)
            };
            let end_page = if is_retry_batch {
                *retry_pages.iter().max().unwrap_or(&page)
            } else {
                page
            };
            let mut pages_to_scan = if is_retry_batch {
                let mut pages = retry_pages.clone();
                retry_pages.clear();
                pages.sort_unstable_by(|left, right| right.cmp(left));
                pages
            } else {
                pending_page_after_retries = Some(start_page - 1);
                (start_page.max(2)..=end_page).rev().collect::<Vec<_>>()
            };

            while !pages_to_scan.is_empty() {
                let take = pages_to_scan.len();
                let segment = pages_to_scan.drain(0..take).collect::<Vec<_>>();
                let Some(segment_start) = segment.iter().min().copied() else {
                    continue;
                };
                let Some(segment_end) = segment.iter().max().copied() else {
                    continue;
                };
                let outcome = self
                    .collect_scoped_matches_parallel_batch(
                        cate_id,
                        scan_kind,
                        total_pages,
                        &query,
                        is_tag,
                        segment_start,
                        segment_end,
                        false,
                        &mut all_comics,
                        &mut matched_count,
                        &mut completed,
                    )
                    .await?;
                let challenge_detected = outcome
                    .page_failures
                    .iter()
                    .any(|failure| failure.category == "被拒絕");
                retry_pages.extend(outcome.page_failures.iter().map(|failure| failure.page));
                if self.is_scoped_scan_cancelled() {
                    self.emit_scoped_scan_cancelled(
                        completed,
                        total_pages,
                        matched_count,
                        scan_kind,
                    );
                    return Ok(all_comics);
                }
                if challenge_detected {
                    retry_pages.extend(pages_to_scan.drain(..));
                    retry_pages.sort_unstable_by(|left, right| right.cmp(left));
                    retry_pages.dedup();
                    paused_reason = Some("已被 Cloudflare 挑戰，請換 IP 或等待");
                    break;
                }
            }

            if !retry_pages.is_empty() {
                retry_pages.sort_unstable_by(|left, right| right.cmp(left));
                retry_pages.dedup();
                paused_reason.get_or_insert("部分頁面失敗，下一次送出只會補掃失敗頁");
                continue;
            }
            if let Some(next_page) = pending_page_after_retries.take() {
                page = next_page;
            }
            if start_page == 1 {
                self.append_scoped_page_result(
                    cate_id,
                    total_pages,
                    scan_kind,
                    &first_page,
                    &mut all_comics,
                    &mut matched_count,
                    &mut completed,
                );
            }
        }

        Ok(all_comics)
    }

    async fn collect_scoped_matches_randomized_large(
        &self,
        cate_id: i64,
        scan_kind: &str,
        total_pages: i64,
        query: String,
        is_tag: bool,
        scan_mode: ScopedScanMode,
        mut all_comics: Vec<ComicInSearch>,
        mut matched_count: i64,
        mut completed: i64,
        first_page: SearchResult,
    ) -> anyhow::Result<Vec<ComicInSearch>> {
        let mut page = total_pages;
        let mut round = 0_i64;
        let mut use_parallel = Self::random_page_span(0, 1, total_pages) == 1;

        while page >= 2 {
            if self.is_scoped_scan_cancelled() {
                self.emit_scoped_scan_cancelled(completed, total_pages, matched_count, scan_kind);
                return Ok(all_comics);
            }

            let conservative_round = scan_mode == ScopedScanMode::Conservative;
            let parallel_span = if conservative_round {
                (30, 40)
            } else {
                (40, 50)
            };
            let paced_span = if conservative_round {
                (10, 30)
            } else {
                (10, 15)
            };
            let span = if use_parallel {
                Self::random_page_span(parallel_span.0, parallel_span.1, page ^ round ^ total_pages)
            } else {
                Self::random_page_span(
                    paced_span.0,
                    paced_span.1,
                    page ^ round ^ total_pages ^ 0x55AA,
                )
            };
            let start_page = 2_i64.max(page - span + 1);

            let completed_ok = if use_parallel {
                let outcome = self
                    .collect_scoped_matches_parallel_batch(
                        cate_id,
                        scan_kind,
                        total_pages,
                        &query,
                        is_tag,
                        start_page,
                        page,
                        true,
                        &mut all_comics,
                        &mut matched_count,
                        &mut completed,
                    )
                    .await?;
                outcome.completed
            } else {
                self.collect_scoped_matches_paced_batch(
                    cate_id,
                    scan_kind,
                    total_pages,
                    &query,
                    is_tag,
                    start_page,
                    page,
                    &mut all_comics,
                    &mut matched_count,
                    &mut completed,
                )
                .await?
            };

            if !completed_ok {
                self.emit_scoped_scan_cancelled(completed, total_pages, matched_count, scan_kind);
                return Ok(all_comics);
            }

            page = start_page - 1;
            round += 1;
            use_parallel = !use_parallel;
        }

        self.append_scoped_page_result(
            cate_id,
            total_pages,
            scan_kind,
            &first_page,
            &mut all_comics,
            &mut matched_count,
            &mut completed,
        );

        Ok(all_comics)
    }

    async fn collect_scoped_matches_paced(
        &self,
        cate_id: i64,
        scan_kind: &str,
        first_page: SearchResult,
        query: String,
        is_tag: bool,
        scan_mode: ScopedScanMode,
    ) -> anyhow::Result<Vec<ComicInSearch>> {
        self.begin_scoped_scan();

        let total_pages = first_page.total_page().max(1);
        if scan_mode == ScopedScanMode::Aggressive {
            return self
                .collect_scoped_matches_manual_aggressive(
                    cate_id,
                    scan_kind,
                    total_pages,
                    first_page,
                    query,
                    is_tag,
                )
                .await;
        }

        let all_comics = Vec::new();
        let matched_count = 0_i64;
        let completed = 0_i64;

        self.emit_search_scan_progress(
            completed,
            total_pages,
            matched_count,
            scan_kind,
            false,
            false,
            None,
            None,
            false,
        );

        if total_pages <= 1 {
            let mut all_comics = all_comics;
            let mut matched_count = matched_count;
            let mut completed = completed;
            self.append_scoped_page_result(
                cate_id,
                total_pages,
                scan_kind,
                &first_page,
                &mut all_comics,
                &mut matched_count,
                &mut completed,
            );
            return Ok(all_comics);
        }

        if total_pages < 100 {
            return self
                .collect_scoped_matches_parallel_fast(
                    cate_id,
                    scan_kind,
                    total_pages,
                    first_page,
                    query,
                    is_tag,
                    all_comics,
                    matched_count,
                    completed,
                )
                .await;
        }

        self.collect_scoped_matches_randomized_large(
            cate_id,
            scan_kind,
            total_pages,
            query,
            is_tag,
            scan_mode,
            all_comics,
            matched_count,
            completed,
            first_page,
        )
        .await
    }

    async fn get_or_build_scoped_cache<F, Fut>(
        &self,
        cache_key: &str,
        build: F,
    ) -> anyhow::Result<Vec<ComicInSearch>>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = anyhow::Result<Vec<ComicInSearch>>>,
    {
        {
            let cache = self.scoped_search_cache.read();
            if let Some((cached_key, entry)) = cache.as_ref() {
                if cached_key == cache_key {
                    return Ok(entry.comics.clone());
                }
            }
        }

        let comics = build().await?;
        self.store_scoped_cache(cache_key, &comics);
        Ok(comics)
    }

    fn store_scoped_cache(&self, cache_key: &str, comics: &[ComicInSearch]) {
        *self.scoped_search_cache.write() = Some((
            cache_key.to_string(),
            ScopedSearchCacheEntry {
                comics: comics.to_vec(),
            },
        ));
    }

    pub async fn browse_by_category(
        &self,
        cate_id: i64,
        page_num: i64,
    ) -> anyhow::Result<SearchResult> {
        self.clear_scoped_search_cache();

        self.fetch_category_page(cate_id, page_num).await
    }

    pub async fn browse_ranking(
        &self,
        period: RankingPeriod,
        cate_id: Option<i64>,
        page_num: i64,
    ) -> anyhow::Result<SearchResult> {
        self.clear_scoped_search_cache();

        let api_domain = self.get_api_domain();
        let url = build_favorite_ranking_url(&api_domain, page_num, period, cate_id);
        tracing::debug!(url = %url, "瀏覽排行榜");
        let cookie = self.app.get_config().read().cookie.clone();
        let http_resp = self
            .api_client
            .read()
            .get(&url)
            .timeout(std::time::Duration::from_secs(30))
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            )
            .header("referer", format!("https://{api_domain}/albums-favorite_ranking.html"))
            .header("cookie", cookie)
            .send()
            .await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        SearchResult::from_ranking_html(&self.app, &body)
            .context("將排行榜頁面解析為 SearchResult 失敗")
    }

    async fn fetch_category_page(
        &self,
        cate_id: i64,
        page_num: i64,
    ) -> anyhow::Result<SearchResult> {
        let api_domain = self.get_api_domain();
        let url = if page_num <= 1 {
            format!("https://{api_domain}/albums-index-cate-{cate_id}.html")
        } else {
            format!("https://{api_domain}/albums-index-page-{page_num}-cate-{cate_id}.html")
        };
        let request = self
            .api_client
            .read()
            .get(url)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        let search_result = SearchResult::from_html(&self.app, &body, true)
            .context(format!("將分類頁面解析為SearchResult失敗: {body}"))?;
        Ok(search_result)
    }

    pub async fn browse_albums_list(&self, page_num: i64) -> anyhow::Result<SearchResult> {
        let api_domain = self.get_api_domain();
        let url = if page_num <= 1 {
            format!("https://{api_domain}/albums.html")
        } else {
            format!("https://{api_domain}/albums-index-page-{page_num}.html")
        };
        let request = self
            .api_client
            .read()
            .get(url)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        let search_result = SearchResult::from_html(&self.app, &body, true)
            .context(format!("將更新列表解析為SearchResult失敗: {body}"))?;
        Ok(search_result)
    }

    pub async fn browse_home(&self, page_num: i64) -> anyhow::Result<SearchResult> {
        let api_domain = self.get_api_domain();
        let url = if page_num <= 1 {
            format!("https://{api_domain}/")
        } else {
            format!("https://{api_domain}/albums-index-page-{page_num}.html")
        };
        let request = self
            .api_client
            .read()
            .get(url)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        let search_result = SearchResult::from_html(&self.app, &body, true)
            .context(format!("將首頁解析為SearchResult失敗: {body}"))?;
        Ok(search_result)
    }

    pub async fn get_img_list(&self, id: i64) -> anyhow::Result<ImgList> {
        let api_domain = self.get_api_domain();
        let url = format!("https://{api_domain}/photos-gallery-aid-{id}.html");
        let request = self
            .api_client
            .read()
            .get(url)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        // 找到包含`imglist`的行
        let img_list_line = body
            .lines()
            .find(|line| line.contains("var imglist = "))
            .context("沒有找到包含`imglist`的行")?;
        // 找到`imglist`行中的 JSON 部分的起始和結束位置
        let start = img_list_line
            .find('[')
            .context("沒有在`imglist`行中找到`[`")?;
        let end = img_list_line
            .rfind(']')
            .context("沒有在`imglist`行中找到`]`")?;
        // 將 JSON 部分提取出來，並轉為合法的 JSON 字串
        let json_str = &img_list_line[start..=end]
            .replace("url:", "\"url\":")
            .replace("caption:", "\"caption\":")
            .replace("fast_img_host+", "")
            .replace("\\\"", "\"");
        // 將 JSON 字串解析為 ImgList
        let img_list = serde_json::from_str::<ImgList>(json_str)
            .context(format!("將JSON字串解析為ImgList失敗: {json_str}"))?;
        Ok(img_list)
    }

    pub async fn get_comic(&self, id: i64) -> anyhow::Result<Comic> {
        let api_domain = self.get_api_domain();
        let request = self
            .api_client
            .read()
            .get(format!("https://{api_domain}/photos-index-aid-{id}.html"))
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        // TODO: 可以併發獲取body和img_list
        let img_list = self.get_img_list(id).await?;
        // 嘗試將body解析為Comic
        let comic = Comic::from_html(&self.app, &body, img_list)
            .context(format!("將body和解析為Comic失敗: {body}"))?;

        Ok(comic)
    }

    pub async fn get_comic_tags(&self, id: i64) -> anyhow::Result<Vec<Tag>> {
        let api_domain = self.get_api_domain();
        let request = self
            .api_client
            .read()
            .get(format!("https://{api_domain}/photos-index-aid-{id}.html"))
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        Comic::parse_tags_from_html(&self.app, &body)
            .context(format!("從漫畫頁面解析標籤失敗: {body}"))
    }

    pub async fn get_shelf(&self, shelf_id: i64, page_num: i64) -> anyhow::Result<GetShelfResult> {
        let cookie = self.app.get_config().read().cookie.clone();
        // 發送獲取書架請求
        let api_domain = self.get_api_domain();
        let url = format!("https://{api_domain}/users-users_fav-page-{page_num}-c-{shelf_id}.html");
        let request = self
            .api_client
            .read()
            .get(url)
            .header("cookie", cookie)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        // 檢查http響應狀態碼
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        // 嘗試將body解析為GetShelfResult
        let get_shelf_result = GetShelfResult::from_html(&self.app, &body)
            .context(format!("將body解析為GetShelfResult失敗: {body}"))?;
        Ok(get_shelf_result)
    }

    pub async fn get_img_data_and_format(&self, url: &str) -> anyhow::Result<(Bytes, ImageFormat)> {
        // 發送下載圖片請
        let api_domain = self.get_api_domain();
        let request = self
            .img_client
            .read()
            .get(url)
            .header("referer", format!("https://{api_domain}/"));
        let http_resp = request.send().await?;
        // 檢查http響應狀態碼
        let status = http_resp.status();
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(anyhow!("IP被封，請在設定中減少併發數或設置下載完成後的休息時間，以此降低下載速度，稍後再試"));
        } else if status != StatusCode::OK {
            let body = http_resp.text().await?;
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        let image_data = http_resp.bytes().await?;

        let format = image::guess_format(&image_data)
            .context("無法從圖片數據中猜測出圖片格式，可能圖片數據不完整或已損壞")?;

        Ok((image_data, format))
    }

    pub async fn get_zip_download_info(&self, comic_id: i64) -> anyhow::Result<ZipDownloadInfo> {
        let cookie = self.app.get_config().read().cookie.clone();
        let api_domain = self.get_api_domain();
        let url = format!("https://{api_domain}/download-index-aid-{comic_id}.html");
        let referer = format!("https://{api_domain}/photos-index-aid-{comic_id}.html");
        let request = self
            .api_client
            .read()
            .get(&url)
            .header("cookie", cookie)
            .header("referer", referer);
        let http_resp = request.send().await?;
        let status = http_resp.status();
        let body = http_resp.text().await?;
        if status != StatusCode::OK {
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        parse_zip_download_page(&body)
    }

    pub fn get_zip_backup_url(info: &ZipDownloadInfo) -> anyhow::Result<String> {
        info.backup_url
            .as_ref()
            .map(|url| normalize_download_url(url))
            .context("找不到 Server 2 zip 下載鏈接")
    }

    pub async fn download_zip_to_path(
        &self,
        url: &str,
        save_path: &Path,
        byte_per_sec: &AtomicU64,
        referer: &str,
        downloaded_bytes: &AtomicU64,
        total_bytes: &AtomicU64,
        mut on_progress: impl FnMut() + Send,
    ) -> anyhow::Result<()> {
        if let Some(parent) = save_path.parent() {
            std::fs::create_dir_all(parent)
                .context(format!("創建目錄`{}`失敗", parent.display()))?;
        }

        let request = self.img_client.read().get(url).header("referer", referer);
        let http_resp = request.send().await?;
        let status = http_resp.status();
        if status != StatusCode::OK {
            let body = http_resp.text().await.unwrap_or_default();
            return Err(anyhow!("下載 zip 狀態碼({status}): {body}"));
        }

        if let Some(len) = http_resp.content_length() {
            total_bytes.store(len, Ordering::Relaxed);
            on_progress();
        }

        let mut file = tokio::fs::File::create(save_path)
            .await
            .context(format!("創建檔案`{}`失敗", save_path.display()))?;
        let mut response = http_resp;
        let mut last_progress_emit = std::time::Instant::now();
        while let Some(chunk) = response.chunk().await.context("讀取 zip 下載數據失敗")? {
            tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                .await
                .context(format!("寫入檔案`{}`失敗", save_path.display()))?;
            let chunk_len = chunk.len() as u64;
            byte_per_sec.fetch_add(chunk_len, Ordering::Relaxed);
            downloaded_bytes.fetch_add(chunk_len, Ordering::Relaxed);
            if last_progress_emit.elapsed() >= Duration::from_millis(300) {
                on_progress();
                last_progress_emit = std::time::Instant::now();
            }
        }
        on_progress();

        Ok(())
    }

    pub async fn get_cover_data(&self, cover_url: &str) -> anyhow::Result<Bytes> {
        let api_domain = self.get_api_domain();
        let http_resp = self
            .cover_client
            .get(cover_url)
            .header("referer", format!("https://{api_domain}/"))
            .send()
            .await?;
        let status = http_resp.status();
        if status != StatusCode::OK {
            let body = http_resp.text().await?;
            return Err(anyhow!("預料之外的狀態碼({status}): {body}"));
        }
        let cover_data = http_resp.bytes().await?;
        Ok(cover_data)
    }

    fn get_api_domain(&self) -> String {
        self.app.get_config().read().get_api_domain()
    }
}

fn create_api_client(app: &AppHandle) -> ClientWithMiddleware {
    let retry_policy = ExponentialBackoff::builder()
        .base(1) // 指數為1，保證重試間隔為1秒不變
        .jitter(Jitter::Bounded) // 重試間隔在1秒左右波動
        .build_with_total_retry_duration(Duration::from_secs(5)); // 重試總時長為5秒

    let client = reqwest::ClientBuilder::new()
        .use_rustls_tls()
        .timeout(Duration::from_secs(3)) // 每個請求超過3秒就超時
        .set_proxy(app, "api_client")
        .build()
        .unwrap();

    reqwest_middleware::ClientBuilder::new(client)
        .with(RetryTransientMiddleware::new_with_policy(retry_policy))
        .build()
}

fn create_img_client(app: &AppHandle) -> ClientWithMiddleware {
    let retry_policy = ExponentialBackoff::builder().build_with_max_retries(3);

    let client = reqwest::ClientBuilder::new()
        .use_rustls_tls()
        .set_proxy(app, "img_client")
        .build()
        .unwrap();

    reqwest_middleware::ClientBuilder::new(client)
        .with(RetryTransientMiddleware::new_with_policy(retry_policy))
        .build()
}

trait ClientBuilderExt {
    fn set_proxy(self, app: &AppHandle, client_name: &str) -> Self;
}

impl ClientBuilderExt for reqwest::ClientBuilder {
    fn set_proxy(self, app: &AppHandle, client_name: &str) -> reqwest::ClientBuilder {
        let proxy_mode = app.get_config().read().proxy_mode;
        match proxy_mode {
            ProxyMode::System => self,
            ProxyMode::NoProxy => self.no_proxy(),
            ProxyMode::Custom => {
                let config = app.get_config().inner().read();
                let proxy_host = &config.proxy_host;
                let proxy_port = &config.proxy_port;
                let proxy_url = format!("http://{proxy_host}:{proxy_port}");

                match reqwest::Proxy::all(&proxy_url).map_err(anyhow::Error::from) {
                    Ok(proxy) => self.proxy(proxy),
                    Err(err) => {
                        let err_title = format!("{client_name}將`{proxy_url}`設為代理失敗，將直連");
                        let string_chain = err.to_string_chain();
                        tracing::error!(err_title, message = string_chain);
                        self.no_proxy()
                    }
                }
            }
        }
    }
}
