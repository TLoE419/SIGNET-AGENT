# SIGNET 桌面工作台

團隊開發的 Electron 桌面程式，管理官方 SIGNET 六階段分析：資料匯入、階段執行、狀態與日誌、產物驗證、官方 R Shiny 視覺化。

桌面控制層使用 Node.js；官方 Python / R 科學程式留在 Linux 科學運算環境。沒有本機 Python HTTP 控制服務。

## 開始開發

先安裝 Git 與 Node.js 24 LTS（最低 22.12.0，含 npm）。從取得的專案根目錄執行：

```sh
bash tools/setup-dev.sh
cd desktop
npm start
```

安裝腳本下載指定版本的官方程式、安裝鎖定的桌面依賴與 Electron 執行檔，並跑一般測試。它不會下載大型科學容器、啟動虛擬機或執行分析。首次安裝需要網路。

完整手動步驟、不同系統的限制、測試與運算環境準備見 [安裝文件](docs/INSTALL.md)。

## 協作入口

- [目前架構圖](docs/architecture/signet-current.html)：用瀏覽器開啟；圖中文字為繁體中文，檢視器部分按鈕為英文。
- [模組與現有介面](docs/INTERFACES.md)：依程式碼整理的分工入口，不表示 HPC 介面已完成。
- [上傳範圍](docs/UPLOAD.md)：哪些檔案納入版本控制、哪些留在本機。
- [桌面開發說明](desktop/README.md)。

## 驗證

```sh
cd desktop
npm test
```

一般測試使用程式生成的小型合成資料，無需官方程式、VM、科學容器或歷史分析結果，也不會執行科學運算。合成資料通過只驗證控制與結果檢查邏輯，不證明官方科學流程已跑通。

真實歷史模擬結果的逐邊比較保留為選用測試：

```sh
cd desktop
npm run test:scientific
```

該測試需另行準備既有參考結果，不包含於版本庫；缺資料時會明確失敗。它只讀取結果，不提交新的運算。

## 官方來源與安裝界線

官方來源：https://github.com/signet4grn/SIGNET

固定提交：`bed55b3e121de0edf5fd43da683dc59850ff82d3`。

`tools/download-official.sh` 下載到被排除的 `official-signet/`；既有副本若版本不符、來源不符或有修改，腳本會停止，保留原檔。下載的官方程式保留其授權文件；本版本庫不收錄該副本，也不替官方程式變更授權。

目前科學執行介面仍連到既有本機 Linux VM。校方 HPC 尚未接通；安裝桌面開發環境不等於安裝完整科學分析環境。打包設定目前僅為 Apple Silicon macOS，尚未簽署或公證。其他平台的桌面執行尚未驗證。

官方第六階段需要先產生並驗證 `official-session.RData`，再透過受限 SSH 隧道開啟 Shiny。它不是舊自製結果頁面；關閉桌面會清理桌面擁有的視覺化服務，已啟動的獨立分析程序則繼續執行。

## 英文對照

- **Electron / Node.js** — 桌面應用框架與控制程式執行環境。
- **LTS** — 長期支援版本。
- **Linux / VM** — 科學運算作業系統與本機虛擬機。
- **HPC** — 未來預計接入的高效能運算環境。
- **HTTP** — 網頁服務通訊協定。
- **Python / R / Shiny** — 官方分析語言與互動式視覺化框架。
- **SSH** — 安全遠端連線與隧道機制。
