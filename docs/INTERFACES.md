# 目前模組與介面

這份文件記錄目前實作，供組員分工。不是已完成的可替換 HPC 契約；檔案傳輸、耐斷線的工作紀錄與多環境連線仍待開發。

## 桌面與主程序

`preload.cjs` 的 `window.desktop` 暴露：

- `status()`、`reconnect()`、`schema()`。
- `pick(key, cohort)` → 選檔識別 token 與名稱；主程序保存真實路徑。
- `create(params)`、`list()`、`detail(id)`、`logs(id)`。
- `start(id, stage)`、`cancel(id)`。
- `save(id, name)`、`reveal(id)`。
- `visualization(id)`、`closeVisualization()`。

回應為 `{ok:true,value}` 或 `{ok:false,error}`。匯入由主程序把選檔 token 換成路徑；前端不能傳任意 shell 指令。完整階段與參數由 `schema()` 提供。

## 管理執行緒

`Service.call(method, ...args)` 發送 `{id,method,args}`，收到 `{id,ok,value}` 或 `{id,ok:false,error}`。背景管理操作排隊執行。`task-worker.cjs` 呼叫 `Store`；分析啟動則交給獨立 `analysis-worker.cjs`。

`Store` 管理建立副本、輸入校驗、階段先決條件、執行鎖、狀態、產物授權與取消。它讀取下載的官方程式，以及 `evidence/input-validation.json`、`provenance.json`。

## 階段與結果

`stages.cjs`：`schema()`、`parameters(value)`、`outputs(run,stage,cohort,params)`、`verifyStage(run,stage,cohort,params,started)`。

六階段依序為 genotype、expression、adjustment、ciseqtl、network、visualization。官方網路模擬跳過前四階段；官方 cis-eQTL 模擬跳過前三階段。TCGA 表達量前處理可先於基因型執行。

`results.cjs`：`inputs(folder)`、`network(folder)`、`verify(run,nboots)`、`render(run,output,template)`。驗證包含矩陣尺寸、方向、有限數值、重抽樣平均、命令完成清單、排程工作完成狀態。不能以指令退出碼零當作科學成功。

## 運算連線

`transport.cjs` 現有函式：

```js
ssh(root)
preflight(root, analysisId)
launch(root, analysisId, stage, checksum, log)
snapshot(root, analysisId)
cancelRemote(root, analysisId)
```

主機、使用者、連接埠、金鑰與 `/work` 都固定為既有 VM。`launch()` 回傳 SSH 子程序，並非耐斷線的排程工作紀錄。切換到 HPC 時還需修改資料準備、取回結果、排程查詢、資源設定與取消；只改連線網址不足以完成。

## 官方視覺化

`Visualization.open(id)` → `{url}`；`stop()` 清理本次擁有的遠端服務與隧道。開啟前需核對 `verified-visualization.json` 中的產物校驗碼。官方第六階段先準備 `official-session.RData`，再由 `serve-visualization.R` 啟動官方 Shiny。

## 持久化

- `analyses/<id>/`：狀態、來源、校驗、設定、排程與驗證紀錄。
- `runs/<id>/`：官方程式隔離副本、輸入、中間矩陣、結果及日誌。
- `results/<id>/`：部分既有維護工具產生的結果檔。

這些目錄全被 Git 排除，開發測試的合成資料則在暫存目錄生成。

## 英文對照

- **HPC / VM / SSH** — 高效能運算、虛擬機與安全遠端連線。
- **token / shell / schema** — 選檔識別碼、命令環境與輸入階段結構。
- **TCGA / cis-eQTL / Shiny** — 官方資料流程、附近變異與表達量關聯分析、互動式視覺化框架。
- **genotype / expression / adjustment / network / visualization** — 基因型、表達量、共變量調整、網路建構、視覺化階段。
