---
name: backup-before-edit
description: >-
  Backs up files before edits, rebuilds the Windows EXE/ZIP after code changes,
  and supports GitHub Release uploads for Gentleman Manager. Use when modifying
  src, src-tauri, build scripts, or config that affects the app.
---

# 修改前備份 · 修改後建置 EXE/ZIP

## 規則（必須遵守）

### A. 修改前：備份

**每次**對專案內檔案進行下列操作**之前**，必須先備份該檔案**修改前的完整內容**：

- `StrReplace` / `Write` / `EditNotebook` 等寫入
- 刪除檔案
- 重新命名或搬移檔案

僅讀取（`Read`、`Grep`、搜尋）不需備份。

新增檔案（原本不存在）無需備份舊版；若覆寫已存在檔案，仍須先備份。

### B. 修改後：重新建置 EXE/ZIP（每次改完必做）

**每次**完成一輪程式修改（會影響應用行為或介面）後，**必須**在專案根目錄執行快速建置，產出可執行檔與 ZIP。**不要**只改原始碼而不建置——使用者執行的是 EXE，不是 `src/` 原始碼。

```powershell
.\skill\scripts\rebuild-exe.ps1
```

- 等同 `pnpm tauri:build:fast`（Release-fast、不打包 NSIS）
- Cargo 原始 EXE：`src-tauri\target\release-fast\Gentleman-Manager.exe`
- 根目錄 EXE：`Gentleman-Manager-v1.2.exe`
- 根目錄 ZIP：`Gentleman-Manager-v1.2.zip`
- 建置失敗時**不得**視為任務完成；先修錯誤再建置，或回報使用者

僅改 `skill/backups/`、純文件且未動到 `src/` / `src-tauri/` 時可略過建置；其餘修改（含 UI、Rust、設定）**都要**建置。

### C. 修改範圍（僅做使用者明確要求的事）

- **只實作**使用者在當前請求中明確描述的功能或修改，**不要**擅自擴大範圍。
- **禁止**未經要求就合併欄位、重命名、重構、順手優化、改文案、改主題、改依賴或調整無關檔案。
- 若認為有更好做法，先說明並等使用者確認，再動手。
- 使用者若只要求改某一處，就只改那一處及為編譯／運行所必需的最少連動。

## 分類掃描參數（`wnacg_client.rs`）

`collect_scoped_matches_parallel` 內常數，調整後**必須**執行 `rebuild-exe.ps1`：

| 常數 | 用途 | 目前值 |
|------|------|--------|
| `CONCURRENCY` | 每批並行請求數 | 50 |
| `BATCH_DELAY` | 每批之間間隔（毫秒） | 10000 |
| `RETRY_SECS` | 限流後重試等待（秒） | 20 |

```powershell
.\skill\scripts\rebuild-exe.ps1
# 產出：Gentleman-Manager-v1.2.exe + Gentleman-Manager-v1.2.zip（專案根目錄）
```

## 備份位置

```
skill/backups/<專案相對路徑>
```

`skill/backups/` 已列入 `.gitignore`，勿提交到 Git。

## 完整工作流程

```
1. backup-before-edit.ps1  （每個將被改動的檔案）
2. 進行程式修改
3. rebuild-exe.ps1         （本輪修改全部完成後）
4. 確認終端顯示 OK EXE / OK ZIP 路徑
5. 若需要發佈，建立 commit、push，並將 ZIP 上傳到 GitHub Releases
```

### 1. 修改前：備份

```powershell
.\skill\scripts\backup-before-edit.ps1 -Path "src/App.tsx"
```

一次改多檔時，**每個檔案各備份一次**。

### 2. 再進行程式修改

備份成功（exit 0）後才寫入。

### 3. 修改後：建置 EXE

```powershell
.\skill\scripts\rebuild-exe.ps1
```

首次或依賴變更後可能需數分鐘；增量建置通常較快。

### 4. 改壞時：還原上一動

```powershell
.\skill\scripts\restore-from-backup.ps1 -Path "src/App.tsx"
```

還原後若需驗證執行檔，再執行一次 `rebuild-exe.ps1`。

## 檢查清單

```
- [ ] 已列出本次會改動的所有檔案
- [ ] 每個檔案都已執行 backup-before-edit.ps1
- [ ] 備份成功後才寫入
- [ ] 修改完成後已執行 rebuild-exe.ps1
- [ ] 建置成功且 `Gentleman-Manager-v1.2.exe`、`Gentleman-Manager-v1.2.zip` 路徑已確認
- [ ] 若使用者要求 Release，已 push 最新 commit 並上傳 `Gentleman-Manager-v1.2.zip`
- [ ] 若使用者要求還原，使用 restore-from-backup.ps1
- [ ] 本次修改未超出使用者明確要求的範圍
```

## 圖標替換流程（EXE 內嵌圖示）

更換 EXE 圖標時，**Cargo 增量快取不會自動重新嵌入圖示**，必須嚴格按以下流程執行：

### 1. 準備圖示來源
將新圖示放在專案根目錄命名為 `logo.ico`，`rebuild-exe.ps1` 會自動讀取。

- 若 `logo.ico` 存在：轉為 `icon-extracted.png`（保留透明背景）再交給 Tauri 產生各尺寸
- 若不存在：從現有 EXE 抽取（舊行為）

### 2. 驗證 EXE 內嵌圖示（建置後）
```python
# 用以下 Python 片段確認各尺寸 max_rgb 不全是 0（全黑表示嵌入失敗）
import io, struct, pefile
from PIL import Image, ImageStat
exe = pefile.PE("src-tauri/target/release-fast/Gentleman-Manager.exe")
# 讀取 RT_ICON (id=3) 資源並用 PIL 解析 avg/max_rgb
```

### 3. 若 EXE 仍是舊圖示（Cargo 快取問題）
`rebuild-exe.ps1` 已內建自動清除機制（`>> clear app fingerprints`），
若仍有問題可手動執行：
```powershell
$fp = "src-tauri\target\release-fast\.fingerprint"
Get-ChildItem $fp -Directory -Filter "wnacg*" | Remove-Item -Recurse -Force
Get-ChildItem $fp -Directory -Filter "Gentleman*" | Remove-Item -Recurse -Force
Get-ChildItem $fp -Directory -Filter "gentleman*" | Remove-Item -Recurse -Force
Get-ChildItem "src-tauri\target\release-fast\build" -Directory -Filter "wnacg*" | Remove-Item -Recurse -Force
Get-ChildItem "src-tauri\target\release-fast\build" -Directory -Filter "Gentleman*" | Remove-Item -Recurse -Force
Get-ChildItem "src-tauri\target\release-fast\build" -Directory -Filter "gentleman*" | Remove-Item -Recurse -Force
```
再重新執行 `rebuild-exe.ps1`。

### 根本原因記錄
Cargo 以 fingerprint 判斷是否重新連結；`tauri-build` 未把 `icons/icon.ico`
列入 `cargo:rerun-if-changed`，導致更換圖示後增量建置不重新嵌入資源。
腳本透過每次刪除應用程式 fingerprint 強制重連結繞過此問題。

## 注意事項

- 每個檔案只保留**一層**備份（最新一次「修改前」快照）。
- 不要手動編輯 `skill/backups/` 內容。
- 備份或建置失敗時，先排除錯誤再繼續；勿跳過步驟。
- Windows 建置若 Vite 報 `protocol 'c:'`，腳本已優先使用 `C:\Program Files\nodejs`；仍失敗則檢查 `pnpm install` 與 UnoCSS 版本。

## GitHub Release 發佈流程

使用者要求打包並上傳 GitHub Releases 時：

```powershell
.\skill\scripts\rebuild-exe.ps1
git status --short --branch
git add -A
git commit -m "簡短描述"
git push
gh release create v<版本號> .\Gentleman-Manager-v<版本號>.zip --repo JACKYLI6207/Gentleman-Manager --title "Gentleman Manager v<版本號>" --notes "發佈說明"
```

若 Release 已存在，改用：

```powershell
gh release upload v<版本號> .\Gentleman-Manager-v<版本號>.zip --repo JACKYLI6207/Gentleman-Manager --clobber
```

- ZIP 應只包含同版本 `Gentleman-Manager-v<版本號>.exe`。
- `*.exe`、`*.zip` 是本機產物，維持在 `.gitignore`，不要提交到 Git。

## 範例

```powershell
cd C:\Users\Jacky-PC-New\Desktop\Gentleman-Manager
.\skill\scripts\backup-before-edit.ps1 -Path "src/App.tsx"
# …編輯 App.tsx…
.\skill\scripts\rebuild-exe.ps1
```
