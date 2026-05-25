use anyhow::{anyhow, Context};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;

use crate::extensions::{AppHandleExt, ToAnyhow};

#[derive(Default, Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    /// 用戶名
    pub username: String,
    /// 頭像url
    pub avatar: String,
}
impl UserProfile {
    pub fn from_html(app: &AppHandle, html: &str) -> anyhow::Result<UserProfile> {
        // 解析html
        let document = Html::parse_document(html);
        // 檢查是否登入，如果有`.title.title_c`則未登入
        let is_login = document
            .select(&Selector::parse(".title.title_c").to_anyhow()?)
            .next()
            .is_none();
        if !is_login {
            return Err(anyhow!("未登入，cookie已過期或cookie無效"));
        }

        let document_html = document.html();

        // 獲取頭像與用戶名的<a>
        let a = document
            .select(&Selector::parse(".top_utab.ui > a").to_anyhow()?)
            .next()
            .context(format!("沒有找到頭像與用戶名的<a>: {document_html}"))?;
        let a_html = a.html();
        // 獲取頭像url
        let img = a
            .select(&Selector::parse("img").to_anyhow()?)
            .next()
            .context(format!("沒有在頭像與用戶名的<a>中找到<img>: {a_html}"))?;

        let api_domain = app.get_config().read().get_api_domain();
        let avatar = img
            .attr("src")
            .map_or(format!("https://{api_domain}/userpic/nopic.png"), |src| {
                format!("https://{api_domain}/{src}")
            });
        // 獲取用戶名
        let username = a
            .text()
            .next()
            .context(format!("沒有找到用戶名相關的文本: {a_html}"))?
            .trim()
            .to_string();

        let user_profile = UserProfile { username, avatar };
        Ok(user_profile)
    }
}
