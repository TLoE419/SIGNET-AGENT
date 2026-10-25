# 預定上傳檔案與用途

此樹只列候選檔案，不代表已提交或上傳。所有資料與本機工作產物均排除；測試只在暫存目錄產生必要的合成內容。

```text
SIGNET-agent/
├── .env.example                  # 空白金鑰與進階環境設定範本
├── .gitignore                    # 排除所有資料、憑證、紀錄與本機依賴
├── README.md                     # 專案首頁、功能範圍與快速啟動
├── requirements.txt              # 固定四個直接相依套件版本
├── chat_ui.py                    # 本機網頁服務、對話儲存與工作區介面
├── main.py                       # 對話流程、公開進度與受控工具調用
├── codex_provider.py             # 使用下載者自己登入的模型命令列
├── groq_provider.py              # Groq 連線、工具格式與額度等待
├── context_budget.py             # 輸入長度與重複工具證據壓縮
├── model_timing.py               # 模型請求與傳輸耗時
├── tools.py                      # 受限列檔與文字分頁讀取
├── signet_tools.py               # 科學工具、參數驗證與隔離工作準備
├── signet_inventory.json         # 官方程式版本、分類與檔案雜湊
├── signet_runtime.py             # 本機虛擬機連線、封裝與輸出收集
├── network_runtime.py            # 網路推論提交、查詢、取消與結果核對
├── network_worker.py             # 虛擬機內背景控制與所屬工作監督
├── visualization_runtime.py      # 第六階段出圖及輸入／輸出檢查
├── stage6_workspace.py           # 參數提案、人工確認、歷史與比較
├── assets/
│   └── tokenizers/
│       ├── qwen3.8-27b.json       # 約 12.8 MB 斷詞資料，不是研究資料或模型權重
│       ├── README.md             # 斷詞資料來源、版本與雜湊
│       └── LICENSE               # 斷詞資料的上游授權
├── docs/
│   ├── INSTALL.md                # 首次安裝、模型登入與介面啟動
│   ├── ADVANCED.md               # 官方來源、自備資料與進階科學環境
│   ├── THIRD_PARTY.md            # 第三方來源與尚待決定的授權
│   ├── FILE_TREE.md              # 本檔案樹與逐檔用途
│   └── demo-stage6-2026-10-22.zh-TW.md  # 無資料展示與自備結果後的操作
├── scripts/
│   ├── setup_source.py           # 取得並核對固定版科學程式，不安裝資料
│   ├── prepare_genotype_reference.py  # 轉換使用者自備參考檔
│   ├── check_genotype_example.py  # 在既有虛擬機驗證使用者輸入
│   └── advanced/
│       ├── start_scientific_vm.sh # 原有修復環境的進階啟動腳本
│       └── verify_network.cjs     # 排程、矩陣、指令與重抽樣結果驗證器
├── web/
│   ├── index.html                # 聊天與第六階段頁面結構
│   ├── chat.js                   # 聊天、進度與回答排版，含文字排版解析器
│   ├── chat.css                  # 介面與窄視窗樣式
│   ├── i18n.js                   # 繁體中文／英文切換
│   ├── stage6.js                 # 參數、網路圖與結果比較互動
│   └── vendor/
│       ├── README.md             # 套件來源、版本與修改紀錄
│       ├── vis-network.min.js    # 網路圖互動套件
│       ├── vis-network-LICENSE.txt  # 網路圖套件授權
│       └── markdown-it-LICENSE.txt  # 回答排版解析器授權
└── tests/
    ├── test_chat.py              # 對話與工具流程
    ├── test_chat_ui.py           # 網頁請求防護、串流進度與對話隔離
    ├── test_codex_provider.py    # 模型命令列、格式與憑證隔離
    ├── test_context_budget.py   # 輸入長度與證據壓縮
    ├── test_decision_summary.py # 公開工具選擇摘要
    ├── test_diagnostics.py      # 錯誤回報與敏感內容遮蔽
    ├── test_genotype_reference.py # 參考資料轉換
    ├── test_groq_provider.py    # Groq 回覆、額度與工具格式
    ├── test_i18n.cjs            # 語言切換與內容保留
    ├── test_list_files.py      # 遞迴列檔與隱藏／連結排除
    ├── test_markdown.cjs       # 回答排版與不安全內容處理
    ├── test_model_timing.py    # 模型傳輸計時
    ├── test_network_runtime.py # 排程、取消與實際驗證器
    ├── test_portability.py     # 可攜路徑、來源安裝與設定防護
    ├── test_read_file.py       # 文字讀取邊界與分頁
    ├── test_signet_runtime.py  # 虛擬機封裝、收集與未知狀態
    ├── test_signet_tools.py    # 來源、工具與執行限制
    ├── test_stage6_graph.cjs   # 網路圖拖曳、視角與比較
    ├── test_stage6_workspace.py # 提案、人工確認與工作區隔離
    ├── test_visualization_runtime.py # 第六階段輸入／輸出
    └── test_vm_start.py        # 啟動腳本的磁碟與容器保護
```

不上傳：`data/`、`runs/`、`.env`、聊天／工作狀態、`.venv/`、`.dependencies/`、快取、`evidence/`、`artifacts/`、`.archify/`。

本機原有資料保留；來源準備腳本取得的程式也留在排除目錄，不屬於上傳清單。
