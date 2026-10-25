# 安裝與第一次啟動

## 1. 準備程式環境

先下載並解壓此專案，在專案根目錄開啟終端機。基本聊天介面不需要科學資料、R、容器或排程器。需要 Python 3.11 以上；目前驗證平台為 macOS／Python 3.11。Windows 原生環境未驗證，進階工具依賴類 Unix 程序管理。

```sh
python3.11 --version
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
```

`requirements.txt` 固定直接依賴版本；間接依賴由套件安裝器解析，並非全套版本鎖定。前端套件已隨專案附帶，不需要安裝網頁建置套件。

## 2. 設定自己的模型

預設使用 Codex 命令列。此專案核對的版本為 `0.162.1`，使用結構化回覆、暫時工作階段與只讀沙箱；不同版本可能不相容。官方安裝入口見 [Codex 命令列文件](https://learn.chatgpt.com/docs/codex/cli)。登入與命令行為依 [OpenAI 官方命令參考](https://learn.chatgpt.com/docs/developer-commands#codex-login)。

安裝後確認：

```sh
codex --version
codex login
codex login status
```

登入由使用者親自完成。本專案不提供或複製帳號憑證。模型預設沿用本機 Codex 設定；如需指定模型，可在 `.env` 的 `SIGNET_CODEX_MODEL` 設定。聊天會使用帳號額度。

也可使用 Groq 或 Gemini：

```sh
cp .env.example .env
```

只有第一次、尚無 `.env` 時才複製。編輯檔案，填入自己的 `GROQ_API_KEY` 或 `GEMINI_API_KEY`。`.env` 不提交；不要把金鑰貼進聊天或原始碼。

```sh
.venv/bin/python chat_ui.py --provider groq
# 或
.venv/bin/python chat_ui.py --provider gemini
```

## 3. 啟動

```sh
.venv/bin/python chat_ui.py
```

開啟 [本機介面](http://127.0.0.1:8880)。沒有模型登入時仍能看到頁面，但無法取得真實聊天回答。若該埠已使用，改用：

```sh
.venv/bin/python chat_ui.py --port 8881
```

打開對應的 `http://127.0.0.1:8881`。終端機 Ctrl+C 停止服務；已啟動的科學工具需依狀態紀錄確認，關頁不等於取消。

## 4. 驗證最小展示

依 [展示流程](demo-stage6-2026-10-22.zh-TW.md) 詢問工具能力與輸入需求。下載版本沒有 `data/`、`runs/` 或完成結果；尚無網路圖是預期狀態，不代表載入失敗。

若要使用終端機聊天：

```sh
.venv/bin/python main.py
```

## 5. 常見缺少條件

| 現象 | 處理 |
|---|---|
| 找不到 Codex／登入失敗 | 確認命令可執行且登入狀態有效，或改用已設定金鑰的模型 |
| 官方來源尚未準備 | 依進階指南執行 `scripts/setup_source.py`；基本聊天不需此步驟 |
| 找不到輸入資料 | 使用者自行建立 `data/` 並放入符合工具格式的資料 |
| 科學環境不可用 | 閱讀進階指南；本專案不會自動建立虛擬機或安裝科學工具 |
| 頻率限制等待 | Groq 會保留同一模型請求等待重試，不重跑已完成工具；Ctrl+C 可中止等待 |

## 英文對照

- **Python** — 執行本專案所需的程式語言與環境。
- **Unix** — 此處指支援相關程序管理的作業環境。
- **Codex** — 預設模型命令列工具。
- **API** — 此處指使用金鑰連線的模型服務介面。
