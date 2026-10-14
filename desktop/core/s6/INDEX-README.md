# V6 持久索引與單擁有者接頭（隔離純模組）

從固定 `45e81509971e58bcecd76d912e0b4ec88282563c` 新clone，只新增本目錄檔案。既有Host／測試／README三檔及所有繼承來源未修改。沒有main/service/preload/formal或S1–S5橋接，不是S6正式整合；不可整棵舊S6副本覆蓋後來接受的S4/S5。

## 索引介面與信任

`new Registry({root,resolveSource?,sourceTimeoutMs=1000,beforePublish?})`。root只允許新自有metadata根，不得是原SIGNET或S<n>來源副本。受信來源／runtime分離：模組完全不讀source/session文件，resolveSource由核心注入，只返回已批准來源的有界描述；它必須實核包與來源hash／授權，不得把前端宣告當證據。沒有供應器時拒絕SOURCE_UNAUTHORIZED。

- `register({sourceToken,requestId})`：前端式請求只含兩識別，不收path／grant／數字修訂；A5正整數修訂由可信來源描述取得。回核心生成、持久保存的 `va-...` analysisId及`vr-...` visualizationRevision，絕不直接混用數字1與字串"1"。
- `get({analysisId,visualizationRevision})`：只查精確已登記映射，重新核源；回state unknown、URL null，即使紀錄loadState是loaded也不證服務就緒。
- `list()`：最多128條有界摘要、integrity not-rechecked；不掃原run、臨時檔或歷史。
- `recoveryState()`：只讀已發布索引／已知鎖位置，回unknown或blocked/incomplete、URL null。損壞、半寫或未知鎖不自動重設索引；可核舊已發布版本仍在，不藉此重授權或沿用ready。

核心resolveSource返回完整固定schema：

```js
{subjectRef, sourceRef:{sourceId,batchId,revision}, packageHash,
 a5Revision, parameters:{freq,ntop},
 networkHashes:{frequency,coefficient,positions},
 sessionRef,sessionHash,manifestRef,manifestHash,officialHash,containerHash,
 evidence:{generationRef,loadRef,verificationRef,loadState}, scientificStatus}
```

subjectRef由可信核心映射至import draft／來源主體，不讓外部包偽造內部科學analysis。sourceRef.revision與a5Revision均正安全整數；freq=0..1、ntop整數1..100；所有hash為小寫64位SHA-256，opaque參照1..96字有限ASCII。sourceId/batchId及sourceToken/requestId兼容A5的1..80字元識別，僅作鍵、不作路徑。

同subjectRef的sourceId/batchId固定，換來源批次須新主體。每個(subjectRef,a5Revision)綁定全部來源、packageHash、參數、三矩陣/session/manifest/官方/容器hash、evidenceRefs與scientificStatus不可覆寫，冷重開仍拒漂移。新修訂需新sessionRef與manifestRef；原矩陣不改寫。evidence.loadState為unknown/not-tested/failed/loaded；loaded要求generation/load參照，但只是核心供應的固定紀錄，**索引不執行R或證明真載入**。未知證據不能重啟自動升級，新增證據若改綁定要新修訂。

來源描述註冊前後重查；同request同payload去重，異payload拒REQUEST_CONFLICT，舊修訂不跟新來源漂移。來源token須由受信核心提供可重核的持久映射；重啟不自己恢復失效授權。sourceTimeoutMs允許5..5000ms，超時取消等待並釋放本人操作鎖，晚回不提交；提供者須遵守signal及唯讀契約。

## 持久、容量與寫入失敗

registry.json用單個有SHA-256信封的原子發布，records與request去重同次寫入；上限128修訂／256request／2MiB，拒超限、不淘汰舊綁定。讀取有界、regular/no-symlink、O_NOFOLLOW/O_NONBLOCK、檔案前後身份／全內容hash核對；損壞或截斷拒絕，不以空索引覆蓋。元資料操作以registry.lock獨佔，鎖inode或同inode內容身分被替換皆拒寫且不刪替換鎖；讀取不改索引bytes/mtime。

寫入獨有temp→fsync→rename→目錄fsync。beforePublish是**可信測試用故障注入點**（temp已同步），沒有前端設定或正式註冊。一般失敗清本人temp並保舊版；程序中斷可留temp及未知registry.lock，cold操作保持blocked/incomplete，recoveryState仍能有界檢查舊發布版本。沒有未知操作鎖的自動搶占、全歷史清掃或實際OS身份恢復功能；本階段無可信OS出生證據，不允許推測PID已死來刪鎖。

## Ownership：單協調器與journal

`new Ownership({root,beforePublish?})` 建立核心隨機ownerId/token/birthRef。birthRef明確是**邏輯租約參照**；pid與osBirthEvidence只能null，本模組沒有OS程序身分或kill能力。

- `claim()`以owner.lock的wx取得整個協調器生命週期排他權，並寫journal；既有未知鎖、損壞／不完整journal阻擋。另一個實例／真Node程序無法接管。
- `reserve(lease)`先保存Host的精確analysis/revision/ownerId/token/birthId，port起初null、PID/OS證據null，再允許受信port建立租約；`update`／`clear`只限同一租約。
- `inspect()`只回unknown或blocked、URL null；journal狀態claimed/reserved/active/cleanup-required/clean沒有持久ready或URL。active僅代表曾配置邏輯租約，不能憑port沿用服務。新程序先讀為unknown/incomplete，不重建ready。
- `release()`先核本次lock inode、root、owner/token/birthRef及無待清租約，發布clean後才移除本人鎖。`detach()`只關本機metadata檔案句柄，保留檔案與未決租約，不稱清理成功。
- `recover()`無可信回呼時保持未知鎖；`recover(reconcile)`只接受**合成邏輯租約**的精確 `{owner,lease,outcome:'stopped',evidenceClass:'synthetic',evidenceRef}`。等待前後重核root/lock身份及journal內容，任何替換／晚回拒絕，不呼叫未知程序stop。結果僅synthetic-contract-cleared／unknown，絕不標OS進程已停或服務ready。此接縫只驗恢復契約，沒有安裝正式OS身份提供者。

owner.lock與journal不是跨檔atomic：只寫owner便中斷、journal壞／截短、metadata操作鎖未知、start回覆未知或清理失敗，都保留blocked/incomplete與參照。journal缺失時，即使合成回呼也不能捏造完整歷史作恢復。未知或外人鎖不由shutdown刪除；測試清理只移除本人新建的合成fixture。

## PersistentHost：沿用既有Host，不重寫

`new PersistentHost({root,registry,providers?,timeoutMs?,cleanupTimeoutMs?,beforePublish?})` 在核心建立一個既有Host。索引及owner metadata建議分開的自有子根；不直接給renderer建構器或供應器。缺verifySession/start回blocked/PROVIDER_UNAVAILABLE，不起租約。

`open({analysisId,visualizationRevision})`／`status()`／`close()`／`shutdown()`／`canNavigate(url)`／`browserURL()`／`inspectRecovery()`。相同pending open共用同一Promise；不同請求busy不污染既有健康租約。close只清本次Host租約，shutdown成功清理後才釋放協調器鎖。未知清理保journal、撤URL並阻重開，需精確close重試或後續可信對帳。

resolve從持久索引重新查驗；verifySession({record,binding,signal})是受信提供者接縫，不能從loadState旗標或metadata自動造generated/loaded。start({...HostInput,birthId})必須同步返回本次owner/token/birthId/port/ready/stop租約，**真副作用只能在ready發起**。本輪只使用記憶體合成port，沒有真服務或R。先寫reserved才呼叫port；租約不合／start結果未知保留incomplete，不碰外人stop。stop先記cleanup-required、await精確本人stop成功，再記clean；跨程序中斷不冒跨檔atomic。

就緒證據仍由未修改Host核Listening／HTTP token及精確origin/port，僅service-only；新接頭在open回應、status及每次導航查詢另核owner鎖與journal租約，身分遺失立即撤URL。未接main的frame/redirect/popup/request等事件，不能把本模組canNavigate稱為正式全導航已部署；沒有三頁橋接／基因上傳／真session。

## 測試與採納限制

`node --test desktop/core/s6/test-registry.cjs desktop/core/s6/test-port-adapter.cjs desktop/core/s6/test-process.cjs`。SIGNET_S6_INDEX_TEST_ROOT只能指本人新建測試metadata目錄；未指定則使用canonical系統暫存，fixture結束清理。

包含冷重開／不覆舊參數與hash／同request衝突／源撤銷／壞hash及截斷／128／兩個真Node程序競爭／鎖替換／beforePublish中斷／未知owner不清理／合成恢復／清理失敗重試／來源漂移與owned URL撤銷。真Node子程序只操作自有metadata並等待退出，不是助手、R服務或科學運算。所有service port合成，所有registry檔案讀寫僅本機fixture。

限制：Node路徑／inode檢查不是OS openat隔離；狀態hash防損壞，不保同帳號惡意改寫的真實性。來源授權／字節核對、實際PID/OS出生與程序stop、R/網路/服務、完整崩潰恢復與正式事件橋接均待後續受信實作；未知鎖保留是安全的incomplete，非已恢復可用。模組尚未獨立驗收／精進，S5最後接受後才另行正式採納；禁止以本輪合成ready或收據稱官方頁／科學完成。
