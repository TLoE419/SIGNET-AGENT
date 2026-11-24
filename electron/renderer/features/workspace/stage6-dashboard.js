/* SIGNET's Shiny dashboard (script/netvis/ui.R and server.R), drawn from the
 * objects Stage 6 exports on HPC3. Layout, labels and chart rules follow the
 * original; figures SIGNET may skip are replaced by the reason they are absent. */
(() => {
  "use strict";
  const SVG = "http://www.w3.org/2000/svg";
  const t = {
    tabs: {summary: "Network Summary", enrichment: "Enrichment Analysis", circular: "Circular Plot"},
    topNodes: "Top Nodes", topNodesHelp: "Node with the largest degrees in the network",
    topEdges: "Top Edges", geneName: "Gene name", degree: "Degree", subnetworkNumber: "Subnetwork number:",
    chooseSubnetwork: "Choose subnetwork by size:", geneList: "Choose a text file of gene list",
    clearGenes: "Clear gene list", criterion: "Choose a criterion for clustering",
    byEnrichment: "Cluster by enrichment", byModularity: "Cluster by modularity",
    txtOnly: "Please upload a .txt file",
    pathwayTitle: "Enrichment by p values", logP: "-log p value", noEnrichment: "No enrichment detected",
    noEnrichmentWhy: "STRING found no significant Gene Ontology Process term for this subnetwork, so there is no pathway to chart.",
    noTerms: "No gene in this subnetwork has an enrichment term, so “Select by enrichment” has no choices. Cluster by modularity still groups the genes.",
    circularTitle: "Circular Plot", tableTitle: "Nodes and regulation information summary",
    originalFigures: "Other SIGNET figures for this subnetwork",
    enrichment_radar: "Enrichment radar (KEGG)", enrichment_hist: "Enrichment histogram (Process)",
    pdf: "Download original PDF", pdfOnly: "No image preview was retained; the original PDF is available.",
    search: "Search:", previous: "Previous", next: "Next", noRows: "No matching records",
    network: "Interactive network", networkMissing: "The dashboard network was not exported for this subnetwork.",
    reasons: {
      not_exported: "This run's Stage 6 finished before the dashboard export was added. Rerun Stage 6 to create the dashboard data.",
      export_failed: "SIGNET's dashboard data could not be exported on HPC3",
      invalid: "The saved dashboard data cannot be read. Rerun Stage 6 to recreate it.",
    },
    cutoffs: "Counts by frequency cutoff",
  };
  const FIGURES = ["enrichment_radar", "enrichment_hist"];

  // R's hsv() and heat.colors(), which server.R uses for both plotly bar charts.
  function hsv(h, s, v, alpha) {
    const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
    const p = v * (1 - s), q = v * (1 - f * s), w = v * (1 - (1 - f) * s);
    const [r, g, b] = [[v, w, p], [q, v, p], [p, v, w], [p, q, v], [w, p, v], [v, p, q]][i];
    return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;
  }
  function heatColors(n, alpha) {
    if (n <= 0) return [];
    const j = Math.floor(n / 4), i = n - j, colors = [];
    for (let k = 0; k < i; k++) colors.push(hsv(i > 1 ? k / (i - 1) / 6 : 0, 1, 1, alpha));
    for (let k = 0; k < j; k++) {
      const from = 1 - 1 / (2 * j), to = 1 / (2 * j);
      colors.push(hsv(1 / 6, j > 1 ? from + (to - from) * k / (j - 1) : from, 1, alpha));
    }
    return colors;
  }
  const sample = (palette, count) => Array.from({length: count}, (_, k) =>
    palette[count > 1 ? Math.round(k * (palette.length - 1) / (count - 1)) : 0]);
  const format = value => typeof value === "number" ? String(Number(value.toPrecision(6))) : String(value ?? "");

  window.mountStage6Dashboard = ({doc, body, data, thresholds, safeURL, download, downloading, state}) => {
    const node = (tag, cls, text) => {
      const element = doc.createElement(tag);
      if (cls) element.className = cls;
      if (text != null) element.textContent = text;
      return element;
    };
    const svg = (tag, attributes = {}, text) => {
      const element = doc.createElementNS(SVG, tag);
      for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
      if (text != null) element.textContent = text;
      return element;
    };
    const button = (text, action) => {
      const element = node("button", "", text); element.type = "button";
      element.addEventListener("click", action); return element;
    };
    const note = text => node("p", "s6-original-note", text);
    const dashboard = data.dashboard ?? {available: false, reason: {code: "not_exported"}, subnetworks: []};
    const subnetworks = Array.isArray(dashboard.subnetworks) ? dashboard.subnetworks : [];
    const plots = Array.isArray(data.plots) ? data.plots : [];
    const plot = (kind, number) => plots.find(value => value.kind === kind && value.subnetwork === number);
    const reason = () => {
      const code = dashboard.reason?.code;
      const base = t.reasons[code] ?? t.reasons.invalid;
      return code === "export_failed" && dashboard.reason.detail ? `${base}: ${dashboard.reason.detail}` : base;
    };
    const cleanups = [];

    function dataTable(columns, rows, caption) {
      const wrap = node("div", "s6-dt"), tools = node("label", "s6-dt-search", t.search), search = node("input");
      search.type = "search"; search.autocomplete = "off"; search.spellcheck = false; tools.append(search);
      const table = node("table"), head = node("thead"), headRow = node("tr"), tbody = node("tbody");
      if (caption) table.append(node("caption", "", caption));
      const footer = node("div", "s6-dt-footer"), info = node("span"), pager = node("span");
      const previous = button(t.previous, () => { view.page--; draw(); }), next = button(t.next, () => { view.page++; draw(); });
      pager.append(previous, next); footer.append(info, pager);
      const indexed = rows.map((row, index) => [index + 1, ...row]);
      const view = {query: "", column: null, descending: false, page: 0};
      ["", ...columns].forEach((name, column) => {
        const th = node("th", "", name); th.scope = "col";
        if (column) {
          th.tabIndex = 0; th.setAttribute("aria-sort", "none");
          const sort = () => {
            view.descending = view.column === column ? !view.descending : false; view.column = column; view.page = 0;
            for (const cell of headRow.cells) cell.setAttribute("aria-sort", "none");
            th.setAttribute("aria-sort", view.descending ? "descending" : "ascending"); draw();
          };
          th.addEventListener("click", sort);
          th.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); sort(); } });
        }
        headRow.append(th);
      });
      head.append(headRow); table.append(head, tbody);
      function draw() {
        const query = view.query.trim().toLocaleLowerCase();
        let shown = query ? indexed.filter(row => row.slice(1).some(cell => format(cell).toLocaleLowerCase().includes(query))) : [...indexed];
        if (view.column !== null) {
          const c = view.column;
          shown.sort((a, b) => {
            const result = typeof a[c] === "number" && typeof b[c] === "number" ? a[c] - b[c] : format(a[c]).localeCompare(format(b[c]));
            return (view.descending ? -result : result) || a[0] - b[0];
          });
        }
        const pages = Math.max(1, Math.ceil(shown.length / 20));
        view.page = Math.min(Math.max(view.page, 0), pages - 1);
        const start = view.page * 20, page = shown.slice(start, start + 20);
        tbody.replaceChildren(...(page.length ? page.map(row => {
          const tr = node("tr"); for (const cell of row) tr.append(node("td", "", format(cell))); return tr;
        }) : [(() => { const tr = node("tr"), td = node("td", "", t.noRows); td.colSpan = columns.length + 1; tr.append(td); return tr; })()]));
        info.textContent = shown.length ? `Showing ${start + 1} to ${start + page.length} of ${shown.length} entries` +
          (shown.length !== indexed.length ? ` (filtered from ${indexed.length} total entries)` : "") : `Showing 0 to 0 of 0 entries`;
        previous.disabled = view.page === 0; next.disabled = view.page >= pages - 1;
      }
      search.addEventListener("input", () => { view.query = search.value; view.page = 0; draw(); });
      const scroller = node("div", "s6-dt-scroll"); scroller.append(table);
      wrap.append(tools, scroller, footer); draw(); return wrap;
    }

    // server.R output$top_nodes: the 50 largest degrees, coloured by rev(heat.colors()).
    function topNodesChart(rows) {
      const n = rows.length, levels = rows.map((row, index) => index).sort((a, b) => rows[a].degree - rows[b].degree || a - b);
      const colors = heatColors(n, 0.4).reverse(), rowHeight = 16, left = 112, right = 548, top = 6;
      const height = top + n * rowHeight + 8, highest = Math.max(1, ...rows.map(row => row.degree));
      const chart = svg("svg", {viewBox: `0 0 560 ${height}`, role: "img", "aria-label": t.topNodes, class: "s6-dash-chart"});
      chart.append(svg("text", {x: 10, y: top + n * rowHeight / 2, transform: `rotate(-90 10 ${top + n * rowHeight / 2})`, "text-anchor": "middle", class: "s6-dash-axis-title"}, t.geneName));
      // plotly draws the first factor level at the bottom, so the largest degree is on top.
      [...levels].reverse().forEach((rowIndex, position) => {
        const row = rows[rowIndex], level = levels.indexOf(rowIndex), y = top + position * rowHeight;
        const group = svg("g", {class: "s6-dash-bar"});
        group.append(svg("title", {}, `${row.gene}\n${t.degree}: ${row.degree}\n${t.subnetworkNumber}${row.subnetwork ?? "NA"}`),
          svg("text", {x: left - 6, y: y + rowHeight * .68, "text-anchor": "end"}, row.gene),
          svg("rect", {x: left, y: y + 2, width: Math.max(1, (right - left) * row.degree / highest), height: rowHeight - 4, fill: colors[level]}));
        chart.append(group);
      });
      return chart;
    }

    // server.R output$pathway: -log10 p by term, ordered by p value, hover lists the related genes.
    function pathwayChart(rows) {
      const figure = node("figure", "s6-dash-pathway");
      if (!rows.length) {
        figure.append(node("strong", "", t.noEnrichment), note(t.noEnrichmentWhy)); return figure;
      }
      const values = rows.map(row => -Math.log10(row.p_value)), highest = Math.max(...values, 1e-9);
      const colors = sample(heatColors(30, 0.4), rows.length), left = 52, right = 548, top = 34, bottom = 250;
      const chart = svg("svg", {viewBox: "0 0 560 270", role: "img", "aria-label": t.pathwayTitle, class: "s6-dash-chart"});
      chart.append(svg("rect", {x: 0, y: 0, width: 560, height: 270, fill: "rgb(239, 242, 247)"}),
        svg("text", {x: 280, y: 20, "text-anchor": "middle", class: "s6-dash-title"}, t.pathwayTitle),
        svg("text", {x: 14, y: (top + bottom) / 2, transform: `rotate(-90 14 ${(top + bottom) / 2})`, "text-anchor": "middle", class: "s6-dash-axis-title"}, t.logP));
      for (let k = 0; k <= 4; k++) {
        const value = highest * k / 4, y = bottom - (bottom - top) * k / 4;
        chart.append(svg("line", {x1: left, x2: right, y1: y, y2: y, class: "s6-cutoff-grid"}),
          svg("text", {x: left - 5, y: y + 3, "text-anchor": "end"}, format(Number(value.toFixed(2)))));
      }
      const slot = (right - left) / rows.length;
      rows.forEach((row, index) => {
        const height = (bottom - top) * values[index] / highest, group = svg("g", {class: "s6-dash-bar"});
        group.append(svg("title", {}, `${row.description}\n${t.logP}: ${format(values[index])}\n${row.text}`),
          svg("rect", {x: left + index * slot + slot * .1, y: bottom - height, width: slot * .8, height, fill: colors[index]}));
        chart.append(group);
      });
      figure.append(chart); return figure;
    }

    function figureCard(kind, number, title, missing) {
      const card = node("div", "s6-original-plot"), value = plot(kind, number);
      if (kind !== "circular") card.append(node("strong", "", title));
      const url = safeURL(value?.url, "/stage6/result-preview/");
      if (url) { const img = node("img"); img.src = url; img.alt = title; img.referrerPolicy = "no-referrer"; card.append(img); }
      else if (value) card.append(note(t.pdfOnly));
      else card.append(note(missingText(missing)));
      if (typeof value?.pdf === "string") { const pdf = button(t.pdf, () => download(value.pdf)); pdf.disabled = downloading; card.append(pdf); }
      return card;
    }
    function missingText(missing) {
      if (!missing) return "SIGNET did not produce this figure.";
      const what = missing.category === "KEGG" ? "KEGG radar" : missing.category === "Process" ? "Process histogram" : "figure";
      if (missing.code === "too_few") return `Not drawn: SIGNET draws the ${what} only with at least ${missing.minimum} enriched terms; STRING found ${missing.count || "none"} for this subnetwork.`;
      if (missing.code === "not_recorded") return `Not drawn, and the ${missing.category} term list was not saved, so the reason cannot be shown.`;
      if (missing.code === "missing" && missing.category) return `STRING found ${missing.count} ${missing.category} terms, but the figure file is missing. Check the Stage 6 log.`;
      return "The figure file is missing from this run. Check the Stage 6 log.";
    }
    function subnetworkSelect(key) {
      const label = node("label", "s6-dash-field", t.chooseSubnetwork), select = node("select");
      for (const entry of subnetworks) { const option = node("option", "", String(entry.number)); option.value = String(entry.number); select.append(option); }
      if (!subnetworks.some(entry => entry.number === state[key])) state[key] = subnetworks[0]?.number ?? 1;
      select.value = String(state[key]);
      select.addEventListener("change", () => { state[key] = Number(select.value); if (key === "enrichmentSubnetwork") state.genes = null; render(); });
      label.append(select); return label;
    }

    function summaryPanel() {
      const panel = node("div", "s6-dash-panel");
      if (dashboard.available && dashboard.summary) {
        const {subnetworks: count, genes, edges} = dashboard.summary, heading = node("h3", "s6-dash-headline");
        heading.append("There are a total of ", node("b", "", String(count)), " subnetworks with ", node("b", "", String(genes)),
          " genes and ", node("b", "", String(edges)), " regulation effects in the network");
        const row = node("div", "s6-dash-row");
        const nodes = node("section", "s6-dash-box"); nodes.append(node("h4", "", t.topNodes),
          dashboard.top_nodes.length ? topNodesChart(dashboard.top_nodes) : note("No node was exported."), note(t.topNodesHelp));
        const edgesBox = node("section", "s6-dash-box"); edgesBox.append(node("h4", "", t.topEdges),
          dataTable(["Protein 1", "Protein 2", "Combined Score"], dashboard.ppi.map(row => [row.protein1, row.protein2, row.score])));
        row.append(nodes, edgesBox); panel.append(heading, row);
      } else panel.append(note(reason()));
      const cutoff = node("section", "s6-dash-box"); cutoff.append(node("h4", "", t.cutoffs));
      const original = plot("count_vs_freq", null), url = safeURL(original?.url, "/stage6/result-preview/");
      if (url) { const img = node("img"); img.src = url; img.alt = t.cutoffs; img.referrerPolicy = "no-referrer"; cutoff.append(img); }
      cutoff.append(thresholds()); panel.append(cutoff);
      return panel;
    }

    function enrichmentPanel() {
      const panel = node("div", "s6-dash-panel s6-dash-sidebar-layout");
      const entry = subnetworks.find(value => value.number === state.enrichmentSubnetwork) ?? subnetworks[0];
      const side = node("aside", "s6-dash-controls");
      side.append(subnetworkSelect("enrichmentSubnetwork"), node("hr"));
      const fileLabel = node("label", "s6-dash-field s6-dash-file", t.geneList), file = node("input"), status = node("p", "s6-original-note");
      file.type = "file"; file.accept = ".txt"; fileLabel.append(file);
      const clear = button(t.clearGenes, () => { state.genes = null; state.geneStatus = ""; render(); });
      if (state.geneStatus) status.textContent = state.geneStatus;
      file.addEventListener("change", async () => {
        const chosen = file.files?.[0]; if (!chosen) return;
        if (!/\.txt$/i.test(chosen.name)) { state.genes = null; state.geneStatus = t.txtOnly; render(); return; }
        const genes = [...new Set((await chosen.text()).split(/\s+/).filter(Boolean))].slice(0, 5000);
        state.genes = genes; state.geneStatus = `${genes.length} genes read from ${chosen.name}.`; render();
      });
      const fieldset = node("fieldset", "s6-dash-radio"); fieldset.append(node("legend", "", t.criterion));
      for (const [value, label] of [["enrichment", t.byEnrichment], ["modularity", t.byModularity]]) {
        const option = node("label"), input = node("input"); input.type = "radio"; input.name = "s6-dash-criterion"; input.value = value;
        input.checked = state.criterion === value; input.addEventListener("change", () => { state.criterion = value; render(); });
        option.append(input, label); fieldset.append(option);
      }
      side.append(fileLabel, clear, status, node("hr"), fieldset);
      const main = node("div", "s6-dash-main");
      if (entry) {
        const url = safeURL(entry.networks?.[state.criterion], "/stage6/result-preview/");
        if (state.criterion === "enrichment" && entry.enrichment_terms === false) main.append(note(t.noTerms));
        if (url) {
          const frame = node("iframe", "s6-dash-network"); frame.setAttribute("sandbox", "allow-scripts");
          frame.referrerPolicy = "no-referrer"; frame.title = `${t.network} · ${entry.number}`;
          // server.R's gene-list upload recolours the listed nodes through a visNetwork proxy.
          frame.addEventListener("load", () => { if (state.genes) frame.contentWindow?.postMessage({signetGenes: state.genes}, "*"); });
          frame.src = url; main.append(frame);
          cleanups.push(() => { frame.src = "about:blank"; });
        } else main.append(note(dashboard.available || dashboard.reason?.code !== "not_exported" ? t.networkMissing : reason()));
        if (Array.isArray(entry.pathway)) main.append(pathwayChart(entry.pathway));
        else main.append(note(reason()));
        const figures = node("section", "s6-dash-figures"); figures.append(node("h4", "", t.originalFigures));
        for (const kind of FIGURES) figures.append(figureCard(kind, entry.number, t[kind], entry.missing?.[kind]));
        main.append(figures);
      }
      panel.append(side, main); return panel;
    }

    function circularPanel() {
      const panel = node("div", "s6-dash-panel");
      const entry = subnetworks.find(value => value.number === state.circularSubnetwork) ?? subnetworks[0];
      const row = node("div", "s6-dash-row"), plotBox = node("section", "s6-dash-box"), tableBox = node("section", "s6-dash-box");
      plotBox.append(node("h4", "", t.circularTitle), subnetworkSelect("circularSubnetwork"));
      if (entry) plotBox.append(figureCard("circular", entry.number, `${t.circularTitle} · ${entry.number}`, entry.missing?.circular));
      tableBox.append(node("h4", "", t.tableTitle));
      if (entry?.table) tableBox.append(dataTable(entry.table.columns, entry.table.rows));
      else tableBox.append(note(reason()));
      row.append(plotBox, tableBox); panel.append(row); return panel;
    }

    function render() {
      for (const cleanup of cleanups.splice(0)) cleanup();
      const tabs = node("div", "s6-dash-tabs"), panel = node("div", "s6-dash-body");
      tabs.setAttribute("role", "tablist");
      for (const [key, label] of Object.entries(t.tabs)) {
        const tab = button(label, () => { state.tab = key; render(); });
        tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(state.tab === key));
        tabs.append(tab);
      }
      panel.setAttribute("role", "tabpanel");
      panel.append(state.tab === "enrichment" ? enrichmentPanel() : state.tab === "circular" ? circularPanel() : summaryPanel());
      body.replaceChildren(tabs, panel);
    }
    render();
    return {destroy() { for (const cleanup of cleanups.splice(0)) cleanup(); body.replaceChildren(); }};
  };
})();
