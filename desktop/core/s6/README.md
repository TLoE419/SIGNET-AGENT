# S6 宿主純模組（隔離工程）

本模組只協調可信工作階段提供者與自有服務租約，沒有預設檔案、R、網路、SSH、Slurm、視窗或程序啟停實作。不能直接交給 renderer 注入提供者。`new Host()` 的 open 回傳 blocked / PROVIDER_UNAVAILABLE，證據 unknown。合成測試成功只證明生命週期，不證明官方三頁或科學結果。

## 有限介面

- `new Host({ports, timeoutMs=15000, cleanupTimeoutMs=3000})`。啟動總期限5–30000ms，清理期限5–10000ms；單一實例最多保存128個不可變修訂綁定，不淘汰舊綁定以容許覆寫。
- `open({analysisId, visualizationRevision}) -> Promise<status>`。僅兩個識別字，拒絕額外URL、port、檔案路徑、命令。同一次啟動的重複 open 共用同一 Promise；其他分析／修訂要先 close。已就緒時再 open 會重新查驗來源及服務證據，不盲用舊URL。
- `status()` 回傳副本：`{state,url,origin,ownerId,revision,error,evidence}`。state 為 stopped / starting / ready / error / blocked；只有 ready 才含 URL，evidence 為 service-only，其餘 unknown。這不是三頁可用性證據。
- `canNavigate(url)` 只在 ready 時放行精確 `http://127.0.0.1:<owned-port>/...`。檢查解析後 origin、協定、主機、埠及帳密，也拒絕別名、正規化偽裝、控制字元及反斜線。整合層須在每次導航、重新導向、彈窗皆套用。這個判斷不負責攔截同來源服務自己發起的請求。
- `browserURL()` 只取目前保存的 ready URL，沒有任意開啟網址／瀏覽器副作用。
- `close()` 立即撤銷URL、取消等待，只清本次租約；停止失敗或超時保持 blocked / CLEANUP_FAILED，必須明確再 close 重試，禁止重開掩蓋未清理狀態。方法非永久 dispose，可成功清理後重新 open。

## 僅由可信主程序注入的 ports

1. `resolve(request,{signal})`：從受信索引取回工作階段描述。識別字皆為1–96字 ASCII 字母、數字、底線或減號；hash為小寫64位SHA-256：
   ```js
   {analysisId, visualizationRevision, sessionRef, manifestRef,
    sessionHash, manifestHash, officialHash, containerHash,
    parameters:{freq,ntop}, networkHashes:{frequency,coefficient,positions}}
   ```
   freq 0..1，ntop整數1..100。真實子網路數量限制仍由可信 prepare／載入檢查負責。參照是索引中的不透明識別字，不是路徑。
2. `verify(binding,{signal})`：必須對**同一份**不可變 session／manifest／三科學檔與官方／容器來源做實際核對，返回 `{binding,generated:true,loadState:'loaded',sessionHash}`。`generated` 是可信官方生成鏈證據；`loaded` 是已有授權載入探測證據，不是副檔名、非空或前端旗標。failed 回 SESSION_LOAD_FAILED，未測試／未知回 SESSION_UNVERIFIED。本模組不讀取或載入 RData；合成提供者只供測試，不可用於正式接線。
3. `start({ownerId,token,session,signal,onExit})`：**同步**取得本次自有租約，回 `{ownerId,token,birthId,port,ready,stop}`。先建立可清理租約，再由 ready 啟動／等待非同步資源；不得先產生副作用而後丟例外，也不得返回 Promise。埠由受信端決定，1024..65535。埠佔用／缺R可以在無副作用的取得階段丟固定 code PORT_OCCUPIED / R_UNAVAILABLE。
   - `ready({signal})` 每次都重新證明本次owner/token/birthId/port、**本次新日誌** Listening及HTTP token，回 `{ownerId,token,birthId,port,listening:true,httpOk:true,url}`。signal取消後禁止新增資源；需要確保檔案在驗證至載入期間仍是同一份／不可變或再驗hash，不能拿路徑當能力憑證。
   - `stop({ownerId,token,birthId})` 必須冪等，核對實際PID出生時間與命令token後只停本次服務／隧道，成功才resolve，失敗必須reject。超時不證明底層停止，後續重試可能與原清理操作重疊，因此不能靠PID或port單獨殺程序。錯誤不提供外部PID清理通道。
   - `onExit()` 在任何服務退出立即呼叫，宿主即撤銷URL並清理。舊owner的晚到退出／ready不能影響新owner。

租約身分不符合時隔離為 OWNERSHIP_MISMATCH；不呼叫疑似外人的stop，也不准再開。這表示可信提供者契約失效、清理狀態未知，不能宣稱已清。正式提供者必須保證租約契約；本階段沒有實作其程序控制。

修訂與參數／來源綁定於實例生命週期內不變；同分析不同修訂不可重用同一 sessionRef 或 manifestRef。新參數要新修訂、新session／manifest參照。本模組沒有寫入科學檔的能力。跨程序持久綁定、排他鎖及重新啟動後恢復，須由日後可信S5索引／宿主提供者實現；單一正式宿主只建立一個協調器，禁止前端自行建立多個提供者。這些尚未接線。

## 官方三頁映射（只核來源，未實作頁內橋接）

官方固定來源 bed55b3e121de0edf5fd43da683dc59850ff82d3 的 `script/netvis/ui.R`／`server.R`：

| 頁／控制 | 已核語義 |
|---|---|
| net_summary | 摘要；無啟用的頻率滑桿。sidebarMenu沒有id，tabName不是inputId。 |
| enrichment / net_num1 | 整數子網路1..min(100,ntop)。 |
| enrichment / file1 | Shiny原生txt上傳描述，不能接任意宿主路徑；只更新節點色，不重跑推論或富集。 |
| enrichment / action1 | 單次清除染色事件，還原TF／non-TF群組，不刪來源檔。 |
| enrichment / radio1 | enrichment / modularity，預設modularity，只改分群顯示依據。 |
| circ / net_num2 | 同上整數範圍；官方server產生環狀圖及表格。 |

HTTP與owner token不代表上述輸出可用；真頁面、清單上傳／清除與科學核對均待正式可信依賴及獨立驗證。不得用合成空物件冒充R工作階段。

## 測試及整合界線

`node --test desktop/core/s6/test-host.cjs` 僅用記憶體替身。新目錄外的 main/preload/store/S1–S5完全未改，沒有正式功能註冊、S5整合、R載入、GUI、網路、SSH、Slurm或科學執行。完整回歸另在任務證據內保留命令、結果與既有測試暫存導向；不是修改共享模組。
