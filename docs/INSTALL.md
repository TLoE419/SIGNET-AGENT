# Installation and Development

[English](#english) | [繁體中文](#traditional-chinese)

<a id="english"></a>

English is the default version below. The complete Traditional Chinese version follows it.

## 1. Choose your installation scope

| Goal | Required | Not required |
| --- | --- | --- |
| Edit code and run core tests | Node.js ≥22.12.0; 24 LTS recommended | Official source, Electron binary, VM, scientific container, historical results |
| Open the desktop and prepare analyses | Git, pinned official source, locked desktop dependencies, Electron binary | Opening the desktop does not start a VM or scientific computation |
| Run scientific analyses | Separately configured Linux, Apptainer, SLURM, container, and data connection | Desktop installation alone is insufficient |

The validated desktop platform is Apple Silicon macOS. Core Node tests on Linux and Windows require no macOS tools, but desktop operation on those platforms has not been validated. On Windows, use Git Bash for the download script or the manual Git commands below.

## 2. Get the team repository

```sh
git clone https://github.com/TLoE419/SIGNET-AGENT.git SIGNET
cd SIGNET
```

If you already have the project folder, change to its root. Install Git and Node.js 24 LTS (minimum 22.12.0), including npm. No global Electron installation is needed.

## 3. Set up the development environment

```sh
bash tools/setup-dev.sh
```

The script checks the Node version, downloads the pinned official source, runs `npm ci`, downloads the Electron binary, and runs core tests. It does not open the desktop or perform scientific computation.

If an existing official checkout has local changes, an unexpected origin, or a different revision, the script stops without overwriting it. Inspect and preserve any changes you need before replacing that checkout.

## 4. Manual installation

Download the official source from the project root:

```sh
bash tools/download-official.sh
```

If Bash is unavailable, run these commands in a clean project folder where `official-signet/` does not already exist:

```sh
git clone https://github.com/signet4grn/SIGNET.git official-signet
git -C official-signet checkout --detach bed55b3e121de0edf5fd43da683dc59850ff82d3
```

Do not track the latest upstream branch instead: the current stage contracts and example checksums target this specific commit.

Install desktop dependencies and the executable:

```sh
cd desktop
npm ci
npx --no-install install-electron --no
npm test
npm start
```

The installed Electron version separates binary download from npm package installation. Explicitly downloading the binary surfaces download errors before launch. See the [official Electron installation guide](https://github.com/electron/electron/blob/main/docs/tutorial/installation.md).

If a network step fails, rerun the relevant download or installation command. The source download uses a temporary directory and publishes it only after success. Do not commit downloaded official source, dependencies, or large scientific containers to the team repository.

## 5. Run tests without installing the desktop

With Node.js alone, run this from the project root:

```sh
node --test desktop/test-core.cjs
```

Alternatively, run `npm test` in `desktop/`. Core tests generate and clean up small synthetic fixtures in the OS temporary directory. They do not read historical analyses or invoke SSH. See the next section for optional real-result comparison.

## 6. Optional: compare real reference results

Obtain trusted results from a previously completed simulation separately, preserving this layout:

```text
REFERENCE_ROOT/
├── runs/macos-vm-smoke-20261006/
│   ├── res/resn/          # Frequency, coefficient, and gene-position matrices
│   ├── tmp/tmpn/          # Input/ bootstrap matrices and command completion lists
│   └── logs/             # verification.json, scheduler-jobs.json, job_ids.txt
└── results/actual/network.json
```

Run from `desktop/`, replacing the path with your reference-data directory:

```sh
SIGNET_SCIENTIFIC_ROOT=/absolute/path/to/REFERENCE_ROOT npm run test:scientific
```

On Windows PowerShell:

```powershell
$env:SIGNET_SCIENTIFIC_ROOT = 'C:\path\to\REFERENCE_ROOT'
npm run test:scientific
```

This test compares existing simulation results and matrices; it does not submit a new analysis. Reference data is supplied separately, is not downloaded automatically from this repository, and must not be replaced by synthetic fixtures presented as real results.

## 7. Optional: configure scientific computation

Development setup does not include the full scientific environment. `tools/start-vm.sh` and `tools/setup-vm.sh` operate the existing macOS local environment; they are not cross-platform one-click installers. Before using them, prepare:

- The Docker image `signet-qemu:20261006`, which can be built from `tools/VM.Dockerfile`.
- `vm/jammy-amd64.img`, a separately generated SSH key pair for each computer, and cloud-init `user-data` and `meta-data`. Do not share private keys.
- The official `evidence/signet-0.0.6.sif` from `library://jiang548/signet/signet:0.0.6`. Its SHA256 is `de28f224f3da41b17ff08a03d0f04b1d5c033b2afbad18ed448b646b2feda277`. Obtain it from the official source and verify its checksum; it is not distributed through Git.
- The project mounted at `/work` inside the VM, Apptainer/`singularity`, SLURM, and the correct local host-key records.

See the downloaded `official-signet/README.md` and `DEPENDENCY.md` for official data and tool requirements. Teammates working only on UI or control logic can stop after section 5.

The current SSH adapter is fixed to `root@127.0.0.1:2226`. HPC connectivity, remote data transfer, submission, and reconnection remain to be implemented. Deployment and end-to-end operation on the university cluster have not been validated. Do not start a scientific stage before its environment is ready.

## 8. Package the desktop

Packaging is currently configured only for Apple Silicon macOS:

```sh
cd desktop
npm run package:mac
```

Output is written to the Git-ignored `desktop/dist/`. On first launch, the packaged app asks for a project folder containing the downloaded official source and required validation records. The app is unsigned and unnotarized, and includes neither the scientific container nor a VM.

---

<a id="traditional-chinese"></a>

# 安裝與開發

## 1. 選擇安裝範圍

| 目的 | 需要 | 不需要 |
| --- | --- | --- |
| 修改程式、執行一般測試 | Node.js ≥22.12.0，建議 24 LTS | 官方程式、Electron 執行檔、VM、容器、歷史結果 |
| 開啟桌面介面與準備分析 | Git、官方固定版本、鎖定的桌面依賴、Electron 執行檔 | 開啟介面不會啟動 VM 或科學計算 |
| 完整科學分析 | 額外配置 Linux、Apptainer、SLURM、容器與資料連線 | 不能只靠桌面安裝完成 |

目前驗證平台為 Apple Silicon macOS。Linux 與 Windows 的一般 Node 測試不需要 macOS 工具，但桌面操作尚未驗證；Windows 使用 Git Bash 執行下載腳本，或使用下列手動 Git 指令。

## 2. 取得團隊程式

下載團隊版本庫：

```sh
git clone https://github.com/TLoE419/SIGNET-AGENT.git SIGNET
cd SIGNET
```

若已取得專案資料夾，直接切換到根目錄。請先安裝 Git、Node.js 24 LTS（至少 22.12.0）及隨附的 npm；不需要全域安裝 Electron。

## 3. 一次準備開發環境

```sh
bash tools/setup-dev.sh
```

腳本依序核對 Node 版本、下載官方固定提交、執行 `npm ci`、取得 Electron 執行檔、執行一般測試。不會啟動桌面或進行科學計算。

既有官方副本若有修改、錯誤來源或錯誤提交，會停止而不覆寫。請自行檢視並保留需要的變更，不要直接刪除舊資料。

## 4. 手動安裝

從根目錄下載官方程式：

```sh
bash tools/download-official.sh
```

不使用 Bash 時，可在尚未存在 `official-signet/` 的乾淨下載資料夾執行：

```sh
git clone https://github.com/signet4grn/SIGNET.git official-signet
git -C official-signet checkout --detach bed55b3e121de0edf5fd43da683dc59850ff82d3
```

不要改成追蹤官方最新分支；目前的階段契約與範例校驗固定在此提交。

接著安裝桌面依賴與執行檔：

```sh
cd desktop
npm ci
npx --no-install install-electron --no
npm test
npm start
```

Electron 現行版本將執行檔下載與 npm 套件安裝分開；明確安裝執行檔可提早發現下載問題。參考 [Electron 官方安裝文件](https://github.com/electron/electron/blob/main/docs/tutorial/installation.md)。

網路失敗時可重跑下載或安裝步驟；下載腳本使用暫存資料夾，成功後才放入目標目錄。不要把官方副本、依賴或大型容器提交到團隊版本庫。

## 5. 不安裝桌面的測試方式

只有 Node.js 即可，從根目錄執行：

```sh
node --test desktop/test-core.cjs
```

或在 `desktop/` 執行 `npm test`。一般測試會在作業系統暫存目錄產生合成資料並清理；不讀取你的歷史分析，也不呼叫 SSH。選用真實比對測試另見下一節。

## 6. 選用：真實結果比對

另行取得可信的已完成模擬結果，保留這個結構：

```text
REFERENCE_ROOT/
├── runs/macos-vm-smoke-20261006/
│   ├── res/resn/          # 頻率、係數、位置矩陣
│   ├── tmp/tmpn/          # 原始輸入矩陣、bootstrap 矩陣、命令完成清單
│   └── logs/             # verification.json、scheduler-jobs.json、job_ids.txt
└── results/actual/network.json
```

從 `desktop/` 執行，將路徑換成實際參考資料位置：

```sh
SIGNET_SCIENTIFIC_ROOT=/absolute/path/to/REFERENCE_ROOT npm run test:scientific
```

Windows PowerShell：

```powershell
$env:SIGNET_SCIENTIFIC_ROOT = 'C:\path\to\REFERENCE_ROOT'
npm run test:scientific
```

此測試比對既有模擬結果與矩陣，不會提交新分析。參考結果是另外提供的本機檔案，不從團隊版本庫自動下載，也不能用合成測試資料冒充。

## 7. 選用：科學運算環境

目前開發安裝不包含完整科學環境。`tools/start-vm.sh`、`setup-vm.sh` 是既有 macOS 本機環境的操作腳本，並不是跨平台的一鍵安裝器。執行前必須自行備妥：

- Docker 中的 `signet-qemu:20261006` 映像，可由 `tools/VM.Dockerfile` 建立。
- `vm/jammy-amd64.img`、每台電腦自己產生的 SSH 金鑰與 cloud-init 的 `user-data`、`meta-data`；不得共用本機私鑰。
- 官方 `evidence/signet-0.0.6.sif`：來源 `library://jiang548/signet/signet:0.0.6`，SHA256 為 `de28f224f3da41b17ff08a03d0f04b1d5c033b2afbad18ed448b646b2feda277`。須依官方來源取得並核對；不隨 Git 分發。
- VM 內 `/work` 專案掛載、Apptainer/`singularity`、SLURM，以及正確的本機主機金鑰紀錄。

完整參考資料與工具需求見下載後的 `official-signet/README.md`、`DEPENDENCY.md`。新組員若只開發介面或控制邏輯，可先停在第 5 節。

本機 SSH 介面固定 `root@127.0.0.1:2226`。HPC 連線、遠端傳輸、提交與重新連線仍待實作；沒有校方叢集上的部署或端到端成功保證。不要在尚未備妥環境時按下執行階段。

## 8. 打包桌面

目前只提供 Apple Silicon macOS 的打包設定：

```sh
cd desktop
npm run package:mac
```

輸出在 `desktop/dist/`，此目錄被版本控制排除。首次開啟打包程式要選擇含下載官方程式與必要驗證資料的專案根目錄。應用程式尚未簽署或公證，也不內含科學容器或虛擬機。

## 英文對照

- **Node.js / Electron** — 控制程式執行環境與桌面框架。
- **LTS** — 長期支援版本。
- **Git Bash / PowerShell** — Windows 上可使用的命令環境。
- **VM / Linux / Docker / QEMU** — 虛擬運算環境與其建置、模擬工具。
- **Apptainer / SLURM** — 科學容器執行工具與工作排程器。
- **SSH / cloud-init** — 安全連線與虛擬機初始化工具。
- **HPC** — 高效能運算環境。
- **SHA256** — 檔案校驗碼，用來核對下載內容。
- **bootstrap** — 科學網路分析中的重抽樣流程。
