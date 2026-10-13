# 桌面程式開發

從專案根目錄執行 `bash tools/setup-dev.sh`，或依 [完整安裝文件](../docs/INSTALL.md) 手動安裝。依賴固定在 `package-lock.json`，不要提交 `node_modules/`。

```sh
cd desktop
npm test
npm start
npm run package:mac
```

`npm test` 使用 `test-support/fixtures.cjs` 生成的小型合成資料，不讀取官方副本或個人分析結果。`npm run test:scientific` 是另行準備真實參考資料後才執行的逐邊比對。

`main.cjs` 管理桌面生命週期、受限操作與原生對話框；`preload.cjs` 暴露有限方法；`renderer.js` 目前顯示下列設計演示；既有正式運算橋接保留，尚未接入新介面。

`service.cjs` 與 `core/task-worker.cjs` 管理背景執行緒；`core/store.cjs` 管理狀態與隔離副本；`core/analysis-worker.cjs` 是關窗後仍執行的獨立程序。`core/stages.cjs`、`results.cjs` 定義與驗證產物；`transport.cjs` 仍是固定本機連線。模組介面見 [介面文件](../docs/INTERFACES.md)。

結果主流程使用官方第六階段與 R Shiny。`core/viewer.html` 保留供維護工具和既有結果讀取使用，不是新的官方視覺化主流程。

打包目前只針對 Apple Silicon macOS，未簽署或公證。開啟桌面不啟動科學計算；關閉桌面會清理它擁有的視覺化服務，已啟動分析需使用取消操作終止。

## 設計演示 v0.4

此版本以已核對的 Figma 高保真資料實作75個畫面：73介面／狀態與2個審閱導讀。使用原生HTML/CSS/JavaScript、本地Inter字體及69份原始向量，不新增應用框架。

正常啟動顯示 Analyses；應用程式選單 Review → Design review routes，或按 Command+Shift+R，開啟審閱導讀。Browse all screens 可進入完整狀態索引。導讀提供建網、重試、重連／恢復、匯入及預處理／主成分確認五條情境；工作流程選項另可進入 cis-eQTL。

全部狀態均為 Demo data。上傳、下載、提交、重試、恢復、停止、設定與圖形只是本地設計演示，不讀取使用者檔案、不呼叫正式橋接，也不啟動科學運算或R Shiny。表單編輯只保存於當次程序，演示草稿不寫入磁碟。J畫面保留Shiny宿主概念，使用設計提供的示意圖。

獨立檢視可使用不同資料目錄，避免與既有SIGNET共用單一實例鎖：

```sh
SIGNET_REVIEW_USER_DATA=/tmp/signet-design-review-user npm start
```

`SIGNET_REVIEW_USER_DATA` 必須為完整絕對路徑。自動桌面測試另用 `SIGNET_REVIEW_HIDDEN=1` 隱藏自己的隔離視窗；此選項不影響普通啟動。主比较尺寸1440×960，另支援1280×800及內容捲動，不整頁縮放。

`design-pages.js` 保存逐畫面原生結構；`design-layout.css` 保存設計布局；`design-routes.js` 負責本地導覽；`design-assets.json` 保存868個向量使用槽位與原檔雜湊；`design-static.cjs` 僅允許固定本地資源。字體授權位於 assets/fonts/OFL.txt。`npm test` 包含原有13項合成測試與4項前端邊界回歸測試。

本階段尚待獨立逐頁驗收與後續正式功能整合；設計中的Python環境字樣依原稿保留，並不代表目前Node服務改為Python。

## 英文對照

- **R Shiny** — 官方互動式結果介面框架。
