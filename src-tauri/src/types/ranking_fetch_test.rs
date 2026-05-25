#[cfg(test)]
mod ranking_fetch_tests {
    use scraper::{Html, Selector};

    #[tokio::test]
    #[ignore = "needs network"]
    async fn fetch_ranking_page_has_gallary_items() {
        let url = "https://www.wn07.ru/albums-favorite_ranking.html";
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap();
        let resp = client
            .get(url)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            )
            .header("Referer", "https://www.wn07.ru/")
            .send()
            .await
            .expect("request failed");
        let status = resp.status();
        let body = resp.text().await.expect("read body");
        assert!(status.is_success(), "status={status}, body_prefix={}", &body[..body.len().min(200)]);

        let document = Html::parse_document(&body);
        let li_count = document
            .select(&Selector::parse(".li.gallary_item").unwrap())
            .count();
        let gallary_count = document
            .select(&Selector::parse(".gallary_item").unwrap())
            .count();
        let aid_links = body.matches("/photos-index-aid-").count();

        let total_count = crate::types::search_result::parse_ranking_total_count_for_test(&body);
        let title_link_count = document
            .select(&Selector::parse(".title > a").unwrap())
            .count();
        let caption_link_count = document
            .select(&Selector::parse(".caption a[href*=\"/photos-index-aid-\"]").unwrap())
            .count();

        println!(
            "li.gallary_item={li_count}, .gallary_item={gallary_count}, aid_links={aid_links}, total_count={total_count}, .title>a={title_link_count}, .caption>a={caption_link_count}"
        );
        assert!(
            li_count > 0 || gallary_count > 0,
            "no gallery items found in ranking html"
        );
        assert!(total_count > 0, "ranking total_count should parse (got {total_count})");
    }
}
