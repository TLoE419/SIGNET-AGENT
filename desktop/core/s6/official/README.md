# 官方公開範例離線視覺化接點（尚未整鏈驗收）

主程序設定 `SIGNET_OFFICIAL_PROJECT_ROOT=/Users/tloe/Developer/SIGNET` 及 `SIGNET_PUBLIC_RESOURCE_ROOT=<已核 public-acquisition 絕對實體目錄>`；這些不是 renderer 輸入，也不授予新來源。原 SourceBroker 授權、來源撤銷、fresh context、Registry 1秒、Host啟動15秒／清理3秒不變。只有明確辨識的官方模擬三矩陣與 freq=1/ntop=1 可以消費固定公共快取。舊0.5/2草稿明拒，不自動換參數。

`public-resource-pins.json` 固定既有 acquisition/enrichment 紀錄、七個已取得公共回應及79個識別碼。主機只按固定檔名 NOFOLLOW 讀取，逐1MiB傳給同一私有客體通道，兩端核對總長／SHA-256；沒有外連回退。R STRINGdb 2.4.2 適配器保留原初始化預設、aliases、PPI門檻／背景篩選、類別過濾；只替換固定網路回應。真正 R 所求識別碼必須與快取集合完全一致，否則保存精確缺少／多餘集合並拒絕。官方 tryCatch 吞掉富集例外也不能繞過最後消費確認。

先比對10份官方原碼 pins，再在自有副本精確處理空富集表與內建 hg38 染色體資料；不改原來源、邊／權重／分群／統計公式。manifest 分列原碼與適配後指紋，內建 cytoband 另核 SHA-256。資料為官方模擬範例，科學狀態仍未知；獨立 Python 集合重算不等於官方 R 比對。

V-S6-SVC-01：客體只在新自有 mount namespace 建立 nodev/nosuid/noexec、256MiB、4096 inode 的 tmpfs；不可用即拒絕。prepare/load 完成以及發布/服務迴圈均檢查邏輯大小。核心檔案系統限制的是同時實際占用，並非每次覆寫累加的生命週期寫入量；不宣稱後者。工作階段封存前，先從已持有來源 FD 取得大小，向上頁對齊預留副本額度；tmpfs 在配置 memfd 前縮額並核當前占用能容納，否則拒絕。複製最多只寫原定長度，失敗關副本 FD，縮額保持到自有根卸載；原檔仍占空間時也不得超同256MiB。稀疏檔案邏輯大小另有完成/服務檢查，不把輪詢稱為邏輯大小的核心硬限制。

V-S6-SVC-02：真生成輸出先經 NOFOLLOW 持有、前後身分檢查及雜湊，再拷入 kernel-sealed memfd，核封存後雜湊；R 的標準輸入繼承同一 FD（不是另開可變原路徑）。exec 在降權及網路禁制下核 FD0 seals，R 透過自身 FD0 載入，前後核 SHA-256/身分。原生成暫存檔移除，只有同一私有 owner 能維持該 FD。prepare 禁 socket，serve 僅固定回環 listener；connect/datagram/x32 仍拒絕。原 AS4GiB、CPU240秒、單檔128MiB、FD256、prepare300秒/load30秒不變。

初始資源握手有單獨10秒界限以涵蓋原 SSH ConnectTimeout=8；它不是 Host 或 Registry 的延長。後續 metadata check 仍1秒，分段傳入5秒/段。有界失敗不在同一 provider 自動重試。EOF/close 停自有程序群組、關 FD、卸載自有命名空間中的限額根；無明確退出/收尾證據就保留未知。

本輪首個整鏈在初始1秒握手逾時，未進 R prepare。修後只核公共資源階段；全部快取核符、客體退出0且自有根移除。核心256MiB ENOSPC、封存 FD 禁改、容器內 R 同FD實讀及全套件前置已核；真正官方 prepare/session/load/服務與三頁仍未驗。沒有跨應用重啟恢復工作階段能力。桌面權不屬於 build，不能用這些證據宣稱頁面可用。
