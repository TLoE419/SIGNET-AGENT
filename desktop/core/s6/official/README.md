# 官方匯入視覺化接點（尚未整鏈驗收）

main 的 `OfficialVisualizationProvider` 只讀目前已核匯入 binding 的三矩陣，準備工作在 Registry 原有1秒metadata期限之外，完成後重新核對匯入context。Host原15秒啟動、3秒清理及Registry期限不變。未知或失敗準備不在同一provider內自動重試；工作階段來源仍science unknown。

隔離開發啟動須由主程序指定 `SIGNET_OFFICIAL_PROJECT_ROOT=/Users/tloe/Developer/SIGNET`，作為既有公開official source、provenance及vm材料根；不從renderer接受路徑或命令。此設定不授予新的遠端站台權限：仍固定原嚴格SSH、root@127.0.0.1:2226。未配置就OFFICIAL_EXECUTOR_UNCONFIGURED。不得把此開發設定當新來源授權；矩陣仍須走原匯入授權與新鮮context。

`guest.py`在客體建立一個隨機自有根，用固定源10個netvis檔案與本地pins比對，讀同一持有SIF FD（重用已有完整雜湊與dev/ino/size/mtime/ctime綁定，身分不同就拒絕，不重新宣稱雜湊通過）。只接受3個已核hash的有界資料Buffer、固定參數及主程序工具。

`prepare.R`沿官方extract_edges.R→netshiny.R，僅調整headless保存；`load.R`必須實際load且驗UI/server。真生成／真載入後才提供Registry描述；沒有使用包宣告或成功退出碼造session證據。服務仍需真Listening、新日誌、精確token HTTP及原Host租約驗證；HTTP不代表三頁可用。

子程序只可讀公開矩陣／來源及自己根。prepare禁socket；serve僅容許AF_INET stream listener，connect/send datagram/x32一律拒絕；使用原固定loopback Shiny host。新子程序降權、no_new_privs、檔案128MiB／總根256MiB／AS4GiB／CPU240秒／NOFILE256；prepare300秒、load30秒的外層界限不等於Host啟動期限。控制管道EOF或close終止自己process group、等待退出、關FD並刪本次隨機根；未知清理不視為完成，不處置其他根。

限制：未接入先前其他分支的離線STRINGdb公開回應適配器。原官方程式的網路存取在此被拒絕，缺公開資源時會如實失敗，不會下載、外送或以合成富集代替。真prepare/session/load、服務啟動時長及三頁尚待同固定版驗證。既有15秒Host啟動是否足夠仍未實測，不能因本接線放大期限。冷啟動不採用已刪客體根；沒有跨應用重啟的已生成session恢復能力。

作者原生整鏈嘗試有兩個前置錯誤（Rscript硬路徑、NOFILE128），都已保留；修後只做Rscript --version與核心socket契約，不把它稱為科學準備成功。桌面操作權不屬於本輪build。
