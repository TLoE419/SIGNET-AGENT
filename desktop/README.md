# 桌面程式開發

從專案根目錄執行 `bash tools/setup-dev.sh`，或依 [完整安裝文件](../docs/INSTALL.md) 手動安裝。依賴固定在 `package-lock.json`，不要提交 `node_modules/`。

```sh
cd desktop
npm test
npm start
npm run package:mac
```

`npm test` 使用 `test-support/fixtures.cjs` 生成的小型合成資料，不讀取官方副本或個人分析結果。`npm run test:scientific` 是另行準備真實參考資料後才執行的逐邊比對。

`main.cjs` 管理桌面生命週期、受限操作與原生對話框；`preload.cjs` 暴露有限方法；`renderer.js` 顯示表單、分析列表、進度與官方視覺化。

`service.cjs` 與 `core/task-worker.cjs` 管理背景執行緒；`core/store.cjs` 管理狀態與隔離副本；`core/analysis-worker.cjs` 是關窗後仍執行的獨立程序。`core/stages.cjs`、`results.cjs` 定義與驗證產物；`transport.cjs` 仍是固定本機連線。模組介面見 [介面文件](../docs/INTERFACES.md)。

結果主流程使用官方第六階段與 R Shiny。`core/viewer.html` 保留供維護工具和既有結果讀取使用，不是新的官方視覺化主流程。

打包目前只針對 Apple Silicon macOS，未簽署或公證。開啟桌面不啟動科學計算；關閉桌面會清理它擁有的視覺化服務，已啟動分析需使用取消操作終止。

## 英文對照

- **R Shiny** — 官方互動式結果介面框架。
