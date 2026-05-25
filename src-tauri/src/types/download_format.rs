use image::ImageFormat;
use serde::{Deserialize, Serialize};
use specta::Type;

/// 下載方式（僅兩種；舊版設定值透過 serde alias 自動遷移）
#[derive(Debug, Copy, Clone, PartialEq, Serialize, Deserialize, Type)]
pub enum DownloadFormat {
    /// 逐張下載 JPEG 後打包為 ZIP，檔名為漫畫網頁標題
    #[serde(rename = "JpegZipPack", alias = "Jpeg", alias = "Png", alias = "Webp", alias = "Original")]
    JpegZipPack,
    /// 官網 Server 2 直鏈整包 ZIP
    #[serde(rename = "Server2Zip", alias = "Zip")]
    Server2Zip,
}

impl Default for DownloadFormat {
    fn default() -> Self {
        Self::Server2Zip
    }
}

impl DownloadFormat {
    pub fn is_server2_zip(self) -> bool {
        matches!(self, Self::Server2Zip)
    }

    pub fn is_jpeg_zip_pack(self) -> bool {
        matches!(self, Self::JpegZipPack)
    }

    pub fn image_extension(self) -> Option<&'static str> {
        match self {
            Self::JpegZipPack => Some("jpg"),
            Self::Server2Zip => None,
        }
    }

    pub fn to_image_format(self) -> Option<ImageFormat> {
        match self {
            Self::JpegZipPack => Some(ImageFormat::Jpeg),
            Self::Server2Zip => None,
        }
    }
}
