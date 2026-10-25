# 第三方來源與授權狀態

- `web/vendor/`：保留 markdown-it 與 vis-network 的授權檔；版本與修改見該目錄 README。
- `assets/tokenizers/`：Qwen 斷詞資料，Apache 2.0；固定版本與雜湊見該目錄 README。不含模型權重。
- 官方 SIGNET 科學來源：不隨此專案打包。`scripts/setup_source.py` 只從 `signet_inventory.json` 指定的提交安裝已盤點程式、設定模板與上游授權文件，不安裝範例或研究資料。各檔案須通過既有 SHA-256 檢查。
- `scripts/advanced/verify_network.cjs`：從既有 SIGNET 桌面專案的 `desktop/core/results.cjs` 移植輸出驗證邏輯。保留矩陣、工作完成清單、排程紀錄與重抽樣平均值核對；移除桌面匯出功能，改為單一檔案並只使用 Node.js 標準函式庫。
  原始驗證器 SHA-256：`ec6da24f2a94f09d89aa4cb147d28739bbd4ae26eff0633aa26a9a3b2acfb6e2`。

本專案自身的開源授權種類尚未由擁有者決定，因此沒有新增根目錄 LICENSE，也不把第三方授權宣稱為整個專案的授權。正式公開前須完成此決策，並確認移植驗證器的散布權利。

## 英文對照

- **README** — 來源與使用說明文件。
- **SHA-256** — 檢查檔案內容是否符合固定來源的雜湊。
- **Node.js** — 執行 JavaScript 驗證程式的環境。
- **LICENSE** — 說明使用與散布權利的授權文件。
