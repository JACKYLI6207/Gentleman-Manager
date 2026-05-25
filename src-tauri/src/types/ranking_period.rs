use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
pub enum RankingPeriod {
    Day,
    Week,
    Month,
    Year,
}

impl RankingPeriod {
    pub fn parse_str(s: &str) -> anyhow::Result<Self> {
        match s {
            "Day" | "day" => Ok(Self::Day),
            "Week" | "week" => Ok(Self::Week),
            "Month" | "month" => Ok(Self::Month),
            "Year" | "year" => Ok(Self::Year),
            other => Err(anyhow::anyhow!("未知的排行榜時間範圍: {other}")),
        }
    }

    pub fn url_suffix(self) -> &'static str {
        match self {
            Self::Week => "",
            Self::Day => "-type-day",
            Self::Month => "-type-month",
            Self::Year => "-type-year",
        }
    }
}

pub fn build_favorite_ranking_url(
    api_domain: &str,
    page_num: i64,
    period: RankingPeriod,
    cate_id: Option<i64>,
) -> String {
    let mut path = String::from("albums-favorite_ranking");
    if page_num > 1 {
        path.push_str(&format!("-page-{page_num}"));
    }
    if let Some(cate_id) = cate_id {
        path.push_str(&format!("-cate-{cate_id}"));
    }
    path.push_str(period.url_suffix());
    format!("https://{api_domain}/{path}.html")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_period_deserializes_pascal_case_from_frontend() {
        let period: RankingPeriod = serde_json::from_str("\"Week\"").unwrap();
        assert_eq!(period, RankingPeriod::Week);
    }

    #[test]
    fn ranking_period_parse_str_accepts_frontend_values() {
        assert_eq!(RankingPeriod::parse_str("Week").unwrap(), RankingPeriod::Week);
    }

    #[test]
    fn build_default_week_url() {
        let url = build_favorite_ranking_url("www.wn07.ru", 1, RankingPeriod::Week, None);
        assert_eq!(url, "https://www.wn07.ru/albums-favorite_ranking.html");
    }
}
