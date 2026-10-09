# GitHub 上傳範圍

## 納入

- 根目錄 README 與 `.gitignore`。
- `desktop/` 的程式、介面、套件宣告、鎖定檔、測試與合成資料生成工具。
- `tools/` 的官方程式下載、開發安裝、環境與分析腳本；排除未使用的 `tools/viewer.html`。
- `docs/` 的安裝、介面與上傳說明，以及 `docs/architecture/signet-current.html`。
- `evidence/input-validation.json` 與 `evidence/provenance.json`：程式目前需要的小型來源與驗證資料。
- `.github/workflows/test.yml`：只跑一般合成資料測試。

## 排除

`official-signet/`、`runs/`、`results/`、`analyses/`、`vm/`、`desktop/node_modules/`、`desktop/dist/`、`desktop/.runtime/`、`desktop/evidence/`、其餘根目錄 evidence、`.archify/`、私鑰、環境機密檔及快取。

排除只影響版本控制，不刪除本機檔案。官方程式由下載腳本取得固定提交；大型容器與真實參考結果另行準備。

## 推送前檢查

先跑一般測試與查看待提交內容：

```sh
node --test desktop/test-core.cjs
git status --short
git diff --cached --stat
git diff --cached
```

確認只有上述納入範圍，再自行建立團隊版本庫、選擇可見性並授予組員權限。此準備流程不建立 GitHub 遠端、不提交私鑰或歷史分析、不自動推送。尚未決定你們自行撰寫程式的發布授權；官方程式的授權保留在下載副本中。
