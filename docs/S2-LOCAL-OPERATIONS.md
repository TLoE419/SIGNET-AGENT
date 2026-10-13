# S2 隔離操作契約

本分支只有本地監控工程；原 SIGNET 專案及使用者視窗唯讀，沒有校方／科學／模型／SSH 接線。本地 connected 與遠端 unknown 分開。缺驗證產物的成功記錄只投影 unknown，原科學狀態不改。

開發入口必須指定 SIGNET_REVIEW_USER_DATA，以及其 fixture-project 子目錄下的 SIGNET_REVIEW_PROJECT_ROOT。Service 在建 worker 前拒原根及本來源根。依賴唯讀重用；不跑 setup／下載。s2/runtime.json 的 owner/source 綁此副本，不能拿其他根的紀錄接管。

| 介面 | 有限输入／結果 |
|---|---|
| operationStart | requestId/analysisId/kind=monitor；先持久意圖，回 operationId；同請求去重、payload衝突拒絕 |
| operationStatus | operationId；回 analysis/attempt/owner/revision/checkedAt/error/evidenceRefs 與分離狀態投影 |
| operationCancel | operation/analysis/attempt/owner/revision/confirmed；只釋放本人本地監控，有停止證據才 cancelled |
| recoveryScan | limit 1–100；最多掃512個本地manifest，空成功與issues／truncated分開 |
| recoveryAttach | operation/analysis/attempt/owner/revision；核內容指紋及來源，只恢復監控，不提交／續跑 |
| logRead | operationId/logId/cursor/limit；只已知固定路徑，UTF-8、脫敏、輪替／完整性來源 |
| errorExplain | operationId或固定code；未知 unavailable，不模型猜測 |
| checkpointReview | analysis/attempt/kind=pca或retry；可用PC／失敗batch選擇與planHash確認，永不科學執行 |
| closeConfirm | review/keep-running/close-anyway/cancel-owned；只閉本人宿主、不暗取消獨立分析 |

所有 S2 參數最多16KiB，不收shell/path/泛用invoke。schemaVersion=2持久紀錄包括 operationId、requestId、analysisId、attemptId、owner、kind、status、revision、checkedAt、error、evidenceRefs、payloadHash、analysisHash。短意圖鎖不跨 await 長工作；未知殘留鎖拒接管。管理重啟先 unknown、按原request對帳，不能換新請求重提副作用。S2在worker長佇列外派送，start/status/cancel可獨立處理；S2 IPC 5秒期限，S1原期限保留。Store的舊科學方法仍保留，S2的main／Service／worker不開create/start/cancel等路徑。

取消的證據為實際本地監控handle釋放，含owner/attempt；不代表遠端job已停。Keep running/Close anyway即使控制器失聯仍可操作，Close anyway不暗取消。關窗只收本人Worker，不接固定VM transport。

controller/stage/scheduler只映射s2/logs本人操作名稱；worker只映射該analysis的worker.log。原raw唯讀，拒每層symlink及非一般檔，使用不跟隨連結的fd。单原快照≤2MiB，頁256–8192B、最多256頁；上限明記truncated/incomplete。cursor綁operation/log/內容hash/inode，變更或輪替回rotated，不串兩代。先對有界完整快照UTF-8解碼、遮Authorization/password/token/secret/api_key，再切頁，跨chunk/page不洩值；不掃無限歷史。

s2/checkpoints/<analysisId>.json必須有schema2、owner/analysis/attempt、來源planHash、checkedAt/expiresAt（≤1小時）及availablePCs/failed batches。缺證／過期／hash改變拒絕。NPC是整數1–5與可用PC交集；retry只選失敗batch。確認planHash綁完整checkpoint與選擇。合法合成確認點可展示confirmation，executeEnabled仍false；不造曲線或科學續行。

穩定control ID沿原75畫面，S2正規畫面清演示成功值/曲線，投影有來源的本地狀態。恢復列按operation ID，不靠Row1；真候選在dialog中，背景保持inert。舊revision、模式generation丟棄舊回覆；review不允S2副作用。

副本測試：在desktop執行 `npm test`（原31＋S2）或 `npm run test:s2`。test-support/s2-hidden.cjs是作者自有hidden Electron DOM／IPC整合，需本人userData/runtime及SIGNET_S2_TEST_OUTPUT；不是原生輸入、原App或科學驗收。

本分支未push/merge。S1未驗原生、正式整合、S3–S7／校方條件保留；整合前必須三方比較原根當時差異，另取得修改權。verify／polish按固定提交，改碼另複驗。

## 英文對照

- **IPC / worker / schema** — 有限程序通訊／背景執行緒／有限資料結構版本。
- **owner / revision / unknown / cancelled** — 擁有者／紀錄版本／欠證未知／本人監控已釋放。
- **cursor / raw / symlink / checkpoint** — 分頁位置／原日誌／符號連結／有來源的確認點。
