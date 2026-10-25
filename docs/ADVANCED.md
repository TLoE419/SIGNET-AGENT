# 進階科學環境

基本聊天不依賴此環境。本文件說明現有程式的環境契約，並非全自動科學環境安裝器。此專案不附研究資料、範例資料、參考資料、預先產生結果、容器映像或虛擬機磁碟。

## 官方科學來源

在專案根目錄執行：

```sh
.venv/bin/python scripts/setup_source.py
```

需要 Git 與網路。腳本取得 `signet_inventory.json` 指定的提交 `bed55b3e121de0edf5fd43da683dc59850ff82d3`，只安裝已盤點的 138 個程式檔、設定／排程模板與授權文件。下載 Git 物件時可能包含上游資料物件，但不會把資料安裝到此專案；暫存下載會清理。

安裝位置預設 `.dependencies/official-signet`，全部排除版本控制。每個盤點檔案核對 SHA-256，失敗不安裝，不覆寫既有目錄。若已有含該提交的本機 Git 儲存庫：

```sh
.venv/bin/python scripts/setup_source.py --from-checkout /path/to/official-signet
```

此操作從指定提交匯出，不採用未提交修改。可用 `--destination` 安裝至其他新目錄，再在 `.env` 設定 `SIGNET_SOURCE`。應用程式從專案根目錄解析相對路徑；獨立來源準備腳本使用明列的命令參數，不載入 `.env`。

## 使用者資料

使用者自行建立 `data/` 放輸入；工具只接受本專案 `data/`、`runs/` 內的合規檔案。部分官方腳本不安全處理空白／特殊字元，因此輸入路徑限制為英文字母、數字、底線、點、斜線與連字號。請把專案放在符合此條件的路徑。

來源準備不等於科學環境完成。Linux 本機前處理仍需各工具對應的 R 套件、PLINK、補值工具等；工具會檢查依賴與前置輸出。請參考固定版本 [官方來源](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3)。本專案不提供完整一至六階段皆可執行的保證。

## 既有本機虛擬機介面

第 4 階段在 macOS 使用此虛擬機；第 5、6 階段的執行入口也使用此連線。其他本機工具仍依平台與依賴檢查決定能否執行。

| 設定 | 預設／要求 |
|---|---|
| `SIGNET_RUNTIME_PROJECT` | 主機端 `.dependencies/scientific-runtime`；需自行準備資產 |
| `SIGNET_SSH_PORT` | 本機 `2226`；僅連至 `127.0.0.1` |
| SSH 使用者 | 既有虛擬機的 `root`，僅限本機 |
| SSH 金鑰 | 執行環境目錄下的 `vm/id_ed25519`，由使用者自行管理 |
| 主機驗證 | `vm/known_hosts`，保留嚴格主機金鑰驗證，不接受略過 |
| `SIGNET_CONTAINER_IMAGE` | 虛擬機內 `/work/evidence/signet-0.0.6.sif`；須為既有可用映像 |
| 第 5 階段 | SLURM 的 `local` 佇列、4 核心與 4 GB、所需 R 套件與 ParaFly |
| 第 6 階段 | 所需 R 視覺化套件與可能使用的線上註解服務 |

設定範本見根目錄 `.env.example`。不得提交私鑰、主機憑證、磁碟或映像。缺少環境時回報不可用，不自動啟動或重建。

`scripts/advanced/start_scientific_vm.sh` 僅用於原有 Apple Silicon 修復環境：需要既有 `signet-qemu:20261006` 映像、原容器、`vm/signet.qcow2` 與 `vm/seed.img`。腳本採單執行緒模擬與增量磁碟，不是新使用者的安裝器。若需使用，先在目前 shell 明確設定 `SIGNET_RUNTIME_PROJECT` 與選用的 `SIGNET_SSH_PORT`；此 shell 腳本不讀 `.env`。已有修復容器時只啟動它，不會重新套用埠號／掛載變更，必須先自行核對原容器設定。

第 5 階段結果驗證器已隨專案附帶，位於 `scripts/advanced/verify_network.cjs`，不再依賴其他桌面專案。它核對排程工作、指令完成清單、矩陣與重抽樣平均值；需要 Node.js 20 以上。

## 參考資料工具

這些工具不下載或提供資料，必須明確指定自己的輸入：

```sh
.venv/bin/python scripts/prepare_genotype_reference.py --help
.venv/bin/python scripts/check_genotype_example.py --help
```

前者轉換已備妥參考檔並檢查位置／等位基因；不代替基因組版本的科學核對。後者在既有虛擬機內執行固定來源入口。

## 中斷與驗證界線

工作建立後保留於 `runs/`。連線中斷或狀態未知時先查詢，不重新提交同一操作。程式完成、技術驗證、生物學有效性是三種不同狀態；只回報已有證據能支持的狀態。

## 英文對照

- **Git** — 取得官方固定提交的版本管理工具。
- **SHA-256** — 檢查來源檔案內容的雜湊。
- **Linux** — 部分科學工具所需的作業系統。
- **R** — 官方科學分析與視覺化使用的程式環境。
- **PLINK** — 基因型資料處理工具。
- **SSH** — 連線至本機虛擬機的通訊方式。
- **root** — 此既有虛擬機使用的系統管理帳號。
- **SLURM** — 管理科學工作佇列與資源的排程器。
- **ParaFly** — 執行官方平行分析指令的工具。
- **shell** — 執行進階啟動腳本的命令列環境。
- **Node.js** — 執行結果驗證器的環境。
