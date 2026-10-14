# S5 結果包正式接線（隔離副本）

基準 `34f9624e5c823b852cc7ca1725b3d9b634d6f807`；只從 S5 固定 `603e82d729de00c314c845b67bae95519219dcc0` 原樣納入三個 `core/s5/` 檔案，不帶回其舊S4繼承檔。S4模式還原、時間／資源／工作圖守門不變。

## 有限對外介面

`core/s5-api.cjs` 的8個名字由 preload → main精確主框架／formal模式 → Service → task-worker → Packages 對應；無通用invoke、檔案路徑或授權注入API。前端參數上限16KiB，除list/selection外沿已驗純模組的嚴格schema。

| 名稱 | 參數 | 結果 |
|---|---|---|
| packageList | `{}` | 有限來源識別／標籤、已登記package識別與hash、重新驗證的已選項；清單條目本身標not-rechecked，不全掃檔案。 |
| packageInspect | `{sourceToken}` | 當前受信來源的完整性／結構與有限矩陣預覽；不登記。 |
| packageRegister | `{sourceToken,requestId}` | 重新驗證並持久登記，沿用不可覆舊與同request衝突拒絕。 |
| packageGet | `{packageId}` | 逐檔重新驗證已登記包，不盲用舊快照。 |
| packageSelect | `{packageId,packageHash,artifactId,expectedRevision}` | 重新驗證後原子保存選取；expectedRevision不符回reference_drift。 |
| packageSelection | `{}` | 冷重開可重驗還原；舊來源漂移回blocked並保留舊選取參照，package/artifact為null。 |
| packageImportPlan | `{packageId,packageHash,requestId}` | blocked計畫，缺accepted_import_executor／new_draft_authorization；沒有建立草稿。 |
| packageExportPlan | `{packageId,packageHash,artifactIds,requestId}` | blocked計畫，缺accepted_export_executor／authorized_destination；沒有複製或下載。 |

## 核心授權界線

只有主程序的 `new Service(isolatedRoot,{packageAuthority})` 可傳受信快照至 worker；**正常main尚未安裝正式來源供應器**，預設null，結果頁明示blocked／trusted_source_authority，不自動搜尋runs/results或相信匯入檔自述。需要未來受信下載／原生選檔／來源索引入口接上後才能在正常啟動選真正結果。本次合成注入只驗完整接線，不是正式授權來源。

packageAuthority為 `{roots:[{rootId,path}], sources:[{sourceToken,label,grant}]}`，roots最多8、sources最多128、整體最多512KiB，每項最多64KiB。grant嚴格沿純模組README的sourceRef/kind/complete/manifest，絕不從前端接收。根及檔案的現有safeRoot／O_NOFOLLOW／非正規檔／全檔hash檢查照用。來源授權快照於該worker生命週期固定；新授權版本須由受信核心重建控制器，舊包仍重核並拒絕漂移。

本輪沒有正式attestRun供應器，也沒有把前端status/jobIds或舊Store.detail的verified_actual_run複製為internal-run證據。synthetic保持synthetic-contract，其餘未證來源只外部結構或unverified；science unknown、session not-tested。前端不能提升來源等級。

## 選取、顯示與上限

索引與計畫只寫隔離根 `s5/packages/`；選取保存為有SHA-256信封的 `selected.json`，4096B上限，有限讀取／非符號連結、精確schema及版本驗證。與PackageIndex共用index.lock序列化，先驗目前完整包、核根與鎖身分，再以獨有暫存檔/fsync/rename/目錄fsync保存。讀取不改原選取／index內容與時間。競爭或壞狀態拒絕，不搶鎖、不刪他人鎖；前端錯誤清除舊顯示。

每包仍最多32產物、4MiB/檔、16MiB總量、1024×1024矩陣；索引最多128包、256請求、2MiB。每次IPC只回前200條邊、前100個各軸／基因名，保留完整shape／edgeCount與previewTruncated；原矩陣不截短、不寫回。欄來源→列目標，nboots未知，不補九欄、不猜標籤或真基因順序。這是有限既有資料衍生顯示，未生成衍生匯出檔、未執行推論。

正式清單／歷史頁新增結果包入口，開啟既有4:13結果頁容器；其他結果／匯入頁的設計成功內容不作真結果。顯示來源／完整性／science／session、expected及actual bytes/hash、方向、有限邊預覽、持久選取及阻擋計畫；返回分析清單可再開還原選取。樣式只加formal-s5範圍，操作按鈕至少40px，可在既有520px滾動面板命中。未接三頁官方Shiny。

## 重現與證據層級

- `node --test desktop/test-s5-integration.cjs`：對外介面合成測試，含真Service/worker及受控零外部作用守門。
- `node --test desktop/core/s5/test-package.cjs`：已核純模組17項；測試根環境變數請只指新自有目錄。
- 任務 `S5-integration-evidence/run-checks.py`：既有回歸＋S4模式5項＋S5純17項＋本輪13項，全部156項。舊S3/S4測試固定runtime精確導向本輪，不修改其程式或封存。
- 本人新userData／fixture-project的show=false Electron，scripted DOM與封閉IPC保存／選取／計畫、全新程序冷重開、改byte拒絕、review拒絕、按鈕幾何與返回再開另記。這些不證原生人類操作、真來源／站台／下載／科學。

Node路徑檢查不是OS openat能力服務，來源及狀態根仍須由宿主保護，避免同帳號惡意並行rename；狀態hash只防損壞，非身份驗證。跨檔崩潰：selected可能已原子寫入而index檢查稍後失敗；讀取必須仍重新驗包，不能據退出碼盲稱選取成功。沒有自動回收未知鎖或崩潰恢復。

本輪沒有原生選檔／實際匯入匯出／新S1草稿／遠端下載／正式run證明／真RData載入或session準備；全部計畫executeEnabled=false、actualFilesWritten=false、preserveOriginal=true、overwrite=false。後續獨立驗證及精進只接固定提交，不把交付憑證當驗收。
