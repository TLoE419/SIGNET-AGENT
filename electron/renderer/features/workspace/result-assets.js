/* Optional original exports. The custom graph remains the selection authority. */
(() => {
  "use strict";
  const labels = {
    title: ["原始分析結果", "Original analysis results"], loading: ["讀取原始結果…", "Loading original results…"],
    unavailable: ["此執行未保留可預覽的原始輸出。", "No original preview exports were retained for this run."],
    failed: ["原始輸出目前無法讀取，請重新整理。", "Original exports are unavailable. Refresh to try again."],
    refresh: ["重新整理", "Refresh"], graph: ["原始互動網路", "Original interactive network"],
    open: ["檢視原始網路", "View original network"], subnetwork: ["子網路", "Subnetwork"],
    missingGraph: ["未保留原始互動網路檔案。", "The original interactive network was not retained."],
    download: ["下載原始結果 ZIP", "Download original results ZIP"], pdf: ["下載原始 PDF", "Download original PDF"],
    pdfOnly: ["未保留圖片預覽；可下載原始 PDF。", "No image preview was retained; the original PDF is available."],
    circular: ["環狀網路圖", "Circular network"], enrichment_hist: ["富集長條圖", "Enrichment histogram"],
    enrichment_radar: ["富集雷達圖", "Enrichment radar"], count_vs_freq: ["頻率門檻與規模", "Counts by frequency cutoff"],
    missingCounts: ["未保留原始頻率矩陣，無法重建各門檻的數量。", "The original frequency matrix was not retained; cutoff counts are unavailable."],
    cutoff: ["門檻", "Cutoff"], genes: ["基因", "Genes"], edges: ["連線", "Connections"],
    close: ["關閉原始預覽", "Close original preview"], search: ["搜尋連線資料", "Search connections"],
    sort: ["連線排序", "Sort connections"], original: ["原始順序", "Original order"],
    source: ["來源基因 A–Z", "Source gene A–Z"], target: ["目標基因 A–Z", "Target gene A–Z"],
    frequency: ["頻率高至低", "Frequency, high to low"], coefficient: ["係數絕對值高至低", "Absolute coefficient, high to low"],
    rows: ["顯示連線", "Connections shown"], downloadFailed: ["下載連結無法建立，請重試。", "Could not create the download link. Try again."],
    frameFailed: ["預覽無法載入時，請關閉後重新整理原始結果。", "If the preview cannot load, close it and refresh original results."],
  };
  window.mountStage6Assets = ({stage, token}) => {
    if (!stage || stage.querySelector(".s6-original-results")) return null;
    const doc = stage.ownerDocument, languageRoot = stage.closest("[lang]") || doc.documentElement;
    const language = () => languageRoot.lang === "en" ? 1 : 0;
    const t = key => labels[key]?.[language()] ?? key;
    const node = (tag, cls, text) => {
      const element = doc.createElement(tag);
      if (cls) element.className = cls;
      if (text != null) element.textContent = text;
      return element;
    };
    const button = (text, action) => {
      const element = node("button", "", text); element.type = "button";
      element.addEventListener("click", action); return element;
    };
    const panel = node("details", "s6-original-results"), summary = node("summary"), content = node("div", "s6-original-content");
    panel.append(summary, content); panel.hidden = true;
    stage.querySelector(".ml-result-inspector").append(panel);
    const dialog = node("dialog", "s6-original-dialog"), dialogHeading = node("strong"), dialogBody = node("div", "s6-original-preview");
    const close = button("", () => dialog.close()), dialogHint = node("p", "s6-original-note");
    const dialogHeader = node("header"); dialogHeader.append(dialogHeading, close);
    dialog.append(dialogHeader, dialogBody, dialogHint); stage.append(dialog);
    const stopPreview = () => { dialogBody.querySelectorAll("iframe").forEach(frame => frame.src = "about:blank"); dialogBody.replaceChildren(); };
    dialog.addEventListener("close", stopPreview);
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    const contextKey = value => value ? [value.historyId, value.identity, value.revision, value.source, value.runId].join("|") : "";
    let context = null, key = "", request = null, downloadRequest = null, data = null, loading = false, failure = false, downloadFailure = false;
    let selected = 1;
    const safeURL = (value, prefix) => {
      if (typeof value !== "string" || !value.startsWith(prefix)) return null;
      const url = new URL(value, doc.location.href);
      if (url.origin !== doc.location.origin || url.hash || url.username || url.password) return null;
      if (prefix === "/stage6/result-preview/" && (url.search || !/^\/stage6\/result-preview\/[A-Za-z0-9_-]{32}\/[A-Za-z0-9_.+/-]+$/.test(url.pathname)
          || url.pathname.split("/").some(part => part === "." || part === ".."))) return null;
      if (prefix.startsWith("/stage6/result-download") && url.pathname !== "/stage6/result-download") return null;
      return url.href;
    };
    const api = async (url, options = {}) => {
      const response = await fetch(url, {...options, headers: {"X-Chat-Token": typeof token === "function" ? token() : token,
        ...(options.body ? {"Content-Type": "application/json"} : {})}});
      const value = await response.json();
      if (!response.ok) throw Error(value.error || "Result export unavailable");
      return value;
    };
    function showPreview(url, title, image = false) {
      const safe = safeURL(url, "/stage6/result-preview/");
      if (!safe) return;
      stopPreview(); dialogHeading.textContent = title;
      if (image) {
        const img = node("img"); img.src = safe; img.alt = title; img.referrerPolicy = "no-referrer"; dialogBody.append(img);
      } else {
        const frame = node("iframe"); frame.setAttribute("sandbox", "allow-scripts");
        frame.referrerPolicy = "no-referrer"; frame.title = title; frame.src = safe; dialogBody.append(frame);
      }
      dialogHint.textContent = t("frameFailed");
      dialog.showModal();
    }
    async function download(asset = null) {
      if (!context || downloadRequest) return;
      const captured = key, controller = new AbortController(); downloadRequest = controller; downloadFailure = false; render();
      try {
        const result = await api(`/signet/history/${encodeURIComponent(context.historyId)}/stage6/assets/download`, {
          method: "POST", body: JSON.stringify({identity: context.identity, ...(context.revision ? {revision: context.revision} : {}), ...(asset ? {asset} : {})}), signal: controller.signal,
        });
        if (captured !== key || controller.signal.aborted) return;
        const url = safeURL(result.url, "/stage6/result-download?ticket=");
        if (!url || !/^\?ticket=[A-Za-z0-9_-]{32}$/.test(new URL(url).search)) throw Error("Invalid download URL");
        const link = node("a"); link.href = url; link.download = asset || "SIGNET-stage6.zip"; link.rel = "noreferrer";
        doc.body.append(link); link.click(); link.remove();
      } catch (error) { if (!controller.signal.aborted && captured === key) downloadFailure = true; }
      finally { if (downloadRequest === controller) { downloadRequest = null; render(); } }
    }
    async function load() {
      if (!context || loading) return;
      request?.abort(); const controller = new AbortController(), captured = key; request = controller;
      loading = true; failure = false; render();
      try {
        const value = await api(`/signet/history/${encodeURIComponent(context.historyId)}/stage6/assets?identity=${encodeURIComponent(context.identity)}${context.revision ? `&revision=${encodeURIComponent(context.revision)}` : ""}`, {signal: controller.signal});
        if (captured !== key || controller.signal.aborted) return;
        if (value.history_id !== context.historyId || value.identity !== context.identity || value.source !== context.source || value.run_id !== context.runId || (context.revision && value.revision !== context.revision)) throw Error("Result source changed");
        data = value;
      } catch (error) { if (!controller.signal.aborted && captured === key) { failure = true; data = null; } }
      finally { if (request === controller) { request = null; loading = false; render(); } }
    }
    function render() {
      summary.textContent = t("title"); close.textContent = t("close");
      panel.hidden = !context;
      content.replaceChildren();
      if (!context) return;
      if (loading) { content.append(node("p", "s6-original-note", t("loading"))); return; }
      if (failure) content.append(node("p", "s6-original-note", t("failed")));
      if (!data) { if (failure) content.append(button(t("refresh"), load)); return; }
      const previews = Array.isArray(data.previews) ? data.previews : [];
      if (previews.length) {
        const label = node("label", "s6-original-select", t("subnetwork")); const select = node("select");
        for (const preview of previews) { const option = node("option", "", `${t("subnetwork")} ${preview.subnetwork}`); option.value = String(preview.subnetwork); select.append(option); }
        if (!previews.some(value => value.subnetwork === selected)) selected = previews[0].subnetwork;
        select.value = String(selected); select.addEventListener("change", () => { selected = Number(select.value); }); label.append(select);
        content.append(label, button(t("open"), () => { const preview = previews.find(value => value.subnetwork === selected); if (preview) showPreview(preview.url, `${t("graph")} · ${selected}`); }));
      } else content.append(node("p", "s6-original-note", t("missingGraph")));
      for (const plot of Array.isArray(data.plots) ? data.plots : []) {
        const card = node("div", "s6-original-plot"), title = `${t(plot.kind)}${plot.subnetwork ? ` · ${plot.subnetwork}` : ""}`;
        card.append(node("strong", "", title));
        const url = safeURL(plot.url, "/stage6/result-preview/");
        if (url) {
          const preview = button("", () => showPreview(plot.url, title, true));
          const img = node("img"); img.src = url; img.alt = title; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; preview.append(img); card.append(preview);
        } else card.append(node("p", "s6-original-note", t("pdfOnly")));
        if (typeof plot.pdf === "string") { const pdf = button(t("pdf"), () => download(plot.pdf)); pdf.disabled = Boolean(downloadRequest); card.append(pdf); }
        content.append(card);
      }
      if (Array.isArray(data.thresholds) && data.thresholds.length) {
        const table = node("table", "s6-cutoff-counts"), caption = node("caption", "", t("count_vs_freq"));
        const head = node("thead"), row = node("tr");
        for (const name of ["cutoff", "genes", "edges"]) { const th = node("th", "", t(name)); th.scope = "col"; row.append(th); }
        head.append(row); table.append(caption, head); const body = node("tbody");
        for (const count of data.thresholds) { const tr = node("tr"); for (const value of [count.cutoff, count.genes, count.connections]) tr.append(node("td", "", String(value))); body.append(tr); }
        table.append(body); content.append(table);
      } else content.append(node("p", "s6-original-note", t("missingCounts")));
      if (!previews.length && !data.plots?.length && !data.download_available) content.append(node("p", "s6-original-note", t("unavailable")));
      if (downloadFailure) content.append(node("p", "s6-original-note", t("downloadFailed")));
      const actions = node("div", "s6-original-actions");
      if (data.download_available) { const zip = button(t("download"), () => download()); zip.disabled = Boolean(downloadRequest); actions.append(zip); }
      actions.append(button(t("refresh"), load)); content.append(actions);
    }
    panel.addEventListener("toggle", () => { if (panel.open && !data && !loading) void load(); });

    // Filtering and DOM sorting operate on the current gene-selected rows only.
    // A graph selection replaces tbody; the observer then reapplies the controls.
    const dock = stage.querySelector(".ml-result-dock"), tbody = dock?.querySelector("tbody");
    const tools = node("div", "s6-table-tools"), search = node("input"), sort = node("select"), count = node("span");
    search.type = "search"; search.autocomplete = "off"; search.spellcheck = false;
    const order = ["original", "source", "target", "frequency", "coefficient"];
    for (const value of order) { const option = node("option"); option.value = value; sort.append(option); }
    tools.append(search, sort, count); if (tbody) dock.querySelector(".ml-result-table").before(tools);
    const rowOrder = new WeakMap(); let nextOrder = 0;
    const observeRows = () => { if (tbody) rowsObserver.observe(tbody, {childList: true}); };
    function filterRows() {
      if (!tbody) return;
      rowsObserver.disconnect();
      const rows = [...tbody.rows], query = search.value.trim().toLocaleLowerCase();
      rows.forEach(row => { if (!rowOrder.has(row)) rowOrder.set(row, nextOrder++); row.hidden = !row.textContent.toLocaleLowerCase().includes(query); });
      const index = {source: 0, target: 1, frequency: 2, coefficient: 3}[sort.value];
      rows.sort((a, b) => {
        let result = 0;
        if (sort.value === "original") return rowOrder.get(a) - rowOrder.get(b);
        if (index < 2) result = a.cells[index].textContent.localeCompare(b.cells[index].textContent);
        else { const aValue = Number(a.cells[index].textContent), bValue = Number(b.cells[index].textContent); result = sort.value === "coefficient" ? Math.abs(bValue) - Math.abs(aValue) : bValue - aValue; }
        return result || rowOrder.get(a) - rowOrder.get(b);
      });
      tbody.append(...rows); count.textContent = `${rows.filter(row => !row.hidden).length}/${rows.length}`; count.setAttribute("aria-label", t("rows"));
      observeRows();
    }
    const rowsObserver = new MutationObserver(filterRows); observeRows();
    search.addEventListener("input", filterRows); sort.addEventListener("change", filterRows);
    function translate() {
      render(); search.placeholder = t("search"); search.setAttribute("aria-label", t("search")); sort.setAttribute("aria-label", t("sort"));
      [...sort.options].forEach((option, index) => option.textContent = t(order[index])); filterRows();
    }
    const langObserver = new MutationObserver(translate); langObserver.observe(languageRoot, {attributes: true, attributeFilter: ["lang"]});
    const hiddenObserver = new MutationObserver(() => { if (stage.hidden && dialog.open) dialog.close(); });
    hiddenObserver.observe(stage, {attributes: true, attributeFilter: ["hidden"]});
    translate();
    function clear() {
      request?.abort(); downloadRequest?.abort(); request = null; downloadRequest = null; loading = false;
      context = null; key = ""; data = null; failure = false; downloadFailure = false;
      if (dialog.open) dialog.close(); else stopPreview(); render();
    }
    return {
      setContext(value) {
        if (!value?.historyId || !value.identity || !value.source || !value.runId) { clear(); return; }
        const next = contextKey(value); if (next === key) return;
        clear(); context = {...value}; key = next; selected = 1; search.value = ""; sort.value = "original"; filterRows(); render();
        if (panel.open) void load();
      }, clear,
      destroy() { clear(); rowsObserver.disconnect(); langObserver.disconnect(); hiddenObserver.disconnect(); panel.remove(); dialog.remove(); tools.remove(); },
    };
  };
})();
