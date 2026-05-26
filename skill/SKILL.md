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

## Gentleman Manager v1.2 階段性功能梳理

### A. 搜尋與分頁

- 漫畫搜尋支援關鍵字、漫畫 ID/連結、標籤與標籤連結。
- 搜尋範圍是獨立輸入狀態，載入收藏分頁、收藏快照或關閉最後搜尋分頁時不得覆蓋目前搜尋範圍。
- 搜尋結果分頁可收藏，收藏分頁還原時應保留離線列表，避免無必要重新掃描。
- 分類搜尋方式視窗支援 `分類掃描，較慢` 與 `快照掃描，迅速`；按 Enter 等同點擊目前的 `掃描`/`搜索` 按鈕。
- 若收藏快照內有同分類快照，分類關鍵詞搜尋預設選用最新同分類快照做本次離線搜尋；這只作用於該次新搜尋分頁，不改任何全域快照狀態。
- 標籤詞不能使用列表快照，仍需分類標籤掃描，因更新列表頁不含完整標籤資訊。

### B. 快照掃描與輸出

- `全站快照` 下拉目前只保留 `快照掃描` 與 `接續掃描`；`載入快照` 與 `清除快照` 已移除。
- 快照載入改由收藏快照分頁管理；載入快照只開快照分頁，不再設定全域 `activeGlobalSnapshotId`。
- `快照掃描` 可一次勾選多個分類；每個分類獨立掃描、獨立保存快照。
- 完整分類快照完成 100% 後會自動排序校準，最終檔輸出到 EXE 同層 `Website Snapshot`。
- 寫入同分類新快照前，`Website Snapshot` 內舊的同分類 `.gm-snapshot.json` 會自動移到 `Website Snapshot/old`；若 old 內同名，會加序號避免覆蓋。
- 若更新掃描沒有任何新 ID，只提示「已是最新，無須更新」，不移動舊檔、不產生新檔。

### C. 接續掃描與更新掃描

- 未滿 100% 的快照可選：
  - `頁碼接續`：從斷點與待補掃頁繼續，適合剛中斷後馬上接續。
  - `ID 更新式接續`：從第 1 頁往後掃，適合隔一段時間後避免頁碼位移。
- 100% 快照一律走 ID 更新式掃描。
- ID 更新式掃描以舊快照 ID 集合為基準，從網站第 1 頁開始逐本比對；累計超過 20 個既有 ID 後停止。
- 新 ID 只追加到快照資料，再重新排序校準輸出最終檔。
- 頁碼接續仍依 `scanCompletedPageRanges` 與待補掃頁運作，只應用於短時間中斷後恢復。

### D. 掃描穩定性與防誤判

- 掃描完成度以 `scanCompletedPageRanges` 優先計算；未完整掃完時最高顯示 99%，避免誤判 100%。
- 非 Cloudflare 失敗頁會加入待補掃，不直接跳過。
- 待補掃會持續重試直到成功或使用者取消。
- 連續非 Cloudflare 失敗超過 3 次會緩衝 20 秒後繼續。
- Cloudflare 判斷採嚴格條件，不把一般空頁、空號、403 類錯誤無腦歸為 Cloudflare。
- 保守掃描使用模擬手動的隨機並行/交叉策略；激進掃描維持手動發送批次、隨機並行。

### E. 快照校準與修復

- 校準快照 UI 入口目前隱藏，但功能仍保留於程式內部。
- 排序校準會以 ID 排序重構快照，最終輸出採 ID 降序。
- 缺號修復支援不自然缺號區段排除、保守/激進修復搜尋、Cloudflare 休息後重試、結果 log 與合併輸出。
- 修復搜尋的保守模式是單本查詢、100ms~500ms 隨機間隔；激進模式用批次並行並搭配 VPN 使用。

### F. 發佈注意事項

- 目前產品名稱與發佈產物為 `Gentleman-Manager-v1.2`。
- 快速建置後根目錄應產出 `Gentleman-Manager-v1.2.exe` 與 `Gentleman-Manager-v1.2.zip`。
- `Website Snapshot/`、`repair/`、`*.exe`、`*.zip`、`skill/backups/` 都屬本機產物或備份，不應提交。
- 發佈 Release 時上傳 `Gentleman-Manager-v1.2.zip`。

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

- 若 Release 已存在，改用：

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
