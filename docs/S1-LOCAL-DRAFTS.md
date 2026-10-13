# S1 本機接線契約

本機管理與草稿工程；沒有開始科學工作、SSH、傳輸或校方提交。正式模式使用本機紀錄；審阅選單或 Help 切到獨立設計演示，副作用橋接由主程序拒絕。Workspace → Local records 返回本機模式並保留未保存編輯。後續 S2–S7 操作在主程序與正式畫面雙重禁用。

## 入口與邊界

Electron 啟動先 `Service.connect()`；`preload → main → Service → Store` 沿用受限 IPC。僅主視窗主框架、精確 `signet://app/index.html` 可呼叫。沒有任意命令、HTTP 控制服務、前端文件路徑或 R 輸入。

新增 `desktop.capabilities()`、`draftList()`、`draftSave(payload)`、`draftLoad(id)`、`inputValidate(id, revision)`、`mode('formal'|'review')`。`pick(key,cohort,workflow)` 與既有方法回 `{ok:true,value}` 或 `{ok:false,error}`。S1 中 list/detail 改為唯讀版本；不執行 recover，不改歷史原件。舊 Store.list/recover 運算控制契約保留給原 CLI；正式清單使用 recordList，選中才 recordDetail。

## 草稿

payload 限 id（新增省略）、revision（新增0）、label（1–80字）、notes（至2000字）、workflow、cohort、entryStage、finishAfter、species、assembly、inputs、parameters。未知欄位拒絕。保存使用獨占鎖、原子写入及 CAS；revision +1。錯誤不覆寫新版本。`analyses/drafts/d-<uuid>.json` 持久化 schemaVersion=1、內容 SHA256、建立/修改時間及主程序授權來源參照；不產生 runs、分析ID或科學工作。

每項 inputs 只接受 `{token}` 或 `{ref}`。token 由原生 picker 建立，15分鐘期限、至128項、绑定 field/cohort/workflow；取消不換原值。ref 只能引用同一草稿、同一 workflow/cohort 的既有欄位。主程序把有效 token 轉為來源；renderer 永遠不能提供 path/source。持久紀錄內的原路徑不回前端，回應是 `{draft,contentHash,inputManifest,issues,validation}`，manifest 限檔名、字節、hash、可用性。來源不複製、不刪除；重開及驗證重新讀取所選來源。變動或缺失撤销 validation，顯示 missing-input。跨實例锁忙/过期需重開核對，不能自動覆蓋鎖或盲目重送。

discard 只放棄當次未保存編輯，已保存草稿與來源不刪。選檔後請點所需資料列，再按 Choose local file；Validate inputs 先保存已改內容，再驗證保存 revision。來源全部不超256MiB；單檔64MiB、目錄128項、文字250000行、一般矩陣2000000儲存格。超限明確拒絕；哈希在背景管理執行緒以既有分塊讀取計算。清單只讀每筆≤1MiB metadata，不對無限歷史計算全部科學產物。

## 工作流程／輸入

| 工作流程 | 入口／finishAfter | S1能力 |
| --- | --- | --- |
| network | network／network | 五項官方建網資料＋兩份样本ID與GTF補充依據，结构验证與審核 |
| preprocessing | genotype／expression | TCGA／GTEx原始七欄位選檔、保存、文字格式與身分初查；參考版本／樣本映射未證實會阻擋 |
| cis | ciseqtl／ciseqtl | 草稿可保存；缺少可驗調整產物 checkpoint，禁止跳段／審核 |
| import | visualization／visualization | 草稿可保存；官方session匯入属于S5，未就緒 |

network 五項格式與官方 results/stages 相同：無標頭、空白分隔的樣本×基因 expression、樣本×工具變數 genotype、1-based基因索引/工具變數索引/p-value 三欄 pairs、一行一個基因名、基因名/染色體/起/迄四欄 positions。**五項本身無樣本身分，不能只用相同維度放行**。新增 expressionSamples/genotypeSamples（一行一個ID）必須相同身分與順序、無重複並符合矩陣行數；不自動重排。GTF九欄gene條目具gene_id/gene_name、座標對應 positions，無重複；需要明示的 `#!genome-build <assembly>` 或 `#assembly <assembly>` 與 `#!species <taxonomy id>`。未知版本／別名不默認等同。

可選 species/assembly **只來自已存在 official-signet/config.ini 的 [netvis] id/assembly**，新草稿為空值。當下來源是9606/hg38；這只是官方配置映射，不代表所選資料已符合。GTF声明與座標/hash證據只建立結構一致性，沒有生物品質、參考來源可信度或統計穩健性認證。一般 GTF 未提供可核 taxonomy/build 需補來源依據或後續有限 adapter；此版不能悄悄把 GRCh38 字串當 hg38。

raw TCGA 沿 FILES 七欄位：PED/MAP、chrN.gen/chrN.map目錄、表達矩陣、GTF、clinical。讀PED身分及欄位、MAP標記、數值、表達標頭/官方末五行規則與順序、clinical submitter_id；不證成隐含的TCGA病人／樣本截斷與參考版本。GTEx只初查未壓縮VCF v4、GCT 1.2 reads/TPM、SAMPID/SMTSD annotation、GTF、phenotype；不同樣本順序阻擋。官方 sample↔subject/tissue 映射與 phased/reference provenance 尚無可核checkpoint，因此即使初查齊全仍 blocked。壓縮／其他格式明確 unsupported；不把合成資料當代表資料相容證據。

parameters 沿 core schema；nboots/ncis/cor/alpha.cis/freq/ntop 可在正式畫面编辑，非有限／布林／null／越界拒絕。PCA介面尚未接實際checkpoint，因此 availablePCs/pcaMaximum=null、無可提交的PC確認；保存npc仍限1–5，但不能把默认3或核心1–10当作實際可用PC。後續確認必取1–5與實際可用數交集。

## 驗證報告／畫面

inputValidate 返回 validationId、revision、contentHash、workflow、formatVersion=signet-input-v1、checkedAt、status(validated/blocked)、issues[{field,code,message}]、inputManifest、capabilities。前後兩次來源hash檢查避免讀取中替換。報告綁內容/版本，不修改草稿revision；來源變動或保存新revision使舊報告失效。reviewReady 僅表示结构證據可審；computeReady 永遠 false。

控制用 formal-bindings.js 中固定 nodeId→動作映射；動態列用 recordId／inputKey，不能靠 Row 1 或同名按鈕決定資料身分。renderer 只負責通用原生樹及隔離演示，formal.js 管理實際模式；篩選/搜尋沒有演示定時器。資料驗證錯誤回4:4、網路參數錯誤回4:53；保存對話框4:71保持背景 inert；歷史原件缺失回4:23。後續執行／結果動作禁用，有明確未就緒状态。

## 隔離驗證入口

一般測試 `cd desktop && npm test`，原17項保留，test-s1.cjs驗真需求。不要執行 test:scientific。原生驗收者需本人合成資料与新獨立 SIGNET_REVIEW_USER_DATA；需要 fixture root 時，仅开发版允许 SIGNET_REVIEW_PROJECT_ROOT 在該 userData/fixture-project/ 的真實子目錄，不能指任意外部根。該開發隔離選項不暴露 renderer，不改正式 Store 根。

本次交付证据另存任务指定 S1-build-evidence。原生工具操作、直接設定测试夹具、DOM合成事件与 Node 测试分开；一次原生成功不代表全部資料／科學／校方流程通過。獨立 polish/verify 尚待。
