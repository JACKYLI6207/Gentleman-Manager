# 開發環境（開源倉庫）

本目錄為 **Gentleman Manager（紳士管理器）** 的輕量原始碼樹，適合推送到 GitHub 並在 clone 後繼續開發。不包含 `node_modules`、Rust `target`、建置產物與本機備份。

## 環境需求

- [Node.js](https://nodejs.org/)（建議 LTS）
- [pnpm](https://pnpm.io/installation)
- [Rust](https://www.rust-lang.org/tools/install)（含 MSVC 工具鏈，Windows）
- [Tauri 前置條件](https://v2.tauri.app/start/prerequisites/)

## 首次設定

```powershell
cd Gentleman-Manager
pnpm install
```

## 日常開發

```powershell
# 前端 + 桌面殼熱重載
pnpm tauri dev
```

## 建置可執行檔（Windows）

```powershell
pnpm tauri:build:fast
```

產物位於 `src-tauri\target\release-fast\Gentleman-Manager.exe`。根目錄的 `Gentleman-Manager-v1.2.exe` / `.zip` 為本機發佈用產物，不納入 Git。

圖示：可將 `logo.ico` 放在專案根目錄後建置；詳見本機 `skill/` 內輔助腳本（該目錄不推送 GitHub）。

## 倉庫體積說明

| 不納入 Git | 取得方式 |
|------------|----------|
| `node_modules/` | `pnpm install` |
| `src-tauri/target/` | 建置時自動產生 |
| `dist/` | `pnpm build` / `pnpm tauri build` |
| `.cursor/`、`skill/` | 本機 Cursor 規則與開發輔助，不推送 GitHub |

## 從完整本機工作區同步

若你另有含 `node_modules`、`target` 的完整開發目錄，可在該目錄執行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync-to-gentleman-manager.ps1 -Source "C:\path\to\full-workspace"
```

（腳本會排除依賴與建置快取後覆寫 `Gentleman-Manager`。若在完整工作區內，亦可執行該目錄的 `scripts\sync-to-gentleman-manager.ps1`。）

## 授權

見 [LICENSE](./LICENSE)。
