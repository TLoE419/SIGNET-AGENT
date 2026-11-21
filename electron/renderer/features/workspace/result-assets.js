/* Optional original exports. The custom graph remains the selection authority. */
(() => {
  "use strict";
  const labels = {
    title: "Original analysis results", loading: "Loading original results…",
    unavailable: "No original preview exports were retained for this run.",
    failed: "Original exports are unavailable. Refresh to try again.",
    refresh: "Refresh", graph: "Original interactive network",
    open: "View original network", subnetwork: "Subnetwork",
    missingGraph: "The original interactive network was not retained.",
    download: "Download original results ZIP", pdf: "Download original PDF",
    pdfOnly: "No image preview was retained; the original PDF is available.",
    circular: "Circular network", enrichment_hist: "Enrichment histogram",
    enrichment_radar: "Enrichment radar", count_vs_freq: "Counts by frequency cutoff",
    missingCounts: "The original frequency matrix was not retained; cutoff counts are unavailable.",
    cutoff: "Cutoff", genes: "Genes", edges: "Connections",
    count: "Count", frequencyCutoff: "Bootstrap frequency cutoff",
    close: "Close original preview", search: "Search connections",
    sort: "Sort connections", original: "Original order",
    source: "Source gene A–Z", target: "Target gene A–Z",
    frequency: "Frequency, high to low", coefficient: "Absolute coefficient, high to low",
    rows: "Connections shown", downloadFailed: "Could not create the download link. Try again.",
    frameFailed: "If the preview cannot load, close it and refresh original results.",
  };
  window.mountStage6Assets = ({stage, token}) => {
    if (!stage || stage.querySelector(".s6-original-results")) return null;
    const doc = stage.ownerDocument;
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
    const cutoffSeries = values => {
      if (!Array.isArray(values) || values.length < 2 || values.length > 32 || values.some(value =>
        typeof value?.cutoff !== "number" || !Number.isFinite(value.cutoff) || value.cutoff < 0 || value.cutoff > 1 ||
        ![value.genes, value.connections].every(count => Number.isSafeInteger(count) && count >= 0)) ||
        new Set(values.map(value => value.cutoff)).size !== values.length) return null;
      return [...values].sort((a, b) => a.cutoff - b.cutoff);
    };
    function cutoffChart(values) {
      const figure = node("figure", "s6-cutoff-chart"), caption = node("figcaption", "", labels.count_vs_freq);
      const svg = (tag, attributes = {}, text) => {
        const element = doc.createElementNS("http://www.w3.org/2000/svg", tag);
        for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
        if (text != null) element.textContent = text;
        return element;
      };
      const chart = svg("svg", {viewBox: "0 0 260 165", role: "img", "aria-label": labels.count_vs_freq});
      const format = value => new Intl.NumberFormat("en", {maximumFractionDigits: 3}).format(value);
      const axisCount = value => value >= 1000 ? new Intl.NumberFormat("en", {notation: "compact", maximumFractionDigits: 1}).format(value) : format(value);
      chart.append(svg("title", {}, labels.count_vs_freq), svg("desc", {}, values.map(value =>
        `${labels.cutoff} ${format(value.cutoff)}: ${labels.genes} ${format(value.genes)}, ${labels.edges} ${format(value.connections)}`).join("; ")));
      const left = 40, right = 246, top = 16, bottom = 116;
      const minimum = values[0].cutoff, maximum = values[values.length - 1].cutoff;
      const highest = Math.max(...values.flatMap(value => [value.genes, value.connections]));
      const x = value => left + (value - minimum) / (maximum - minimum) * (right - left);
      const y = value => bottom - value / (highest || 1) * (bottom - top);
      for (const value of new Set([0, Math.round(highest / 2), highest])) {
        chart.append(svg("line", {x1: left, x2: right, y1: y(value), y2: y(value), class: "s6-cutoff-grid"}),
          svg("text", {x: left - 6, y: y(value) + 3, "text-anchor": "end"}, axisCount(value)));
      }
      chart.append(svg("path", {d: `M${left} ${top}V${bottom}H${right}`, class: "s6-cutoff-axis"}));
      for (const value of values) chart.append(svg("text", {x: x(value.cutoff), y: bottom + 16, "text-anchor": "middle"}, format(value.cutoff)));
      chart.append(svg("text", {x: (left + right) / 2, y: 155, "text-anchor": "middle", class: "s6-cutoff-axis-title"}, labels.frequencyCutoff),
        svg("text", {x: 11, y: (top + bottom) / 2, transform: `rotate(-90 11 ${(top + bottom) / 2})`, "text-anchor": "middle", class: "s6-cutoff-axis-title"}, labels.count));
      const legend = node("div", "s6-cutoff-legend");
      for (const [key, label] of [["genes", "genes"], ["connections", "edges"]]) {
        chart.append(svg("path", {d: values.map((value, index) => `${index ? "L" : "M"}${x(value.cutoff)} ${y(value[key])}`).join(" "), class: "s6-cutoff-line", "data-series": key}));
        for (const value of values) {
          const point = svg("circle", {cx: x(value.cutoff), cy: y(value[key]), r: 2.7, class: "s6-cutoff-point", "data-series": key, "data-cutoff": value.cutoff, "data-count": value[key]});
          point.append(svg("title", {}, `${labels.cutoff} ${format(value.cutoff)} · ${labels[label]} ${format(value[key])}`)); chart.append(point);
        }
        const item = node("span", "", labels[label]); item.dataset.series = key; legend.append(item);
      }
      figure.append(caption, chart, legend); return figure;
    }
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
      dialogHint.textContent = labels.frameFailed;
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
      summary.textContent = labels.title; close.textContent = labels.close;
      panel.hidden = !context;
      content.replaceChildren();
      if (!context) return;
      if (loading) { content.append(node("p", "s6-original-note", labels.loading)); return; }
      if (failure) content.append(node("p", "s6-original-note", labels.failed));
      if (!data) { if (failure) content.append(button(labels.refresh, load)); return; }
      const previews = Array.isArray(data.previews) ? data.previews : [];
      if (previews.length) {
        const label = node("label", "s6-original-select", labels.subnetwork); const select = node("select");
        for (const preview of previews) { const option = node("option", "", `${labels.subnetwork} ${preview.subnetwork}`); option.value = String(preview.subnetwork); select.append(option); }
        if (!previews.some(value => value.subnetwork === selected)) selected = previews[0].subnetwork;
        select.value = String(selected); select.addEventListener("change", () => { selected = Number(select.value); }); label.append(select);
        content.append(label, button(labels.open, () => { const preview = previews.find(value => value.subnetwork === selected); if (preview) showPreview(preview.url, `${labels.graph} · ${selected}`); }));
      } else content.append(node("p", "s6-original-note", labels.missingGraph));
      for (const plot of Array.isArray(data.plots) ? data.plots : []) {
        const card = node("div", "s6-original-plot"), title = `${labels[plot.kind] ?? plot.kind}${plot.subnetwork ? ` · ${plot.subnetwork}` : ""}`;
        card.append(node("strong", "", title));
        const url = safeURL(plot.url, "/stage6/result-preview/");
        if (url) {
          const preview = button("", () => showPreview(plot.url, title, true));
          const img = node("img"); img.src = url; img.alt = title; img.loading = "lazy"; img.referrerPolicy = "no-referrer"; preview.append(img); card.append(preview);
        } else card.append(node("p", "s6-original-note", labels.pdfOnly));
        if (typeof plot.pdf === "string") { const pdf = button(labels.pdf, () => download(plot.pdf)); pdf.disabled = Boolean(downloadRequest); card.append(pdf); }
        content.append(card);
      }
      const thresholds = cutoffSeries(data.thresholds);
      if (thresholds) {
        content.append(cutoffChart(thresholds));
        const table = node("table", "s6-cutoff-counts"), caption = node("caption", "", labels.count_vs_freq);
        const head = node("thead"), row = node("tr");
        for (const name of ["cutoff", "genes", "edges"]) { const th = node("th", "", labels[name]); th.scope = "col"; row.append(th); }
        head.append(row); table.append(caption, head); const body = node("tbody");
        for (const count of thresholds) { const tr = node("tr"); for (const value of [count.cutoff, count.genes, count.connections]) tr.append(node("td", "", String(value))); body.append(tr); }
        table.append(body); content.append(table);
      } else content.append(node("p", "s6-original-note", labels.missingCounts));
      if (!previews.length && !data.plots?.length && !data.download_available) content.append(node("p", "s6-original-note", labels.unavailable));
      if (downloadFailure) content.append(node("p", "s6-original-note", labels.downloadFailed));
      const actions = node("div", "s6-original-actions");
      if (data.download_available) { const zip = button(labels.download, () => download()); zip.disabled = Boolean(downloadRequest); actions.append(zip); }
      actions.append(button(labels.refresh, load)); content.append(actions);
    }
    panel.addEventListener("toggle", () => { if (panel.open && !data && !loading) void load(); });

    // Filtering and DOM sorting operate on the current gene-selected rows only.
    // A graph selection replaces tbody; the observer then reapplies the controls.
    const dock = stage.querySelector(".ml-result-dock"), tbody = dock?.querySelector("tbody");
    const tools = node("div", "s6-table-tools"), search = node("input"), sort = node("select"), count = node("span");
    search.type = "search"; search.autocomplete = "off"; search.spellcheck = false;
    const order = ["original", "source", "target", "frequency", "coefficient"];
    for (const value of order) { const option = node("option", "", labels[value]); option.value = value; sort.append(option); }
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
      tbody.append(...rows); count.textContent = `${rows.filter(row => !row.hidden).length}/${rows.length}`; count.setAttribute("aria-label", labels.rows);
      observeRows();
    }
    const rowsObserver = new MutationObserver(filterRows); observeRows();
    search.addEventListener("input", filterRows); sort.addEventListener("change", filterRows);
    search.placeholder = labels.search;
    search.setAttribute("aria-label", labels.search);
    sort.setAttribute("aria-label", labels.sort);
    const hiddenObserver = new MutationObserver(() => { if (stage.hidden && dialog.open) dialog.close(); });
    hiddenObserver.observe(stage, {attributes: true, attributeFilter: ["hidden"]});
    render(); filterRows();
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
      destroy() { clear(); rowsObserver.disconnect(); hiddenObserver.disconnect(); panel.remove(); dialog.remove(); tools.remove(); },
    };
  };
})();
