(() => {
  function drawStage3Scatter(panel, points, xTicks, yTicks) {
    const svg = (tag, attrs) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
      return node;
    };
    const bounds = { left: 68, right: 636, top: 18, bottom: 350 };
    const proportion = (value, ticks) => (value - ticks[0]) / (ticks.at(-1) - ticks[0]);
    const xFor = (value) => bounds.left + proportion(value, xTicks) * (bounds.right - bounds.left);
    const yFor = (value) => bounds.bottom - proportion(value, yTicks) * (bounds.bottom - bounds.top);
    const axes = panel.querySelector(".s3-axes");
    const marks = document.createDocumentFragment();
    const gridLine = (value, attrs) => svg("line", {
      ...attrs,
      class: value === 0 ? "s3-grid-line s3-zero" : "s3-grid-line",
    });
    const format = (value) => Number(value.toPrecision(4));

    axes.replaceChildren();
    for (const value of xTicks) {
      const x = xFor(value);
      const tick = svg("text", { x, y: bounds.bottom + 19, "text-anchor": "middle" });
      tick.textContent = format(value);
      axes.append(gridLine(value, { x1: x, x2: x, y1: bounds.top, y2: bounds.bottom }), tick);
    }
    for (const value of yTicks) {
      const y = yFor(value);
      const tick = svg("text", { x: bounds.left - 9, y: y + 4, "text-anchor": "end" });
      tick.textContent = format(value);
      axes.append(gridLine(value, { x1: bounds.left, x2: bounds.right, y1: y, y2: y }), tick);
    }
    for (const [x, y] of points) {
      const tooltip = `PC1: ${format(x)} · PC2: ${format(y)}`;
      marks.append(svg("circle", {
        cx: xFor(x).toFixed(2),
        cy: yFor(y).toFixed(2),
        r: 2.6,
        "data-tooltip": tooltip,
      }));
    }
    panel.querySelector(".s3-points").replaceChildren(marks);
  }

  const exampleStage3 = document.getElementById("lens-stage3");
  const examplePoints = JSON.parse(exampleStage3.querySelector("[data-stage3-points]").textContent);
  drawStage3Scatter(exampleStage3, examplePoints, [-3, 0, 3, 6, 9, 12], [-6, -3, 0, 3, 6]);

  const root = document.getElementById("signet-lens-left-preview");
  const app = root.querySelector(".ml-app");

  const byId = (id) => root.querySelector("#ml-" + id);
  const inputTypes = [
    ["genotype", "Genotype data"],
    ["expression", "Gene expression data"],
    ["clinical", "Clinical data"],
  ];
  const referenceTypes = [
    ["ref", "Imputation reference panel", "reference"],
    ["gmap", "Genetic map", "genetic_map"],
    ["gtf", "Gene annotation", "annotation"],
  ];
  const savedDisplayName = name => Array.isArray(name) ? name[1] ?? name[0] : name;
  function makeDataset({id, name, folder = "", inputs = {}, default_inputs = inputs, persisted = true, references = {}}) {
    return {id, name: savedDisplayName(name), folder, inputs, defaultInputs: default_inputs, persisted, references};
  }
  const exampleDataset = {
    id: "example-chr1", name: "Chromosome 1 example",
    inputs: {genotype: ["study.ped", "study.map"]},
    persisted: false,
  };
  const emptyDataset = makeDataset({id: "", name: "No datasets yet", persisted: false});
  const datasets = [];
  let activeDataset = emptyDataset;
  let datasetRevision = 0;
  const deletedDatasetIds = new Set();
  let datasetCatalogReady = false;
  let datasetCatalogError = "";
  let resettingDatasetFile = false;
  let genotypeRun;
  let expressionRun;
  let adjustmentRun;
  let cisRun;
  let networkRun;
  let visualizationRun;
  let historyRequest = 0;
  let historyRuns = [];
  let historyState = "loading";
  let historyResult = null;
  let historyScope = "current";
  const historyKey = run => run.history_id ?? `${run.source === "live" ? "workspace" : run.source}--${run.run_id}`;
  const findHistoryRun = id => historyRuns.find(run => historyKey(run) === id);
  const canContinue = run => run?.source === "live" && run.origin === "workspace" && run.capabilities?.continue_analysis === true;
  const canReadStage = (run, stage) => run?.capabilities?.stage_results?.includes(String(stage)) === true;
  const canReadGraph = run => run?.capabilities?.stage6_graph === true;
  const runsForDataset = () => historyRuns.filter((run) => run.dataset_id === activeDataset.id);
  const matchingHistoryRuns = () => historyRuns.filter(run => historyScope === "all" ||
    (historyScope === "unclassified" ? !run.dataset_id : run.dataset_id === activeDataset.id));
  const selectedHistoryResult = () => findHistoryRun(historyResult?.historyId);
  const savedAnalysisView = () => ["analysis", "settings"].includes(app.dataset.nav) && historyResult?.view === "analysis" &&
    historyResult.historyId === analysisRunByDataset.get(activeDataset.id);
  const stage6RunsForDataset = () => runsForDataset().filter(canReadGraph);
  const stage6RunsForView = () => app.dataset.nav === "history" ? matchingHistoryRuns().filter(canReadGraph) : stage6RunsForDataset();

  // Read current state synchronously at send time; never cache it on a chat/session.
  window.addEventListener("workspace-context-request", event => {
    if (!datasetCatalogReady || !["analysis", "history"].includes(app.dataset.nav)) return;
    const inHistory = app.dataset.nav === "history" || savedAnalysisView();
    const stage = inHistory ? historyResult?.stage : Number(timeline.querySelector('[aria-current="step"]')?.dataset.stage);
    if (!Number.isInteger(stage) || stage < 1 || stage > 6) return;
    let run = inHistory ? selectedHistoryResult() : null;
    if (!inHistory && stage === 6) run = findHistoryRun(stage6RunSelect.value);
    if (!inHistory && stage < 6) {
      const panel = root.querySelector(`#lens-stage${stage}`);
      const key = ["genotype", "expression", "adjust", "cis", "network"][stage - 1] + "RunId";
      const runId = panel?.dataset[key];
      run = runsForDataset().find(row => row.source === "live" && row.run_id === runId);
    }
    if (run && !inHistory && run.dataset_id !== activeDataset.id) return;
    const gene = stage === 6 && analysisNetwork.dataset.historyId === (run && historyKey(run)) &&
      analysisNetwork.dataset.runState === "ready" ? analysisNetwork.dataset.selectedGene : null;
    event.detail.context = {version: 1, dataset_id: run ? run.dataset_id : activeDataset.id,
      history_id: run ? historyKey(run) : null, stage, selected_genes: gene ? [gene] : []};
  });

  async function requestDataset(path, body, method = "GET", signal) {
    const response = await fetch(path, {method, body: JSON.stringify(body), signal,
      headers: {"Content-Type": "application/json", "X-Chat-Token": chatToken}});
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error ||
      "Could not read or save the dataset.");
    return result;
  }

  function acceptSavedDataset(record) {
    if (deletedDatasetIds.has(record.id)) throw new Error("This dataset was deleted.");
    const dataset = makeDataset(record);
    const index = datasets.findIndex(({id}) => id === dataset.id);
    if (index === -1) datasets.push(dataset);
    else datasets[index] = dataset;
    if (activeDataset.id === dataset.id) activeDataset = dataset;
    datasetCatalogReady = true;
    datasetCatalogError = "";
    datasetRevision++;
    return dataset;
  }
  const tabs = [byId("agent-tab"), byId("stage-tab")];
  const agentView = byId("agent-view");
  const contextChat = byId("context-chat");
  const showContextChat = byId("context-chat-show");
  const hideContextChat = byId("context-chat-hide");
  let contextChatOpen = true;

  function selectTab(activeTab) {
    for (const tab of tabs) {
      const active = tab === activeTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      root.querySelector("#" + tab.getAttribute("aria-controls")).hidden = !active;
    }
    if (genotypeRun) renderRunTimeline();
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const targets = {
        ArrowLeft: tabs.find((candidate) => candidate !== tab),
        ArrowRight: tabs.find((candidate) => candidate !== tab),
        Home: tabs[0],
        End: tabs[1],
      };
      const target = targets[event.key];
      if (!target) return;
      event.preventDefault();
      selectTab(target);
      target.focus();
    });
  }

  const pathTemplate = byId("selected-file-path-template");

  function renderFilePath(file, {includeFilename = false} = {}) {
    const location = pathTemplate.content.firstElementChild.cloneNode(true);
    const nameStart = file.lastIndexOf("/") + 1;
    const name = file.slice(nameStart) || file;
    const directory = file.slice(0, nameStart - 1) || "/";
    const lastFolder = Math.max(0, directory.lastIndexOf("/"));
    const displayPath = includeFilename ? file : directory;
    location.querySelector(".ml-file-directory-prefix").textContent = displayPath.slice(0, lastFolder);
    location.querySelector(".ml-file-directory-tail bdi").textContent = displayPath.slice(lastFolder);
    const trigger = location.querySelector("[data-show-file-path]");
    const panel = location.querySelector("[data-file-path-panel]");
    const status = panel.querySelector("[data-file-path-status]");
    const label = `Full path for ${name}`;
    trigger.setAttribute("aria-label", label);
    panel.setAttribute("aria-label", label);
    trigger.popoverTargetElement = panel;
    panel.querySelector("[data-full-file-path]").textContent = file;
    panel.addEventListener("beforetoggle", () => { status.textContent = ""; });
    panel.querySelector("[data-copy-file-path]").addEventListener("click", async () => {
      try {
        await window.signetDesktop.copyFilePath(file);
        status.textContent = "Path copied.";
      } catch {
        status.textContent = "Could not copy the path. You can select and copy it above.";
      }
    });
    return location;
  }

  let inputValidation;
  const syncInputFiles = (() => {
    const template = byId("current-files-template");
    const inputs = [];
    const statuses = new Map();

    function renderInput(input) {
      const files = activeDataset.inputs[input.type] ?? [];
      const defaults = activeDataset.defaultInputs[input.type] ?? [];
      input.datasetName.textContent = activeDataset.name;
      input.paths.replaceChildren(...files.map((file) => {
        const row = document.createElement("li");
        const name = document.createElement("strong");
        name.textContent = file.split("/").at(-1) || file;
        row.append(name);
        if (name.textContent !== file) row.append(renderFilePath(file));
        return row;
      }));
      input.paths.hidden = !files.length;
      input.empty.hidden = Boolean(files.length);
      input.count.hidden = !files.length;
      input.count.textContent = (files.length === 1 ? "1 file" : `${files.length} files`);
      input.caption.textContent = files.length ? files.map((file) => file.split("/").at(-1)).join(" · ")
        : "No files selected";
      input.replaceButton.disabled = !datasetCatalogReady || !activeDataset.persisted || resettingDatasetFile;
      input.resetButton.hidden = !files.length && !defaults.length;
      input.resetButton.disabled = !datasetCatalogReady || !activeDataset.persisted || resettingDatasetFile || JSON.stringify(files) === JSON.stringify(defaults);
      input.resetButton.textContent = defaults.length ? "Use defaults"
        : "Clear selection";
      const status = statuses.get(`${activeDataset.id}:${input.type}`);
      input.current.dataset.saveState = status?.state ?? "idle";
      for (const message of input.messages) {
        message.hidden = message.dataset.fileStatus !== status?.state;
        if (message.dataset.fileStatus === "default") {
          message.textContent = defaults.length ? "Default file selection saved."
            : "File selection cleared.";
        }
        if (message.dataset.fileStatus === "error") message.textContent = status?.error ?? "";
      }
    }

    function renderFiles() {
      for (const input of inputs) renderInput(input);
      inputValidation?.sync();
    }

    async function restoreDefaults(input) {
      if (resettingDatasetFile || !datasetCatalogReady || !activeDataset.persisted) return;
      const datasetId = activeDataset.id;
      const files = [...(activeDataset.defaultInputs[input.type] ?? [])];
      const key = `${datasetId}:${input.type}`;
      resettingDatasetFile = true;
      statuses.set(key, {state: "saving"});
      renderFiles();
      syncDatasetReferences();
      try {
        const record = await requestDataset(`/signet/datasets/${encodeURIComponent(datasetId)}`,
          {inputs: {[input.type]: files}}, "PATCH");
        if (record.id !== datasetId) throw new Error("The saved dataset does not match this selection.");
        acceptSavedDataset(record);
        statuses.set(key, {state: "default"});
        renderDatasetLabels();
      } catch (error) {
        statuses.set(key, {state: "error", error: error.message});
      } finally {
        resettingDatasetFile = false;
        renderFiles();
        syncDatasetReferences();
        if (activeDataset.id === datasetId && input.resetButton.hidden &&
            document.activeElement === document.body && input.replaceButton.getClientRects().length) {
          input.replaceButton.focus();
        }
      }
    }

    for (const row of root.querySelectorAll("[data-input-target]")) {
      const article = root.querySelector("#" + row.getAttribute("aria-controls"));
      const current = template.content.firstElementChild.cloneNode(true);
      article.querySelector(".ml-dataset-editor-grid").prepend(current);
      const input = {
        current,
        type: row.dataset.inputTarget,
        datasetName: article.querySelector("[data-file-dataset]"),
        paths: current.querySelector("[data-current-files]"),
        empty: current.querySelector("[data-current-file-empty]"),
        count: current.querySelector("[data-current-file-count]"),
        caption: row.querySelector("small"),
        messages: current.querySelectorAll("[data-file-status]"),
        replaceButton: current.querySelector("[data-input-replace]"),
        resetButton: current.querySelector("[data-input-reset]"),
      };
      inputs.push(input);
      renderInput(input);
      input.replaceButton.addEventListener("click", () => {
        if (input.replaceButton.disabled) return;
        const labels = inputTypes.find(([key]) => key === input.type);
        const paths = activeDataset.inputs[input.type] ?? [];
        window.dispatchEvent(new CustomEvent("open-remote-files", {detail: {
          key: input.type, inputKind: input.type, label: labels[1],
          current: paths[0] ?? "", currentPaths: [...paths], datasetId: activeDataset.id,
          multiple: input.type === "genotype",
        }}));
      });
      input.resetButton.addEventListener("click", () => void restoreDefaults(input));
    }

    window.addEventListener("dataset-files-selected", (event) => {
      const {datasetId, inputKind, record} = event.detail ?? {};
      if (record?.id !== datasetId || !datasets.some(dataset => dataset.id === datasetId) ||
          !inputTypes.some(([kind]) => kind === inputKind)) return;
      acceptSavedDataset(record);
      statuses.set(`${datasetId}:${inputKind}`, {state: "applied"});
      renderDatasetLabels();
      renderFiles();
    });
    return renderFiles;
  })();

  const syncDatasetReferences = (() => {
    const panel = byId("input-references");
    const rows = [...panel.querySelectorAll("[data-reference-role]")].map(row => ({
      role: row.dataset.referenceRole,
      path: row.querySelector("[data-reference-path]"),
      origin: row.querySelector("[data-reference-origin]"),
      choose: row.querySelector("[data-reference-choose]"),
      reset: row.querySelector("[data-reference-reset]"),
      status: row.querySelector("[data-reference-status]"),
    }));
    const caption = root.querySelector("[data-reference-caption]");
    const datasetName = panel.querySelector("[data-reference-dataset]");
    const feedback = panel.querySelector("[data-reference-feedback]");
    const retry = panel.querySelector("[data-reference-retry]");
    const messages = new Map();
    let defaults = {};
    let defaultRequest;
    let defaultState = "idle";
    let defaultError = "";
    let connected = false;
    let remoteKey;
    const current = () => activeDataset.references ?? {};
    const editable = () => datasetCatalogReady && activeDataset.persisted && !resettingDatasetFile;
    const needsDefaults = () => rows.some(({role}) => !current()[role]);
    const visible = () => app.dataset.nav === "data" && !panel.hidden && !byId("dataset-files").hidden;

    function render() {
      datasetName.textContent = activeDataset.name;
      const custom = rows.filter(({role}) => current()[role]).length;
      caption.textContent = custom ? `${custom} customized` : "Environment defaults";
      for (const row of rows) {
        const override = current()[row.role];
        const path = override || defaults[row.role];
        row.path.hidden = !path;
        row.path.textContent = path ?? "";
        row.origin.textContent = override ? "Custom" : "Environment default";
        row.choose.disabled = !editable();
        row.reset.disabled = !editable();
        row.reset.hidden = !override;
        const notice = messages.get(`${activeDataset.id}:${row.role}`);
        const status = {
          saving: "Saving…",
          saved: "Reference file saved.",
          default: "Environment default restored.",
          error: notice?.error ?? "",
        }[notice?.state] ?? "";
        row.status.hidden = !status;
        row.status.dataset.status = notice?.state ?? "";
        if (row.status.textContent !== status) row.status.textContent = status;
      }
      const notice = !needsDefaults() ? "" : !connected
        ? "Connect to see the default reference paths."
        : defaultState === "loading" ? "Loading environment defaults…"
        : defaultState === "error" ? defaultError : "";
      feedback.hidden = !notice;
      if (feedback.textContent !== notice) feedback.textContent = notice;
      retry.hidden = !(connected && needsDefaults() && defaultState === "error");
    }

    async function loadDefaults() {
      if (!visible() || !connected || !needsDefaults() || defaultRequest) return;
      const request = new AbortController();
      defaultRequest = request;
      defaultState = "loading";
      render();
      try {
        const reply = await requestDataset("/signet/references", undefined, "GET", request.signal);
        if (defaultRequest !== request) return;
        if (!rows.every(({role}) => typeof reply.references?.[role] === "string" && reply.references[role].startsWith("/"))) {
          throw Error("Could not confirm the environment reference paths.");
        }
        defaults = reply.references;
        defaultState = "ready";
      } catch (error) {
        if (defaultRequest !== request) return;
        defaults = {};
        defaultError = error.message;
        defaultState = "error";
      } finally {
        if (defaultRequest === request) {
          defaultRequest = null;
          render();
        }
      }
    }

    function acceptReference(record, role, state) {
      acceptSavedDataset(record);
      messages.set(`${record.id}:${role}`, {state});
      syncInputFiles();
      syncGenotypeContext();
    }

    async function restoreDefault(row) {
      if (!editable() || !current()[row.role]) return;
      const datasetId = activeDataset.id, key = `${datasetId}:${row.role}`;
      resettingDatasetFile = true;
      messages.set(key, {state: "saving"});
      syncInputFiles();
      render();
      try {
        const record = await requestDataset(`/signet/datasets/${encodeURIComponent(datasetId)}`,
          {references: {[row.role]: null}}, "PATCH");
        if (record.id !== datasetId || record.references?.[row.role]) {
          throw Error("Could not confirm the restored default for this dataset.");
        }
        acceptReference(record, row.role, "default");
      } catch (error) {
        messages.set(key, {state: "error", error: error.message});
      } finally {
        resettingDatasetFile = false;
        syncInputFiles();
        render();
        if (activeDataset.id === datasetId && row.reset.hidden && document.activeElement === document.body &&
            row.choose.getClientRects().length) row.choose.focus();
        if (defaultState === "idle") void loadDefaults();
      }
    }

    for (const row of rows) {
      const [, label] = referenceTypes.find(([role]) => role === row.role);
      row.choose.addEventListener("click", () => {
        if (!editable()) return;
        window.dispatchEvent(new CustomEvent("open-remote-files", {detail: {
          key: row.role, referenceKind: row.role, label,
          current: current()[row.role] || defaults[row.role] || "",
          datasetId: activeDataset.id,
        }}));
      });
      row.reset.addEventListener("click", () => void restoreDefault(row));
    }
    retry.addEventListener("click", () => void loadDefaults());
    window.addEventListener("dataset-reference-selected", event => {
      const {datasetId, referenceKind, record} = event.detail ?? {};
      if (record?.id !== datasetId || !datasets.some(dataset => dataset.id === datasetId) ||
          !rows.some(({role}) => role === referenceKind) ||
          typeof record.references?.[referenceKind] !== "string") return;
      acceptReference(record, referenceKind, "saved");
      render();
    });
    window.addEventListener("workspace-remote-context", event => {
      const {connected: online, identity, environmentKey} = event.detail ?? {};
      const next = JSON.stringify([online === true, identity, environmentKey]);
      if (next === remoteKey) return;
      remoteKey = next;
      connected = online === true;
      defaultRequest?.abort();
      defaultRequest = null;
      defaults = {};
      defaultState = "idle";
      render();
      void loadDefaults();
    });
    return (refresh = false) => {
      render();
      if (refresh || defaultState === "idle") void loadDefaults();
    };
  })();

  inputValidation = window.SignetInputValidation.create({root, renderFilePath, getDataset: () => ({
    id: activeDataset.id, name: activeDataset.name, inputs: activeDataset.inputs,
    persisted: activeDataset.persisted, ready: datasetCatalogReady,
  })});

  function matrixPreview(rows) {
    const colors = ["#edf3f8", "#d7e6f2", "#b7d1e6", "#91b8d7", "#5f92bf", "#306b9f"];
    return rows.map((row, y) => [...row].map((value, x) =>
      `<rect x="${10 + x * 8}" y="${4 + y * 8}" width="7" height="7" fill="${colors[value]}"/>`
    ).join("")).join("");
  }

  function barPreview(values, colors) {
    const rowHeight = 30 / values.length;
    const max = Math.max(...values);
    return values.map((value, index) =>
      `<rect x="16" y="${3 + rowHeight * index}" width="${Math.round(value / max * 100)}"
        height="${rowHeight - 3}" rx="1" fill="${colors[index]}"/>`
    ).join("");
  }

  const stageData = [
    {
      name: "Genotype preparation", note: "Review the dataset files, then manually submit genotype preparation.",
      settings: "Review files and submission settings on the right.",
      output: "After submission, follow the queue, job, and output checks.",
      icon: "grid-3x3",
      preview: matrixPreview(["05050000000000", "00050000000000", "00050000000000", "00000000000000"]),
    },
    {
      name: "Gene expression preparation", note: "Prepare expression data for this run’s selected chromosome.",
      settings: "Review this run’s files and chromosome on the right.",
      output: "View this run’s sample and gene results after completion.",
      icon: "grid-3x3",
      preview: matrixPreview(["22433443320232", "23432432241223", "45224454353243", "12322342231244"]),
    },
    {
      name: "Sample matching and adjustment", note: "Match samples, then adjust expression using PCs.",
      settings: "Review the clinical file and principal component count on the right.",
      output: "View this run’s matching and adjustment results after completion.",
      icon: "bar-chart-3",
      preview: barPreview([473, 471], ["#b7cfe2", "#4380b2"]),
    },
    {
      name: "Cis-eQTL analysis", note: "Test variants for associations with nearby genes.",
      settings: "Review the threshold, range and permutations on the right.",
      output: "Open the association results from run history after completion.",
      icon: "bar-chart-3",
      preview: barPreview([3, 2, 1], ["#4380b2", "#85afcf", "#b7cfe2"]),
    },
    {
      name: "Network inference", note: "Use bootstrapping to infer directed gene links.",
      settings: "Review bootstrap runs, the correlation threshold and resources on the right.",
      output: "Open candidate edges and frequencies from run history after completion.",
      icon: "bar-chart-3",
      preview: barPreview([394, 337], ["#85afcf", "#4380b2"]),
    },
    {
      name: "Network visualization", note: "Filter edges by frequency to visualize the network.",
      settings: "Frequency cutoff 0.45 · largest subnetwork",
      output: "Full network: 95 genes, 731 edges · excerpt shown",
      icon: "network",
      preview: `<path d="M64 18L14 23M64 18L33 5M64 18L43 30M64 18L84 6M64 18L96 29M64 18L117 13"
        fill="none" stroke="#91b8d7" stroke-width="1.2"/>
        <g fill="#6a98be"><circle cx="14" cy="23" r="3"/><circle cx="33" cy="5" r="3"/>
          <circle cx="43" cy="30" r="3"/><circle cx="84" cy="6" r="3"/>
          <circle cx="96" cy="29" r="3"/><circle cx="117" cy="13" r="3"/></g>
        <circle cx="64" cy="18" r="5" fill="#3676ad"/>`,
    },
  ];

  // Counts and table excerpts come from the same 11 November chromosome 1 archive as stages 3 and 6.
  const snapshots = [
    {
      number: 1,
      chartTitle: "Share of nonzero genotype codes by variant",
      axis: "Variant count",
      bars: [["0–1%", 1884], ["1–5%", 495], ["5–10%", 138], ["10–25%", 131], ["25–50%", 174], ["50–100%", 161]],
      step: 500,
      caption: "2,983 variants across 560 samples. Each bin includes its lower bound. The last also includes 100%.",
      settings: [
        ["Max. sample missingness", "10%"], ["Max. variant missingness", "10%"],
        ["HWE p-value cutoff", "p = 0.0001"], ["Imputation block size", "5,000,000 bp"],
      ],
      tableTitle: "Genotype code summary",
      headers: ["Genotype code", "Count", "Share"],
      rows: [["0", "1,552,102", "92.91%"], ["1", "99,798", "5.97%"], ["2", "18,580", "1.11%"]],
    },
    {
      number: 2,
      chartTitle: "Distribution of transformed gene expression",
      axis: "Expression value count",
      bars: [["11–12", 617], ["12–13", 5634], ["13–14", 16258], ["14–15", 18300], ["15–16", 9462], ["16–17", 2116], ["17–18", 230], ["18–19", 13]],
      step: 5000,
      caption: "52,630 values across 554 samples and 95 genes. Each bin includes its lower bound.",
      settings: [
        ["Min. reads per sample", "2,500,000"], ["Genes included", "Annotated protein-coding genes"],
        ["Expression transform", "Variance-stabilizing transformation"],
      ],
      tableTitle: "Gene expression summary excerpt",
      headers: ["Gene", "Minimum", "Median", "Maximum"],
      rows: [
        ["C1orf159", "11.63", "13.82", "17.53"], ["MEGF6", "11.63", "14.12", "17.55"],
        ["CHD5", "11.63", "14.12", "16.94"], ["ACOT7", "11.62", "13.57", "16.76"], ["THAP3", "11.56", "14.31", "17.25"],
      ],
    },
    {
      number: 4,
      chartTitle: "Significant associations by variant group",
      axis: "Significant pair count",
      bars: [["Common variants", 156], ["Low-frequency regions", 35], ["Rare-variant regions", 15]],
      step: 40,
      caption: "206 significant pairs across 85 genes. Low-frequency and rare variants are grouped by region.",
      settings: [
        ["Significance cutoff", "0.05"], ["Upstream window", "1,000 bp"],
        ["Downstream window", "1,000 bp"], ["Permutations (low/rare)", "100"],
      ],
      tableTitle: "Significant pairs · 5 lowest p-values",
      headers: ["Gene", "Variant or region ID", "Category", "p-value"],
      rows: [
        ["P3H1", "35", "Common variants", "0.00010067"], ["MYSM1", "50", "Common variants", "0.00010346"],
        ["FMO5", "100", "Common variants", "0.00010483"], ["DRAXIN", "12", "Common variants", "0.00012454"],
        ["CAPN9", "191", "Low-frequency regions", "0.00013783"],
      ],
    },
    {
      number: 5,
      chartTitle: "Candidate edge frequency across bootstrap runs",
      axis: "Candidate edge count",
      bars: [["1 of 2 runs (50%)", 394], ["2 of 2 runs (100%)", 337]],
      step: 100,
      caption: "731 candidate edges appeared in at least one bootstrap run. Stage 6 filters by frequency.",
      settings: [
        ["Bootstrap runs", "2"], ["Max. markers per gene", "3"], ["Max. absolute marker correlation", "0.3"],
        ["Network job cores", "2"], ["Network job memory", "8 GB"], ["Network job time limit", "4 hours"],
      ],
      tableTitle: "Inferred edge excerpt",
      headers: ["Source gene", "Target gene", "Bootstrap frequency"],
      rows: [
        ["MEGF6", "CYP4Z1", "50%"], ["MEGF6", "LRRC40", "50%"], ["MEGF6", "HSD17B7", "50%"],
        ["MEGF6", "ATP1B1", "100%"], ["MEGF6", "RABGAP1L", "100%"],
      ],
    },
  ];

  const escapeHistory = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
  const countLabel = new Intl.NumberFormat("en-US");
  const percentLabel = value => `${Number((value * 100).toFixed(6))}%`;
  function countChart(bars, step, axis, title, frequencyAxis) {
    const maximum = step * (Math.floor(Math.max(...bars.map(([, value]) => value)) / step) + 1);
    const left = 74, right = 636, top = 50, bottom = 354;
    const columnWidth = (right - left) / bars.length;
    let barWidth = Math.min(128, columnWidth - Math.min(12, columnWidth / 2));
    const xFor = frequency => left + frequency * (right - left);
    if (frequencyAxis) {
      const values = bars.map(([frequency]) => frequency).sort((a, b) => a - b);
      const gap = values.slice(1).reduce((minimum, value, index) => Math.min(minimum, value - values[index]), 1);
      barWidth = Math.min(32, (right - left) * gap * .8);
    }
    const yFor = (value) => bottom - value / maximum * (bottom - top);
    const grid = Array.from({ length: maximum / step + 1 }, (_, index) => {
      const value = index * step;
      const y = yFor(value);
      return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" class="ml-count-grid"/>
        <text x="${left - 9}" y="${y + 4}" text-anchor="end">${countLabel.format(value)}</text>`;
    }).join("");
    const displayLabel = label => frequencyAxis ? percentLabel(label) : label;
    const columns = bars.map(([label, value], index) => {
      const x = frequencyAxis ? xFor(label) : left + (index + .5) * columnWidth;
      const y = yFor(value);
      const formatted = countLabel.format(value);
      const rect = `<rect class="ml-count-bar" x="${x - barWidth / 2}" y="${y}" width="${barWidth}" height="${bottom - y}" rx="2"`;
      if (frequencyAxis) return `${rect}><title>${escapeHistory(`${displayLabel(label)} · ${axis} ${formatted}`)}</title></rect>`;
      return `${rect}/>
        <text class="ml-count-label" x="${x}" y="${y - 9}" text-anchor="middle">${formatted}</text>
        <text x="${x}" y="${bottom + 28}" text-anchor="middle">${escapeHistory(label)}</text>`;
    }).join("");
    const ticks = frequencyAxis ? [0, .2, .4, .6, .8, 1].map(value =>
      `<text class="ml-count-frequency-tick" x="${xFor(value)}" y="${bottom + 24}" text-anchor="middle">${percentLabel(value)}</text>`).join("") : "";
    const description = bars.map(([label, value]) => `${displayLabel(label)} ${countLabel.format(value)}`).join(", ");
    const xLegend = frequencyAxis ? `<text x="${(left + right) / 2}" y="402" text-anchor="middle">${escapeHistory(frequencyAxis)}</text>` : "";
    return `<svg class="ml-count-chart" viewBox="0 0 660 410" role="img" aria-label="${escapeHistory(`${title}. ${axis}: ${description}`)}">
      <text x="${left}" y="23">${escapeHistory(axis)}</text>
      ${grid}${columns}${ticks}${xLegend}
    </svg>`;
  }

  const snapshotMarkup = snapshots.map(({ number, chartTitle, axis, bars, step, caption, settings, tableTitle, headers, rows }) => {
    const { name, icon } = stageData[number - 1];
    const settingsMarkup = settings.map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`).join("");
    const headerCells = headers.map((header) => `<th scope="col">${header}</th>`).join("");
    const dataRows = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");
    return `<section class="ml-workspace ml-stage-snapshot" id="lens-stage${number}" aria-labelledby="lens-stage${number}-title" hidden>
      <div class="ml-result-main">
        <figure class="ml-result-figure">
          <h3>${chartTitle}</h3>
          ${countChart(bars, step, axis, chartTitle)}
          <figcaption>${caption}</figcaption>
        </figure>
        <details class="ml-result-dock" open>
          <summary><i data-lucide="table-2" aria-hidden="true"></i>${tableTitle}
            <i class="ml-result-chevron" data-lucide="chevron-down" aria-hidden="true"></i>
          </summary>
          <div class="ml-result-table">
            <table aria-label="${tableTitle}">
              <thead><tr>${headerCells}</tr></thead>
              <tbody>${dataRows}</tbody>
            </table>
          </div>
        </details>
      </div>
      <aside class="ml-result-inspector" aria-label="Stage ${number} settings">
        <header class="ml-result-inspector-heading">
          <i data-lucide="${icon}" aria-hidden="true"></i>
          <h2 id="lens-stage${number}-title">${name}</h2>
        </header>
        <dl class="ml-result-context">
          <dt>Stage</dt><dd>Stage ${number}</dd>
          <dt>Data</dt><dd>Chromosome 1 · Simulated results</dd>
          ${settingsMarkup}
        </dl>
      </aside>
    </section>`;
  }).join("");
  app.insertAdjacentHTML("beforeend", snapshotMarkup);

  const timeline = byId("timeline");
  const activeStageButton = () => timeline.querySelector('[aria-current="step"]');
  timeline.innerHTML = stageData.map(({ name, note, settings, output, icon, preview }, index) => {
    const number = index + 1;
    return `<li class="ml-stage-entry">
      <p class="ml-stage-note"><span class="ml-stage-marker" aria-hidden="true"><i data-lucide="message-square-text"></i></span>${note}</p>
      <button type="button" class="ml-stage-button" data-stage="${number}" aria-expanded="false" aria-controls="ml-stage-detail-${number}">
        <span class="ml-stage-title">
          <span class="ml-stage-marker" aria-hidden="true"><i data-lucide="list"></i></span>
          <span class="ml-stage-number">Stage ${number}</span>${name}
          <i data-lucide="chevron-down" class="ml-stage-chevron" aria-hidden="true"></i>
        </span>
        <span class="ml-stage-preview" aria-hidden="true">
          <span class="ml-stage-marker"><i data-lucide="${icon}"></i></span>
          <svg class="ml-stage-thumbnail" viewBox="0 0 132 36">${preview}</svg>
        </span>
      </button>
      <dl class="ml-stage-detail" id="ml-stage-detail-${number}" hidden>
        <dt>Settings</dt><dd>${settings}</dd>
        <dt>Output</dt><dd>${output}</dd>
      </dl>
    </li>`;
  }).join("");
  const timelineSummaries = new Map();
  let timelinePreviewRequest;
  const timelineRevision = (run, stage) => {
    const job = run.jobs?.[historySteps[stage - 1]];
    return JSON.stringify([run.source === "live" ? job?.record_revision : run.revision,
      job?.attempt, job?.job_id, job?.state ?? job?.status, job?.finished_at, job?.reused_from, job?.settings, job?.options]);
  };
  function rememberTimelineResult(run, stage, result, state = "ready") {
    timelineSummaries.set(historyKey(run) + ":" + stage, {revision: timelineRevision(run, stage), result, state});
    renderRunTimeline();
  }
  function selectedAnalysisRun() {
    return runsForDataset().find(run => historyKey(run) === analysisRunByDataset.get(activeDataset.id));
  }
  function timelineRun() {
    if (app.dataset.nav === "history") {
      const matching = matchingHistoryRuns();
      return selectedHistoryResult() ?? matching.find(run => historyKey(run) === selectedRuns.get(historySelectionKey())) ?? matching[0];
    }
    const stage = Number(timeline.querySelector('[aria-current="step"]')?.dataset.stage);
    const saved = selectedAnalysisRun();
    if (saved && (savedAnalysisView() || stage === 6)) return saved;
    const controller = [genotypeRun, expressionRun, adjustmentRun, cisRun, networkRun, visualizationRun][stage - 1];
    const runId = controller?.getRunId?.();
    if (stage === 6 && runId == null) return;
    return runsForDataset().find(run => canContinue(run) && (runId == null || run.run_id === runId));
  }

  function syncTimelinePreview(run) {
    const canPreview = tabs[1].getAttribute("aria-selected") === "true" &&
      ["analysis", "history"].includes(app.dataset.nav) && Boolean(run);
    const id = canPreview ? historyKey(run) : null;
    const openStage = historyResult && historyResult.historyId === id ? Number(historyResult.stage) : null;
    const needsPreview = stage => id && stage !== openStage &&
      run.jobs?.[historySteps[stage - 1]]?.state === "completed" &&
      (stage === 6 ? canReadGraph(run) : canReadStage(run, stage)) &&
      timelineSummaries.get(`${id}:${stage}`)?.revision !== timelineRevision(run, stage);
    if (timelinePreviewRequest) {
      const {id: pendingId, stage, revision} = timelinePreviewRequest;
      if (pendingId === id && needsPreview(stage) && timelineRevision(run, stage) === revision) return;
      timelinePreviewRequest.controller.abort();
      timelinePreviewRequest = null;
    }
    const stage = [1, 2, 3, 4, 5, 6].find(needsPreview);
    if (!stage) return;
    const revision = timelineRevision(run, stage);
    const request = {id, stage, revision, key: `${id}:${stage}`, controller: new AbortController()};
    timelinePreviewRequest = request;
    void loadTimelinePreview(run, request);
  }

  async function loadTimelinePreview(run, request) {
    const {id, stage, revision, controller} = request;
    let result = null, state = "ready";
    try {
      result = await getSavedStageResult(run, stage, controller.signal);
    } catch (error) {
      state = archivedResultErrorState(error);
    }
    if (timelinePreviewRequest !== request) return;
    timelinePreviewRequest = null;
    const current = findHistoryRun(id);
    if (current && timelineRevision(current, stage) === revision) {
      rememberTimelineResult(current, stage, result, state);
    } else {
      renderRunTimeline();
    }
  }

  function timelineProgress(job) {
    if (!job || !["running", "validating"].includes(job.state)) return null;
    const progress = [];
    for (const value of Object.values(job.progress ?? {})) {
      const match = typeof value === "string" && value.match(/^(\d+) (\d+)$/);
      if (!match) continue;
      const done = Number(match[1]), total = Number(match[2]);
      if (Number.isSafeInteger(total) && total > 0 && done <= total) progress.push({done, total});
    }
    return progress.find(value => value.done < value.total) ?? progress.at(-1) ?? null;
  }
  function timelineOutput(stage, result) {
    const metric = (label, value) => Number.isFinite(value) ? `${label} ${countLabel.format(value)}` : null;
    if (stage === 3) {
      const counts = result.matching ?? {};
      return [metric("Genotype samples", counts.genotype),
        metric("Expression samples", counts.expression),
        metric("Matched samples", counts.matched), metric("Retained samples", counts.retained),
        metric("Excluded samples", counts.excluded), metric("Principal components", result.npc)]
        .filter(Boolean).join(" · ");
    }
    if (stage === 6) {
      return [metric("Genes", result.graph?.counts?.genes),
        metric("Edges", result.graph?.counts?.connections)].filter(Boolean).join(" · ");
    }
    return viewArchivedStep(stage, result.summary).metrics
      .map(([label, value]) => `${label} ${countLabel.format(value)}`).join(" · ");
  }
  function renderTimelineThumbnail(svg, stage, result, progress) {
    svg.replaceChildren();
    const mark = (tag, attributes) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
      svg.append(node);
    };
    if (!result) {
      if (!progress) return false;
      mark("rect", {x: 5, y: 14, width: 124, height: 8, rx: 4, fill: "#e2e9ef"});
      mark("rect", {x: 5, y: 14, width: 124 * progress.done / progress.total, height: 8, rx: 4, fill: "#5389b2"});
      return true;
    }
    if (stage === 3) {
      if (result.pca?.png_base64) {
        mark("image", {href: "data:image/png;base64," + result.pca.png_base64, x: 0, y: 0, width: 134, height: 36});
        return true;
      }
      const source = result.pca?.points ?? [];
      const stride = Math.max(1, Math.ceil(source.length / 48));
      const points = source.filter((point, index) => index % stride === 0 && point.length >= 2 && point.every(Number.isFinite));
      const x = points.map(point => point[0]), y = points.map(point => point[1]);
      const left = Math.min(...x), bottom = Math.min(...y);
      const width = Math.max(...x) - left || 1, height = Math.max(...y) - bottom || 1;
      for (const point of points) mark("circle", {cx: 5 + (point[0] - left) / width * 122,
        cy: 31 - (point[1] - bottom) / height * 26, r: 1.4, fill: "#5389b2"});
    } else if (stage === 6) {
      const nodes = (result.graph?.nodes ?? []).slice(0, 24);
      const positions = layoutStage6(nodes);
      for (const edge of (result.graph?.edges ?? []).filter(edge => positions[edge.source] && positions[edge.target]).slice(0, 48)) {
        const [x1, y1] = positions[edge.source], [x2, y2] = positions[edge.target];
        mark("line", {x1: x1 * 1.22 + 5, y1: y1 * .26 + 5, x2: x2 * 1.22 + 5, y2: y2 * .26 + 5,
          stroke: "#9eb8cb", "stroke-width": .7});
      }
      for (const [x, y] of Object.values(positions)) mark("circle", {cx: x * 1.22 + 5, cy: y * .26 + 5, r: 1.6, fill: "#5389b2"});
    } else {
      const bars = viewArchivedStep(stage, result.summary, 0).bars.slice(0, 24);
      const maximum = Math.max(...bars.map(([, value]) => value), 1);
      const width = 124 / bars.length;
      bars.forEach(([, value], index) => mark("rect", {x: 4 + index * width, y: 32 - value / maximum * 28,
        width: Math.max(width - 2, 1), height: value / maximum * 28, fill: "#80a9c8"}));
    }
    return svg.childElementCount > 0;
  }
  function renderRunTimeline() {
    const run = timelineRun();
    syncTimelinePreview(run);
    timeline.dataset.historyId = run ? historyKey(run) : "";
    for (const button of timeline.querySelectorAll("[data-stage]")) {
      const stage = Number(button.dataset.stage);
      const entry = button.closest(".ml-stage-entry");
      const job = run?.jobs?.[historySteps[stage - 1]];
      const saved = run && timelineSummaries.get(historyKey(run) + ":" + stage);
      const readable = run && (canReadStage(run, stage) || stage === 6 && canReadGraph(run));
      const evidence = readable && saved?.revision === timelineRevision(run, stage) ? saved : null;
      const result = evidence?.state === "ready" ? evidence.result : null;
      const progress = timelineProgress(job);
      const work = progress ? `${countLabel.format(progress.done)} / ${countLabel.format(progress.total)}` : "";
      entry.dataset.runState = job?.state ?? job?.status ?? "";
      entry.querySelector(".ml-stage-note").textContent = run
        ? (run.source === "recorded" ? "Last recorded state: " : "") +
          genotypeHistoryState(job?.state ?? job?.status) + (work ? ` · ${work}` : "")
        : "Select a run to view saved results.";
      const values = entry.querySelectorAll(".ml-stage-detail dd");
      const savedJob = result?.job ?? job;
      const settings = {...savedJob?.settings, ...savedJob?.options};
      if (stage === 3 && result && settings.npc == null) settings.npc = result.npc;
      if (stage === 6 && result) {
        if (settings.freq == null) settings.freq = result.frequency;
        if (settings.ntop == null) settings.ntop = result.top_networks;
      }
      const descriptions = Object.entries(settings).map(([key, value]) =>
        `${savedSettingLabels[key] ?? key}: ${["string", "number", "boolean"].includes(typeof value)
          ? value : "No readable saved value"}`);
      for (const [key, label] of [["cpus", stage === 5 ? "Controller job cores" : "Scheduled job cores"],
        ["mem_gb", "Scheduled memory (GB)"], ["time", "Scheduled time limit"],
        ["hours", "Scheduled hour limit"]]) {
        if (savedJob?.resources?.[key] != null) descriptions.push(`${label}: ${savedJob.resources[key]}`);
      }
      values[0].textContent = descriptions.join(" · ") || "No saved settings";
      values[1].textContent = result ? timelineOutput(stage, result)
        : evidence?.state === "timeout" ? "Result read timed out; open the stage to retry."
        : evidence?.state === "error" ? "Could not load saved results; open the stage to retry."
        : run && timelinePreviewRequest?.key === `${historyKey(run)}:${stage}` ? "Loading saved results…"
        : evidence?.state === "empty" || !readable ? "No readable saved result is available."
        : "Open this stage to load its saved summary.";
      // Show measured progress or a saved result for this exact run and stage.
      const preview = entry.querySelector(".ml-stage-preview");
      preview.hidden = !renderTimelineThumbnail(preview.querySelector(".ml-stage-thumbnail"), stage, result, progress);
      preview.title = progress ? `Run progress ${work}`
        : "Saved result preview (up to 48 samples or 24 genes)";
    }
  }
  const stageButtons = timeline.querySelectorAll(".ml-stage-button");
  const stageResults = root.querySelectorAll(".ml-workspace");
  function syncGenotypeContext() {
    const stageContext = "Manual execution";
    const inHistory = app.dataset.nav === "history" || savedAnalysisView();
    const liveRuns = runsForDataset().filter(canContinue);
    const historyRun = selectedHistoryResult();
    const continuationRuns = inHistory ? (canContinue(historyRun) ? [historyRun] : []) : liveRuns;
    const continuationDataset = inHistory ? historyRun?.dataset_id ?? activeDataset.id : activeDataset.id;
    const genotypeHistory = inHistory && historyResult?.stage === 1 &&
      canContinue(historyRun) && historyRun.jobs.genotype?.state !== "completed";
    const genotypeDataset = genotypeHistory ? {
      id: continuationDataset,
      name: historyRun.dataset_name ?? datasets.find(dataset => dataset.id === continuationDataset)?.name ?? continuationDataset,
      inputs: historyRun.inputs,
      persisted: false,
      ready: datasetCatalogReady,
    } : {id: activeDataset.id, name: activeDataset.name, inputs: activeDataset.inputs,
      references: activeDataset.references, persisted: activeDataset.persisted, ready: datasetCatalogReady};
    byId("stage-header").querySelector("span").textContent = savedAnalysisView()
      ? historyRun.name : stageContext;
    genotypeRun?.setContext({
      datasetId: genotypeDataset.id,
      dataset: genotypeDataset,
      runs: genotypeHistory ? continuationRuns : liveRuns,
      runId: genotypeHistory ? historyRun.run_id : null,
      visible: app.dataset.nav === "analysis" && !savedAnalysisView() &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "1" || genotypeHistory,
    });
    expressionRun?.setContext({
      datasetId: continuationDataset,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "2" ||
        inHistory && historyResult?.stage === 2,
      runs: continuationRuns,
      runId: inHistory && historyResult?.stage === 2 ? historyResult.runId : null,
    });
    adjustmentRun?.setContext({
      datasetId: continuationDataset,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "3" ||
        inHistory && historyResult?.stage === 3,
      runs: continuationRuns,
      runId: inHistory && historyResult?.stage === 3 ? historyResult.runId : null,
    });
    cisRun?.setContext({
      datasetId: continuationDataset,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "4" ||
        inHistory && historyResult?.stage === 4,
      runs: continuationRuns,
      runId: inHistory && historyResult?.stage === 4 ? historyResult.runId : null,
    });
    networkRun?.setContext({
      datasetId: continuationDataset,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "5" ||
        inHistory && historyResult?.stage === 5,
      runs: continuationRuns,
      runId: inHistory && historyResult?.stage === 5 ? historyResult.runId : null,
    });
    visualizationRun?.setContext({
      datasetId: continuationDataset,
      visible: ["analysis", "history"].includes(app.dataset.nav) && visualizationFormVisible(),
      runs: continuationRuns,
      runId: inHistory && historyResult?.stage === 6 ? historyResult.runId : null,
      resultsAvailable: stage6RunsForDataset().length > 0,
    });
    if (visualizationRun) syncVisualizationPanels();
  }

  function showStage(button, open) {
    for (const entry of stageButtons) {
      const expanded = entry === button && open;
      entry.setAttribute("aria-expanded", String(expanded));
      root.querySelector("#" + entry.getAttribute("aria-controls")).hidden = !expanded;
    }
    for (const panel of stageResults) panel.hidden = panel.id !== "lens-stage" + button.dataset.stage;
    activeStageButton()?.removeAttribute("aria-current");
    button.setAttribute("aria-current", "step");
    if (app.dataset.nav === "analysis") {
      bindAnalysisStage();
      updateHistoryView();
      syncStage6Picker();
    } else syncGenotypeContext();
  }
  function bindAnalysisStage() {
    const run = selectedAnalysisRun(), stage = Number(activeStageButton()?.dataset.stage);
    clearHistoryResult();
    if (!run || !stage) return;
    historyResult = {runId: run.run_id, historyId: historyKey(run), stage, view: "analysis"};
    if (stage === 3) void loadStage3Run();
    else if (archiveSteps.has(stage)) void loadArchivedStep();
  }
  for (const button of stageButtons) {
    button.addEventListener("click", () => {
      showStage(button, button.getAttribute("aria-expanded") === "false");
    });
  }

  function mountNetwork(stage) {
    const zoom = stage.querySelector(".s6-zoom input");
    const frame = stage.querySelector(".s6-graph-frame");
    function updateZoom() {
      frame.style.setProperty("--s6-zoom", Number(zoom.value) / 100);
    }
    zoom.addEventListener("input", updateZoom);
    stage.querySelector("[data-zoom=out]").addEventListener("click", () => { zoom.stepDown(); updateZoom(); });
    stage.querySelector("[data-zoom=in]").addEventListener("click", () => { zoom.stepUp(); updateZoom(); });
    const graph = stage.querySelector(".s6-graph");
    const edgeLayer = graph.querySelector(".s6-edges");
    const nodeLayer = graph.querySelector(".s6-genes");
    const [arrow, selectedArrow] = graph.querySelectorAll("marker");
    const summary = stage.querySelector(".s6-summary");
    const reset = stage.querySelector("[data-s6-clear]");
    const table = stage.querySelector(".ml-result-dock");
    const tableViewport = stage.querySelector(".ml-result-table");
    const rows = table.querySelector("tbody");
    const rowCount = table.querySelector(".s6-row-count");


    const graphMeta = stage.querySelector(".s6-graph-meta");
    const svg = (tag, attributes) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };

    let nodes, edges, nodeElements, edgeElements;
    let pan = [0, 0], gesture = null, dragged = false;
    graph.style.touchAction = "none";
    const point = event => new DOMPoint(event.clientX, event.clientY).matrixTransform(graph.getScreenCTM().inverse());
    const applyPan = () => {
      for (const layer of [edgeLayer, nodeLayer]) layer.setAttribute("transform", `translate(${pan[0]} ${pan[1]})`);
    };
    graph.addEventListener("pointerdown", event => {
      if (event.button !== 0 || event.target.closest(".s6-edge")) return;
      const node = event.target.closest(".s6-gene");
      gesture = {id: event.pointerId, start: point(event), node, pan: [...pan], transform: node?.transform.baseVal.consolidate()?.matrix};
      dragged = false;
    });
    graph.addEventListener("pointermove", event => {
      if (!gesture || gesture.id !== event.pointerId) return;
      const current = point(event), dx = current.x - gesture.start.x, dy = current.y - gesture.start.y;
      if (Math.hypot(dx, dy) < 2 && !dragged) return;
      // Capturing a simple press retargets its click away from the gene.
      if (!dragged) graph.setPointerCapture(event.pointerId);
      dragged = true;
      if (gesture.node) {
        const x = gesture.transform.e + dx, y = gesture.transform.f + dy;
        gesture.node.setAttribute("transform", `translate(${x} ${y})`);
        nodes[gesture.node.dataset.gene] = [(x - 16) / 5.9, (y - 18) / 2.91];
        redrawEdges();
      } else { pan = [gesture.pan[0] + dx, gesture.pan[1] + dy]; applyPan(); }
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) graph.addEventListener(type, () => { gesture = null; });
    graph.addEventListener("click", event => {
      if (dragged) { event.stopImmediatePropagation(); event.preventDefault(); dragged = false; }
    }, true);
    frame.addEventListener("wheel", event => {
      event.preventDefault();
      zoom.value = String(Math.max(Number(zoom.min), Math.min(Number(zoom.max), Number(zoom.value) + (event.deltaY < 0 ? 10 : -10))));
      updateZoom();
    }, {passive: false});
    function redrawEdges() {
      edgeElements.forEach((edge, index) => {
        const [source, target] = edges[index];
        const [sx, sy] = nodes[source], [tx, ty] = nodes[target];
        const x1 = 16 + 5.9 * sx, y1 = 18 + 2.91 * sy, x2 = 16 + 5.9 * tx, y2 = 18 + 2.91 * ty;
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const bend = edges.some(([a, b]) => a === target && b === source) ? 18 : 0;
        const cx = (x1 + x2) / 2 - Math.sin(angle) * bend, cy = (y1 + y2) / 2 + Math.cos(angle) * bend;
        const end = Math.atan2(y2 - cy, x2 - cx);
        edge.setAttribute("d", source === target
          ? `M${x1 + 5} ${y1 - 4} C${x1 + 29} ${y1 - 23} ${x1 - 29} ${y1 - 23} ${x1 - 6} ${y1 - 6}`
          : `M${x1} ${y1} Q${cx} ${cy} ${x2 - 10 * Math.cos(end)} ${y2 - 10 * Math.sin(end)}`);
      });
    }
    function setNetwork(nextNodes, nextEdges, selectedGene = null) {
      nodes = Object.fromEntries(Object.entries(nextNodes).map(([gene, position]) => [gene, [...position]]));
      pan = [0, 0]; gesture = null; dragged = false; zoom.value = "100"; updateZoom(); applyPan();
      edges = nextEdges;
      const positions = Object.fromEntries(Object.entries(nodes).map(([name, [x, y]]) =>
        [name, [16 + 5.9 * x, 18 + 2.91 * y]]));
      const connections = new Set(edges.map(([source, target]) => JSON.stringify([source, target])));
      edgeElements = edges.map(([source, target]) => {
        const [x1, y1] = positions[source];
        const [x2, y2] = positions[target];
        const direction = Math.atan2(y2 - y1, x2 - x1);
        const reciprocal = connections.has(JSON.stringify([target, source]));
        const bend = reciprocal ? 18 : 0;
        const cx = (x1 + x2) / 2 - Math.sin(direction) * bend;
        const cy = (y1 + y2) / 2 + Math.cos(direction) * bend;
        const angle = Math.atan2(y2 - cy, x2 - cx);
        const endX = x2 - 10 * Math.cos(angle);
        const endY = y2 - 10 * Math.sin(angle);
        const path = source === target
          ? `M${x1 + 5} ${y1 - 4} C${x1 + 29} ${y1 - 23} ${x1 - 29} ${y1 - 23} ${x1 - 6} ${y1 - 6}`
          : `M${x1} ${y1} Q${cx} ${cy} ${endX} ${endY}`;
        return svg("path", {
          class: "s6-edge",
          d: path,
          "data-source": source,
          "data-target": target
        });
      });
      edgeElements.forEach((edge, index) => {
        const inspect = () => {
          const [source, target, frequency, coefficient] = edges[index];
          summary.textContent = `${source} → ${target} · Frequency: ${frequency} · Coefficient: ${coefficient}`;
          table.open = true;
        };
        edge.style.pointerEvents = "stroke";
        edge.style.cursor = "pointer";
        edge.setAttribute("tabindex", "0");
        edge.setAttribute("role", "button");
        edge.setAttribute("aria-label", edges[index].join(" → "));
        edge.addEventListener("click", inspect);
        edge.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); inspect(); } });
      });
      const edgeFragment = document.createDocumentFragment();
      for (const edge of edgeElements) edgeFragment.append(edge);
      edgeLayer.replaceChildren(edgeFragment);

      nodeElements = Object.entries(positions).map(([gene, [x, y]]) => {
        const node = svg("g", {
          class: "s6-gene",
          transform: `translate(${x} ${y})`,
          role: "button",
          tabindex: "0",
          "data-gene": gene,
        });
        const name = svg("text", { class: "s6-name", y: "21" });
        name.textContent = gene;
        node.append(
          svg("circle", {class: "s6-focus-ring", r: "13"}),
          svg("circle", {class: "s6-dot", r: gene === "MEGF6" ? "7" : "6"}),
          name
        );
        node.addEventListener("click", () => select(gene));
        node.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          select(gene);
        });
        return node;
      });
      const nodeFragment = document.createDocumentFragment();
      for (const node of nodeElements) nodeFragment.append(node);
      nodeLayer.replaceChildren(nodeFragment);
      stage.toggleAttribute("data-dense-network", edges.length > 100);
      const gene = Object.hasOwn(nodes, selectedGene) ? selectedGene : null;
      stage.dataset.selectedGene = gene ?? "";
      if (gene) table.open = true;
      render(gene);
    }

    const edgesFor = (gene) => gene ? edges.filter(([source, target]) => gene === source || gene === target) : edges;
    function updateReadout(gene, matched) {
      graphMeta.textContent = `${nodeElements.length} genes · ${edges.length} edges`;
      for (const node of nodeElements) {
        const { gene: label } = node.dataset;
        node.setAttribute("aria-label", `View connections for ${label}`);
      }
      if (gene) {
        const incoming = matched.filter(([, target]) => target === gene).length;
        const outgoing = matched.filter(([source]) => source === gene).length;
        const name = document.createElement("strong");
        name.textContent = gene;
        summary.replaceChildren(name, ` · ${incoming} incoming (dashed) · ${outgoing} outgoing`);
      } else {
        summary.textContent = "Select a gene to see its connections.";
      }
      rowCount.textContent = `${matched.length} ${matched.length === 1 ? "edge" : "edges"}`;
    }

    function render(gene) {
      const matched = edgesFor(gene);
      const neighbors = new Set(matched.flatMap(([source, target]) => [source, target]));
      for (const node of nodeElements) {
        const selected = gene === node.dataset.gene;
        const adjacent = neighbors.has(node.dataset.gene);
        node.setAttribute("aria-pressed", String(selected));
        node.dataset.neighbor = String(Boolean(gene) && adjacent && !selected);
        node.dataset.context = String(Boolean(gene) && !adjacent);
      }

      for (const edge of edgeElements) {
        let kind = gene ? "context" : "all";
        if (gene === edge.dataset.source) kind = "outgoing";
        if (gene === edge.dataset.target) kind = "incoming";
        edge.dataset.kind = kind;
        const active = kind === "outgoing" || kind === "incoming";
        edge.setAttribute("marker-end", `url(#${active ? selectedArrow.id : arrow.id})`);
      }

      updateReadout(gene, matched);
      reset.hidden = !gene;

      const resultRows = document.createDocumentFragment();
      for (const [source, target, frequency, coefficient] of matched) {
        const row = document.createElement("tr");
        const coefficientText = Number(coefficient.toFixed(5)).toString();
        for (const value of [source, target, frequency.toFixed(2), coefficientText]) {
          const cell = row.insertCell();
          cell.textContent = value;
          if (value === gene) cell.dataset.focused = "true";
        }
        resultRows.append(row);
      }
      rows.replaceChildren(resultRows);
      tableViewport.scrollTop = 0;
    }

    function select(gene) {
      if (gene !== null && !Object.hasOwn(nodes, gene)) return;
      if (gene) table.open = true;
      if (stage.dataset.selectedGene === (gene ?? "")) return;
      stage.dataset.selectedGene = gene ?? "";
      render(gene);
      stage.dispatchEvent(new CustomEvent("lens:gene-selected", {
        bubbles: true,
        detail: {gene}
      }));
    }

    reset.addEventListener("click", () => {
      const selectedNode = nodeElements.find(node => node.dataset.gene === stage.dataset.selectedGene);
      select(null);
      selectedNode?.focus();
    });
    stage.addEventListener("lens:select-gene", (event) => {
      select(event.detail?.gene);
    });
    setNetwork({}, []);
    return setNetwork;
  }

  const runList = byId("run-list");
  const runDetails = byId("run-details");
  let historyLogViews = [];
  const historyStageSelection = new Map();
  const historyDetailSelection = new Map();
  const networkOutput = ([genes, edges]) => `${genes} genes · ${edges} edges`;
  const historySteps = ["genotype", "expression", "adjust", "cis", "network", "visualize"];
  function historyDate(value) {
    if (!value) return notRecorded();
    if (typeof value !== "string") return recordedValue(value);
    const label = value.replace("T", " ").replace(/\s*(?:[+-]\d{2}:?\d{2}|Z)$/, "");
    return `<time datetime="${escapeHistory(value)}">${escapeHistory(label)}</time>`;
  }
  const notRecorded = () => "Not recorded";

  const genotypeHistoryStates = {
    submitting: "Submitting", submitted: "Submitted",
    pending: "Queued", running: "Running",
    validating: "Checking outputs", completed: "Completed",
    failed: "Failed", cancelling: "Cancelling", cancelled: "Cancelled",
    unknown: "Status unconfirmed", not_submitted: "Not submitted",
    ready: "Ready to review", result_available: "Saved result",
    prepared: "Prepared; execution not recorded",
    process_completed: "Process completed; scientific outputs unverified",
    configured: "Configured; execution not recorded",
    recorded: "Tool activity recorded",
    verified_completed: "Technical outputs verified",
    starting: "Execution start unconfirmed",
    not_recorded: "Not recorded",
  };
  const genotypeHistoryState = state => genotypeHistoryStates[state] ?? (state ? state : "Not recorded");
  const historyJob = run => Object.values(run.jobs ?? {}).filter(job => job && typeof job === "object")
    .sort((a, b) => (Date.parse(a.finished_at || a.submitted_at) || 0) - (Date.parse(b.finished_at || b.submitted_at) || 0)).at(-1);
  const historyTime = run => Date.parse(run.finished_at || historyJob(run)?.finished_at || run.submitted_at || historyJob(run)?.submitted_at) || 0;
  const historySourceName = run => ({workspace: "Workspace run", slurm: "Legacy scheduler job",
    agent: "Agent tool record", archive: "Archived result"})[run.origin] ?? "Source not recorded";
  const associationName = run => run.association?.status === "manual" ? "Manually assigned"
    : run.dataset_id ? "Recorded dataset" : "Unclassified";
  const historyStateLabel = (state, savedOnly = false) => (savedOnly ? "Last recorded state: " : "") + escapeHistory(genotypeHistoryState(state));
  const historyStatusBadge = (state, savedOnly = false, runHeader = false) =>
    `<span class="ml-history-status" data-state="${escapeHistory(state ?? "not_recorded")}"${runHeader ? " data-history-state" : ""}>${historyStateLabel(state, savedOnly)}</span>`;
  const assignmentStates = new Map();
  const submissionReviews = new Map();
  let recoveryRemote = "";
  window.addEventListener("workspace-remote-context", event => {
    const next = JSON.stringify({connected: event.detail?.connected === true, identity: event.detail?.identity ?? "", environmentKey: event.detail?.environmentKey ?? ""});
    if (next !== recoveryRemote) submissionReviews.clear();
    recoveryRemote = next;
  });
  function submissionRecovery(run, step, job) {
    if (!canContinue(run) || !["unknown", "submitting"].includes(job?.state)) return "";
    const key = `${historyKey(run)}:${step}:${job.attempt ?? 1}`;
    const review = submissionReviews.get(key);
    const status = review?.staleEvidence ? "Evidence changed or review is incomplete. Review the evidence again."
      : escapeHistory(review?.error ?? review?.result?.recovery?.detail ?? "");
    return `<form data-submission-recovery="${escapeHistory(key)}" data-step="${escapeHistory(step)}">
      <p>Submission is unconfirmed. Reconciliation only reads this attempt’s receipt and scheduler evidence; it never submits or cancels jobs.</p>
      <button class="ml-nav-action" type="submit" value="review" ${review?.pending ? "disabled" : ""}>Review submission evidence</button>
      <p role="status">${status}</p>
      ${review?.result ? `<dl class="ml-key-values">${savedDefinitions(review.result.recovery.evidence)}</dl>` : ""}
      ${review?.result && ["adopt", "unsubmitted"].includes(review.result.recovery.outcome) ? `<p>Review the source, job and attempt. Confirmation updates the record only; an unsubmitted attempt still requires the normal retry review.</p><button class="ml-nav-action" type="submit" value="${review.result.recovery.outcome}" ${review.pending ? "disabled" : ""}>Confirm this recovery result</button>` : ""}
      <p>${escapeHistory(run.run_id)} · ${escapeHistory(step)} · ${job.attempt ?? 1} · ${escapeHistory(job.job_id ?? "—")}</p>
    </form>`;
  }

  const historyDatasetName = id => datasets.find(dataset => dataset.id === id)?.name ?? (id ? id : "Unclassified");
  const recordedValue = value => value == null ? notRecorded() : escapeHistory(typeof value === "object" ? JSON.stringify(value) : value);
  const submissionAudit = job => Array.isArray(job.submission_checks) && job.submission_checks.length ?
    `<details><summary>Submission reconciliation audit</summary>${job.submission_checks.slice(-25).map(check => `<p>${historyDate(check.at)} · ${recordedValue(check.action)} · ${recordedValue(check.outcome)}<br>${recordedValue(check.detail)}<br>${recordedValue(check.evidence)}</p>`).join("")}</details>` : "";
  const savedDefinitions = value => Object.entries(value ?? {}).map(([key, item]) =>
    `<dt>${escapeHistory(key)}</dt><dd>${recordedValue(item)}</dd>`).join("") || `<dt>Contents</dt><dd>${notRecorded()}</dd>`;
  function savedJobSummary(job, operation = false) {
    return `${submissionAudit(job)}
        <dl class="ml-key-values"><dt>Job ID</dt><dd>${recordedValue(job.job_id)}</dd>
          <dt>Submitted at</dt><dd>${historyDate(job.submitted_at)}</dd>
          <dt>Started at</dt><dd>${historyDate(job.started_at)}</dd>
          <dt>Finished at</dt><dd>${historyDate(job.finished_at ?? job.ended_at)}</dd>
          ${operation ? `<dt>Executed</dt><dd>${job.executed === true ? "Yes" : job.executed === false ? "No" : notRecorded()}</dd>` : ""}
          <dt>Record source</dt><dd>${recordedValue(job.record_file)}</dd>
          ${job.reason ? `<dt>Reason</dt><dd>${recordedValue(job.reason)}</dd>` : ""}</dl>`;
  }
  function savedJobSettings(job) {
    const evidence = job.settings_evidence ?? (Object.keys(job.settings ?? {}).length || Object.keys(job.options ?? {}).length ? "recorded" : "not_recorded");
    const evidenceCopy = ({recorded: "Recorded settings", prepared_snapshot: "Prepared settings; execution not implied",
      not_recorded: "Settings not recorded"})[evidence] ?? evidence;
    return `<p data-settings-evidence="${escapeHistory(evidence)}">${escapeHistory(evidenceCopy)}</p>
        ${[["inputs", "Saved inputs"], ["settings", "Saved settings"], ["options", "Saved options"], ["resources", "Saved resources"]]
          .filter(([field]) => field !== "options" || Object.keys(job.options ?? {}).length)
          .map(([field, title]) => `<h4>${escapeHistory(title)}</h4><dl class="ml-key-values" data-history-saved="${field}">${savedDefinitions(job[field])}</dl>`).join("")}`;
  }
  const savedJobContent = (job, operation) => savedJobSummary(job, operation) + savedJobSettings(job);
  const attemptResultNames = {
    recorded_completed: "Recorded as completed",
    recorded_failed: "Recorded as failed",
    recorded_cancelled: "Recorded as cancelled",
    pending: "Final result not recorded",
    not_recorded: "Result not recorded",
  };
  function outputCheckSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "";
    return `<dl class="ml-key-values">${[["state", "State"], ["reason", "Reason"],
      ["slurm_state", "Scheduler state"], ["exit_code", "Exit code"],
      ["missing_outputs", "Missing outputs at the time"], ["failure_hints", "Failure hints"]]
      .filter(([field]) => snapshot[field] != null)
      .map(([field, label]) => `<dt>${escapeHistory(label)}</dt><dd>${field === "state" ? historyStateLabel(snapshot[field]) : recordedValue(snapshot[field])}</dd>`).join("")}</dl>
      ${["missing_outputs", "failure_hints"].filter(field => Array.isArray(snapshot[field]) && Number.isSafeInteger(snapshot[field + "_total"]) && snapshot[field + "_total"] > snapshot[field].length)
        .map(field => `<p data-history-output-check-truncated>${escapeHistory(`This check summary shows the first ${snapshot[field].length} of ${snapshot[field + "_total"]} items.`)}</p>`).join("")}`;
  }
  function savedOutputChecks(record) {
    const checks = Array.isArray(record.output_checks) ? record.output_checks.filter(check => check && typeof check === "object").slice(-25) : [];
    if (!checks.length && !record.original_failure) return "";
    const total = Number.isSafeInteger(record.output_checks_total) && record.output_checks_total >= checks.length ? record.output_checks_total : checks.length;
    return `<details data-history-output-checks data-output-check-detail="all"><summary>Output recheck history · ${total}</summary>
      <p>These checks belong to the same job and attempt; no new analysis was submitted.</p>
      ${record.original_failure ? `<h4>Original recorded failure</h4><div data-history-original-failure>${outputCheckSnapshot(record.original_failure)}</div>` : ""}
      <ol>${checks.map((check, index) => `<li data-history-output-check>${historyDate(check.at)}
        <details data-output-check-detail="${total - checks.length + index}-before"><summary>Before the check</summary>${outputCheckSnapshot(check.before)}</details>
        <details data-output-check-detail="${total - checks.length + index}-after"><summary>After the check</summary>${outputCheckSnapshot(check.after)}</details></li>`).join("")}</ol>
      ${total > checks.length ? `<p>${escapeHistory(`Showing the latest ${checks.length} checks; the original failure remains preserved.`)}</p>` : ""}
    </details>`;
  }
  function savedAttemptResult(attempt) {
    const result = attempt.result ?? {};
    const record = attempt.record ?? {};
    const outputs = Array.isArray(result.outputs) ? result.outputs.filter(output => output && typeof output.path === "string") : [];
    const outputStatus = {downloaded: "Recorded as downloaded", remote: "Results retained on HPC3", missing: "Recorded as missing",
      not_recorded: "File status not recorded"};
    return `<section class="ml-history-attempt-result" data-history-attempt-result>
      <h4>Saved result</h4>
      <p>${escapeHistory(attemptResultNames[result.status] ?? attemptResultNames.not_recorded)}</p>
      <dl class="ml-key-values">${[["slurm_state", "Scheduler state"], ["exit_code", "Exit code"],
        ["failure_hints", "Recorded failure hints"], ["missing_outputs", "Missing outputs at the time"]]
        .filter(([field]) => record[field] != null)
        .map(([field, label]) => `<dt>${escapeHistory(label)}</dt><dd>${recordedValue(record[field])}</dd>`).join("")}</dl>
      ${outputs.length ? `<ul class="ml-history-attempt-outputs">${outputs.map(output => `<li><code>${recordedValue(output.path)}</code> · ${escapeHistory(outputStatus[output.status] ?? outputStatus.not_recorded)}</li>`).join("")}</ul>` : ""}
    </section>`;
  }
  const attemptAvailable = attempt => attempt.availability === "recorded" && Boolean(attempt.record);
  const attemptName = attempt => attempt.number == null ? "Attempt number not recorded"
    : `Attempt ${attempt.number}`;
  const attemptState = attempt => attemptAvailable(attempt) ? genotypeHistoryState(attempt.record.state ?? attempt.record.status)
    : attempt.availability === "invalid" ? "Saved record unreadable" : "Saved record missing";
  const attemptStatusBadge = attempt => attemptAvailable(attempt)
    ? historyStatusBadge(attempt.record.state ?? attempt.record.status)
    : `<span class="ml-history-status" data-state="warning">${escapeHistory(attemptState(attempt))}</span>`;
  const sortAttempts = attempts => [...attempts].sort((a, b) => Number(b.current) - Number(a.current) || (b.number ?? 0) - (a.number ?? 0));
  const attemptAttributes = attempt => `data-history-attempt="${escapeHistory(attempt.number ?? "unknown")}" data-attempt-record="${escapeHistory(attempt.record_file)}" data-attempt-current="${attempt.current === true}" data-attempt-available="${attemptAvailable(attempt)}"`;
  const logHost = (kind, file) => `<div data-history-job-logs data-log-kind="${kind}" data-log-record="${escapeHistory(file)}"></div>`;

  function savedAttemptEvidence(attempt) {
    const savedEvents = attempt.record?.history;
    const events = Array.isArray(savedEvents) ? savedEvents.filter(event => event && typeof event.state === "string" && typeof event.at === "string") : [];
    const unreadableEvents = savedEvents != null && (!Array.isArray(savedEvents) || events.length !== savedEvents.length);
    return `${(attempt.issues ?? []).length ? `<p class="ml-history-record-note">${attempt.issues.map(escapeHistory).join(" ")}</p>` : ""}
      ${events.length ? `<h4>Recorded state timeline</h4><ol class="ml-history-attempt-events" data-history-attempt-events>${events.map(event => `<li>${escapeHistory(genotypeHistoryState(event.state))} · ${historyDate(event.at)}${event.reason ? ` · ${recordedValue(event.reason)}` : ""}</li>`).join("")}</ol>` : ""}
      ${unreadableEvents ? `<p data-history-attempt-event-warning>Part of the recorded timeline is unreadable.</p>` : ""}`;
  }
  const unavailableAttempt = attempt => `<p>The inputs, settings and results of this attempt cannot be confirmed from the saved records.</p><p>Record source · <code>${recordedValue(attempt.record_file)}</code></p>`;
  function savedAttempts(attempts) {
    return `<div class="ml-history-attempts">${sortAttempts(attempts).map(attempt => `<details class="ml-history-attempt" ${attemptAttributes(attempt)}>
      <summary>${escapeHistory(attemptName(attempt))}${attempt.current ? ` · Current record` : ""}
        <span class="ml-history-attempt-state">${attemptAvailable(attempt) ? historyStateLabel(attempt.record.state ?? attempt.record.status, true) : escapeHistory(attemptState(attempt))}</span></summary>
      <div class="ml-history-job-content">
        ${attemptAvailable(attempt) ? savedJobContent({...attempt.record, record_file: attempt.record_file}) + savedAttemptResult(attempt) + savedOutputChecks(attempt.record) : unavailableAttempt(attempt)}
        ${savedAttemptEvidence(attempt)}${attemptAvailable(attempt) ? logHost("attempt", attempt.record_file) : ""}
      </div></details>`).join("")}</div>`;
  }
  function savedJobDetails(job, key, operation = false, savedOnly = false, attempts = []) {
    return `<details class="ml-run-step ml-history-saved-job" ${operation ? `data-history-operation="${escapeHistory(key)}" data-history-operation-record="${escapeHistory(job.record_file)}"` : `data-history-job="${escapeHistory(key)}"`}>
      <summary>${escapeHistory(key)} <span data-history-job-state>${historyStateLabel(job.state ?? job.status, savedOnly || operation)}</span>
        ${attempts.length ? `<span class="ml-history-attempt-count">${escapeHistory(`Attempt records (${attempts.length})`)}</span>` : ""}</summary>
      ${attempts.length ? savedAttempts(attempts) : `<div class="ml-history-job-content">${savedJobContent(job, operation)}${logHost(operation ? "operation" : "job", job.record_file)}</div>`}</details>`;
  }
  function stageHistoryAttemptPicker(records) {
    if (!records.length) return "";
    const label = "Attempt";
    const currentLabel = "Current record";
    if (records.length === 1) {
      const attempt = records[0];
      return `<div class="ml-history-attempt-picker" data-history-attempt-single>${label}
        <strong>${escapeHistory(attemptName(attempt))}</strong>${attemptStatusBadge(attempt)}${attempt.current ? currentLabel : ""}</div>`;
    }
    const richOptions = globalThis.CSS?.supports?.("appearance", "base-select") === true;
    const option = attempt => {
      const value = escapeHistory(attempt.record_file);
      const name = attemptName(attempt);
      if (richOptions) {
        return `<option value="${value}"><span class="ml-history-attempt-option-name">${escapeHistory(name)}</span> ${attemptStatusBadge(attempt)}</option>`;
      }
      const state = attemptState(attempt);
      const label = `${name} · ${state}${attempt.current ? " · Current record" : ""}`;
      return `<option value="${value}">${escapeHistory(label)}</option>`;
    };
    const group = (label, entries) => entries.length
      ? `<optgroup><legend>${label}</legend>${entries.map(option).join("")}</optgroup>` : "";
    const options = richOptions && records.some(attempt => attempt.current)
      ? group(currentLabel, records.filter(attempt => attempt.current)) +
        group("Previous attempts", records.filter(attempt => !attempt.current))
      : records.map(option).join("");
    return `<label class="ml-history-attempt-picker">${label}<select data-history-attempt-select>${richOptions ? "<button type=\"button\"><selectedcontent></selectedcontent></button>" : ""}${options}</select></label>`;
  }
  function stageHistoryDetails({job, step, attempts, rerun, recovery, panelId}) {
    if (!job && !attempts.length) {
      return `<div class="ml-history-stage-details"><p>No job details were saved for this stage.</p></div>`;
    }
    const records = sortAttempts(attempts);
    const views = (attempt) => {
      const available = !attempt || attemptAvailable(attempt);
      const source = attempt ? {...attempt.record, record_file: attempt.record_file} : job;
      const current = !attempt || attempt.current;
      const summary = available ? `<p class="ml-history-attempt-state" data-history-job-state>${historyStateLabel(source.state ?? source.status, true)}</p>` +
        savedJobSummary(source) + (attempt ? savedAttemptResult(attempt) + savedAttemptEvidence(attempt) : "") +
        savedOutputChecks(source) + (current ? recovery : "") : unavailableAttempt(attempt) + savedAttemptEvidence(attempt);
      return `<div class="ml-history-attempt-panel" data-history-attempt-panel ${attempt ? attemptAttributes(attempt) : ""}>
        <div class="ml-history-job-content" data-history-detail-view="summary">${summary}</div>
        <div class="ml-history-job-content" data-history-detail-view="settings" hidden>${available ? savedJobSettings(source) + (current ? rerun : "") : unavailableAttempt(attempt)}</div>
        <div class="ml-history-job-content" data-history-detail-view="logs" hidden>${available ? logHost(attempt ? "attempt" : "job", source.record_file) : unavailableAttempt(attempt)}</div>
      </div>`;
    };
    const tabs = [["summary", "Summary"], ["settings", "Settings"], ["logs", "Logs"]];
    return `<div class="ml-history-stage-details" data-history-job="${step}">
      ${stageHistoryAttemptPicker(records)}
      <div class="ml-history-stage-tabs" role="group" aria-label="Stage details">${tabs.map(([tab, label]) =>
        `<button type="button" data-history-detail-tab="${tab}" aria-controls="${panelId}-attempts" aria-pressed="${tab === "summary"}">${label}</button>`).join("")}</div>
      <div id="${panelId}-attempts">${records.length ? records.map(views).join("") : views(null)}</div>
    </div>`;
  }
  function syncHistoryStageDetail(panel) {
    const selected = historyDetailSelection.get(panel.id) ?? {};
    const tab = selected.tab ?? "summary";
    const picker = panel.querySelector("[data-history-attempt-select]");
    if (picker) {
      picker.value = selected.record ?? picker.options[0].value;
      if (picker.selectedIndex === -1) picker.selectedIndex = 0;
    }
    for (const button of panel.querySelectorAll("[data-history-detail-tab]")) {
      button.setAttribute("aria-pressed", String(button.dataset.historyDetailTab === tab));
    }
    for (const attempt of panel.querySelectorAll("[data-history-attempt-panel]")) {
      attempt.hidden = Boolean(picker) && attempt.dataset.attemptRecord !== picker.value;
      for (const view of attempt.querySelectorAll("[data-history-detail-view]")) view.hidden = view.dataset.historyDetailView !== tab;
    }
  }
  function syncHistoryStageSelection(article) {
    const choices = [...article.querySelectorAll("[data-history-select-stage]")];
    if (!choices.length) return;
    const stage = historyStageSelection.get(article.dataset.historyId) ?? article.dataset.historyDefaultStage;
    for (const choice of choices) {
      const selected = choice.dataset.historySelectStage === stage;
      choice.setAttribute("aria-pressed", String(selected));
      article.querySelector(`#${CSS.escape(choice.getAttribute("aria-controls"))}`).hidden = !selected;
    }
  }
  function canStartStage(run, number) {
    return canContinue(run) && number > 1 && historySteps.slice(0, number - 1).every(step => run.jobs?.[step]?.state === "completed");
  }
  function historyDisclosureKey(details) {
    const job = details.closest("[data-history-job], [data-history-operation]");
    const stage = details.closest("[data-history-stage-step]")?.dataset.historyStageStep;
    const scope = details.hasAttribute("data-rerun-form") ? `rerun-form:${stage}` : job?.dataset.historyJob ?? (job?.dataset.historyOperation ? `${job.dataset.historyOperation}:${job.dataset.historyOperationRecord}`
      : details.hasAttribute("data-history-rerun-changes") ? "rerun-changes"
        : details.hasAttribute("data-history-provenance") ? "provenance" : "inputs");
    const outputCheck = details.dataset.outputCheckDetail;
    const record = outputCheck ? details.closest("[data-attempt-record]")?.dataset.attemptRecord : "";
    return `${details.closest("[data-history-id]")?.dataset.historyId}|${scope}|${details.dataset.attemptRecord ?? details.dataset.historyAttempt ?? record ?? ""}${outputCheck ? `|output-check:${outputCheck}` : ""}`;
  }
  function rerunFamilyLabel(run) {
    const family = run.rerun_family;
    if (run.source !== "live" || !Number.isSafeInteger(family?.number) || family.number < 0) return "";
    return (family.number === 0 ? "Original run" : escapeHistory(`Rerun ${family.number}`)) +
      (family.latest ? " · Latest" : "");
  }
  function rerunChanges(run) {
    const family = run.rerun_family;
    if (!family?.number) return "";
    const groups = {settings: "Parameters", resources: "Resources", options: "Stage options", clinical_choices: "Clinical choices"};
    const parameterName = change => escapeHistory({cpus: "CPU cores", mem_gb: "Memory", hours: "Time limit", npc: "Principal components"}[change.key] ?? savedSettingLabels[change.key] ?? change.key);
    const changes = Array.isArray(family.changes) ? family.changes : [];
    return `<details data-history-rerun-changes><summary>Changes in this rerun</summary>
      <p>Compared with source run: <code>${recordedValue(family.source_run)}</code></p>
      ${changes.length ? `<table class="ml-rerun-diff"><caption>Recorded setting differences</caption><thead><tr>
        ${["Setting", "Source value", "This run"].map(text => `<th scope="col">${text}</th>`).join("")}</tr></thead>
        <tbody>${changes.map(change => `<tr><th scope="row">${escapeHistory(groups[change.group] ?? change.group)} · ${parameterName(change)}</th>
          <td>${recordedValue(change.before)}</td><td>${recordedValue(change.after)}</td></tr>`).join("")}</tbody></table>` :
        `<p>${family.changes_available ? "No parameter differences were recorded." : "The source or rerun settings were not fully retained for comparison."}</p>`}
      </details>`;
  }
  function historyFileGroup(label, files) {
    const paths = Array.isArray(files) ? files.filter(file => typeof file === "string" && file) : [];
    const rows = paths.map(path => {
      const name = path.replace(/\/+$/, "").split("/").at(-1) || path;
      const pathMarkup = path.split("/").map(escapeHistory).join("/<wbr>");
      return `<li>${name === path ? "" : `<strong class="ml-history-file-name">${escapeHistory(name)}</strong>`}
        <code class="${name === path ? "ml-history-file-name" : "ml-history-file-path"}" data-history-file-path dir="ltr">${pathMarkup}</code></li>`;
    }).join("");
    return `<div class="ml-history-file-group" data-history-file-group><dt>${escapeHistory(label)}</dt>
      <dd>${rows ? `<ul class="ml-history-file-rows">${rows}</ul>` : `<span class="ml-history-file-missing">${notRecorded()}</span>`}</dd></div>`;
  }
  function renderHistoryRecords() {
    const expanded = new Set([...runDetails.querySelectorAll("details[open]:not([data-job-logs])")].map(details =>
      historyDisclosureKey(details)));
    for (const {view} of historyLogViews) view.destroy();
    historyLogViews = [];
    runList.innerHTML = historyRuns.map(run => {
      const key = escapeHistory(historyKey(run)), id = escapeHistory(run.run_id);
      const state = run.status ?? historyJob(run)?.state;
      const started = run.submitted_at ?? run.jobs?.genotype?.submitted_at ?? historyJob(run)?.submitted_at;
      const icon = state === "completed" ? "circle-check" : "history";
      return `<button class="ml-nav-list-item ml-history-list-item" type="button" data-run-target="${key}" data-history-id="${key}" data-run-id="${id}" aria-controls="ml-run-${key}" aria-pressed="false">
        <i data-lucide="${icon}" aria-hidden="true"></i><span class="ml-history-list-copy">
        <span class="ml-history-list-title"><strong>${escapeHistory(run.name)}</strong>${historyStatusBadge(state, run.source === "recorded")}</span>
        <span class="ml-history-list-meta">${escapeHistory(historySourceName(run))}${started ? historyDate(started) : ""}</span>
        ${rerunFamilyLabel(run) ? `<small data-rerun-family-label>${rerunFamilyLabel(run)}</small>` : ""}
        </span></button>`;
    }).join("");
    runDetails.innerHTML = historyRuns.map(run => {
      const key = escapeHistory(historyKey(run)), id = escapeHistory(run.run_id);
      const initialJob = run.jobs?.genotype ?? historyJob(run);
      const finished = run.finished_at ?? historyJob(run)?.finished_at;
      const state = run.status ?? historyJob(run)?.state;
      const summary = canReadGraph(run) && run.graph ? escapeHistory(networkOutput([run.graph.genes, run.graph.connections])) : "";
      const canResume = canContinue(run);
      const hasStages = canResume || historySteps.some((step, offset) => run.jobs?.[step] || run.attempts?.[step]?.length ||
        canReadStage(run, offset + 1)) || canReadGraph(run);
      const stages = hasStages ? historySteps.map((step, offset) => {
        const job = run.jobs?.[step], number = offset + 1;
        const attempts = run.attempts?.[step] ?? [];
        const readable = canReadStage(run, number) || number === 6 && canReadGraph(run);
        const ready = canStartStage(run, number);
        const linked = readable || canResume && (Boolean(job) && job.state !== "not_submitted" &&
          (number > 1 || job.state !== "completed") || ready);
        const stageState = ready && (!job || job.state === "not_submitted") ? "ready" : job?.state ??
          (readable ? "result_available" : canResume ? "not_submitted" : "not_recorded");
        const panel = number === 1 && canResume && job?.state !== "completed" ? "lens-stage1"
          : number === 6 && canResume && job?.state !== "completed" ? "lens-stage6-run"
          : [2, 3, 4, 5].includes(number) && canResume && job?.state !== "completed" ? `lens-stage${number}`
          : number === 3 ? "lens-history-stage3" : number === 6 ? "lens-stage6" : "lens-history-stage";
        const action = readable ? "View stage results" : stageState === "ready"
          ? "Review settings" : "View status";
        const headingId = `ml-run-${key}-stage-${number}`;
        const panelId = `${headingId}-details`;
        const link = linked ? `<button type="button" class="ml-run-step-link" data-run-stage="${number}" data-run-id="${id}" data-history-id="${key}" aria-controls="${panel}" aria-describedby="${headingId}">
          ${action}<i data-lucide="arrow-right" aria-hidden="true"></i></button>` : "";
        const rerun = run.source === "live" && !run.dataset_deleted && job?.state === "completed" ? `<details data-rerun-form><summary>Review parameters and create linked run</summary>
          <button type="button" class="ml-nav-action" data-rerun-review="${step}" data-rerun-source="${id}">Load original parameters and impact</button><div data-rerun-content></div><p role="status" data-rerun-status></p></details>` : "";
        const name = escapeHistory(stageData[offset].name);
        return {number, recorded: Boolean(job) && job.state !== "not_submitted" || attempts.length > 0 || readable,
          choice: `<button class="ml-history-stage-choice" type="button" data-history-select-stage="${number}" aria-controls="${panelId}" aria-pressed="false">
            <span class="ml-history-stage-index">${number}</span><span class="ml-history-stage-choice-name">${name}</span>
            ${historyStatusBadge(stageState, Boolean(job) && run.source === "recorded")}</button>`,
          panel: `<section class="ml-history-stage-panel" id="${panelId}" data-history-stage-panel="${number}" data-history-stage-step="${step}" aria-labelledby="${headingId}" hidden>
            <header class="ml-history-stage-panel-header"><div><h4 id="${headingId}">${name}</h4></div>${link}</header>
            ${stageHistoryDetails({job, step, attempts, rerun, recovery: submissionRecovery(run, step, job), panelId})}</section>`};
      }) : [];
      const defaultStage = stages.find(stage => stage.recorded)?.number ?? 1;
      const genericJobs = [...new Set([...Object.keys(run.jobs ?? {}), ...Object.keys(run.attempts ?? {})])].filter(step => !historySteps.includes(step))
        .map(step => savedJobDetails(run.jobs?.[step] ?? {}, step, false, run.source === "recorded", run.attempts?.[step])).join("");
      const operations = (run.operations ?? []).map(operation => savedJobDetails(operation, operation.operation ?? "operation", true)).join("");
      const snapshot = inputTypes.map(([type, label]) => historyFileGroup(label, run.inputs?.[type])).join("");
      const references = referenceTypes.flatMap(([, label, role]) => {
        const value = run.reference_sources?.[role];
        return typeof value === "string" && value ? [historyFileGroup(label, [value])] : [];
      }).join("");
      const assignment = assignmentStates.get(historyKey(run)) ?? {};
      const association = escapeHistory(associationName(run));
      const associationNote = run.association?.status === "manual" ? "This assignment organizes records; it does not verify sample or file matching." : "";
      const rerunLabel = rerunFamilyLabel(run);
      const linkedSource = run.rerun ? `<p data-rerun-link>Linked source · <code>${escapeHistory(run.rerun.source_run_id)}</code> · ${escapeHistory(run.rerun.step)}</p>` : "";
      const assignForm = run.capabilities?.assign_dataset ? `<form class="ml-history-assignment" data-history-assignment="${key}" data-save-state="${assignment.saving ? "saving" : assignment.error ? "error" : assignment.saved ? "saved" : "idle"}">
        <label><span>Assign to dataset</span><select data-history-dataset ${assignment.saving || !datasetCatalogReady ? "disabled" : ""}>
          <option value="">Choose an existing dataset</option>
          ${datasets.filter(dataset => dataset.persisted).map(dataset => `<option value="${escapeHistory(dataset.id)}" ${(assignment.datasetId ?? run.dataset_id) === dataset.id ? "selected" : ""}>${escapeHistory(dataset.name)}</option>`).join("")}</select></label>
        <button type="submit" class="ml-nav-action" data-history-assign ${assignment.saving || !datasetCatalogReady ? "disabled" : ""}>${escapeHistory(assignment.saving ? "Saving…" : "Save assignment")}</button>
        <p data-history-assignment-status role="status">${assignment.error ? escapeHistory(assignment.error) : assignment.saved ? "Assignment saved." : "Organizes run history only; files, settings and sample matching are unchanged."}</p></form>` : "";
      return `<article class="ml-history-run" id="ml-run-${key}" data-history-id="${key}" data-run-id="${id}" data-history-default-stage="${defaultStage}" hidden>
        <header class="ml-dataset-intro ml-history-intro">
          <span class="ml-dataset-intro-icon" aria-hidden="true"><i data-lucide="history"></i></span>
          <div><h2>${escapeHistory(run.name)}</h2><p><code>${id}</code></p></div>
          ${historyStatusBadge(state, run.source === "recorded", true)}
        </header>
        <dl class="ml-history-overview">
          <div><dt>Dataset</dt><dd data-history-association>${escapeHistory(historyDatasetName(run.dataset_id))}
            ${run.dataset_deleted ? "<small>Dataset deleted</small>" : associationNote ? `<small>${association} · ${associationNote}</small>` : ""}</dd></div>
          <div><dt>Submitted</dt><dd>${historyDate(run.submitted_at ?? initialJob?.submitted_at)}</dd></div>
          ${finished ? `<div><dt>Latest finish</dt><dd>${historyDate(finished)}</dd></div>` : ""}
          ${summary ? `<div><dt>Network result</dt><dd>${summary}</dd></div>` : ""}
        </dl>
        <section class="ml-history-metadata">
          <header class="ml-history-files-heading">
            <h3>Input files at execution</h3>
            ${rerunLabel ? `<span data-rerun-family-label>${rerunLabel}</span>` : ""}
          </header>
          <dl class="ml-run-inputs ml-history-file-list">${snapshot}${references}</dl>
          ${run.provenance ? `<details class="ml-run-inputs" data-history-provenance><summary>Recorded run provenance</summary><dl class="ml-key-values">${savedDefinitions(run.provenance)}</dl></details>` : ""}
          ${rerunChanges(run)}
          ${linkedSource}
          ${assignForm}
          ${(run.issues ?? []).length ? `<p class="ml-history-record-note">${run.issues.map(escapeHistory).join(" ")}</p>` : ""}
          ${run.rerun && run.source === "live" && (!run.jobs?.[run.rerun.step] || run.jobs[run.rerun.step].state === "not_submitted") ? `<div data-rerun-form><p>Linked run created; not submitted. Confirmation checks remote upstream files and submits the stage.</p><button type="button" class="ml-nav-action" data-rerun-submit data-rerun-run-id="${id}">Confirm submission · ${id}</button><div data-rerun-content></div><p role="status" data-rerun-status></p></div>` : ""}
        </section>
        ${stages.length ? `<section class="ml-history-section"><h3>Run stages</h3>
          <div class="ml-history-stage-workspace"><div class="ml-history-stage-list" role="group" aria-label="Run stages">${stages.map(stage => stage.choice).join("")}</div>
          <div class="ml-history-stage-content">${stages.map(stage => stage.panel).join("")}</div></div></section>` : ""}
        ${genericJobs || operations ? `<section class="ml-history-section"><h3>Other recorded activity</h3>${genericJobs}${operations}</section>` : ""}
        ${!stages.length && !genericJobs && !operations ? `<p>No readable job settings were recorded.</p>` : ""}
      </article>`;
    }).join("");
    for (const details of runDetails.querySelectorAll("details:not([data-job-logs])")) {
      if (expanded.has(historyDisclosureKey(details))) details.open = true;
    }
    for (const article of runDetails.querySelectorAll(".ml-history-run")) syncHistoryStageSelection(article);
    for (const panel of runDetails.querySelectorAll("[data-history-stage-panel]")) syncHistoryStageDetail(panel);
    if (globalThis.SignetJobLogs) for (const host of runDetails.querySelectorAll("[data-history-job-logs]")) {
      const run = findHistoryRun(host.closest("[data-history-id]").dataset.historyId);
      const step = host.closest("[data-history-job]")?.dataset.historyJob;
      const operation = host.closest("[data-history-operation]")?.dataset.historyOperation;
      const attempt = host.dataset.logKind === "attempt" ? run.attempts?.[step]?.find(attempt => attempt.record_file === host.dataset.logRecord) : null;
      const record = operation ? run.operations?.find(record => record.operation === operation && record.record_file === host.dataset.logRecord)
        : host.dataset.logKind === "attempt" ? attempt?.record : run.jobs?.[step];
      const context = {historyId: historyKey(run), runId: run.run_id, source: run.source, datasetId: run.dataset_id,
        step, operation, number: attempt ? attempt.number : run.source === "archive" ? null : record?.attempt ?? 1,
        current: attempt?.current ?? true, recordFile: attempt?.record_file ?? record?.record_file ?? `steps/${step}.json`,
        recordIdentity: run.record_identity, recordRevision: record?.record_revision, record,
        prepared: Boolean(operation && (record?.status === "prepared" || record?.record_file?.endsWith(".plan.json")))};
      const view = globalThis.SignetJobLogs.mount({host, token: () => chatToken, inline: Boolean(host.closest("[data-history-detail-view]"))});
      historyLogViews.push({view, context});
    }
    syncHistoryLogs();
    renderRunTimeline();
    globalThis.lucide?.createIcons();
  }

  function syncHistoryLogs() {
    for (const {view, context} of historyLogViews) view.setContext({...context, visible: app.dataset.nav === "history"});
  }

  const analysisNetwork = root.querySelector("#lens-stage6");
  const setLiveNetwork = mountNetwork(analysisNetwork);

  const input = byId("input");
  const initialChat = JSON.parse(document.getElementById("initial-chat").textContent);
  const chatToken = document.querySelector('meta[name="chat-token"]').content;
  const stage6Assets = window.mountStage6Assets?.({stage: analysisNetwork, token: chatToken});
  const chatModel = document.querySelector('meta[name="model-label"]').content;

  const stage6RunSelect = byId("stage6-run");
  const stage6Retry = byId("stage6-retry");
  const stage6Source = analysisNetwork.querySelector("[data-s6-run-label]");
  const stage6Status = analysisNetwork.querySelector(".s6-result-status");
  const stage6Summary = analysisNetwork.querySelector(".s6-summary");
  const stage6Back = byId("stage6-back");
  const stage6Prepare = byId("stage6-prepare");
  const visualizationPanel = root.querySelector("#lens-stage6-run");
  const stage6HistoryLabel = byId("stage6-history-run");
  const stage6Labels = {
    listing: "Finding completed runs…",
    empty: "No Stage 6 results are available.",
    choose: "Choose a completed run.",
    loading: "Loading network and connections…",
    "list-error": "Could not load completed runs.",
    "load-error": "Could not load this run’s results.",
    "no-edges": "This run has no exported edges.",
  };
  const selectedStage6Genes = new Map();
  const analysisRunByDataset = new Map();
  let stage6Result = null;
  let stage6Request;
  let requestedStage6Run = null;
  analysisNetwork.dataset.runState = "listing";

  function visualizationFormVisible() {
    if (app.dataset.nav === "history" || savedAnalysisView()) {
      const run = selectedHistoryResult();
      return historyResult?.stage === 6 && canContinue(run) && run.jobs.visualize?.state !== "completed";
    }
    if (!["analysis", "settings"].includes(app.dataset.nav)) return false;
    return timeline.querySelector('[aria-current="step"]')?.dataset.stage === "6" &&
      runsForDataset().some(canContinue) &&
      !stage6RunsForDataset().some(run => historyKey(run) === stage6RunSelect.value);
  }

  function syncVisualizationPanels() {
    const inHistory = app.dataset.nav === "history" || savedAnalysisView();
    const form = visualizationFormVisible();
    const graph = inHistory ? historyResult?.stage === 6 && !form
      : timeline.querySelector('[aria-current="step"]')?.dataset.stage === "6" && !form;
    visualizationPanel.classList.toggle("ml-workspace", !inHistory || !form);
    visualizationPanel.classList.toggle("ml-nav-workspace", inHistory && form);
    visualizationPanel.hidden = !form;
    analysisNetwork.classList.toggle("ml-workspace", !inHistory || !graph);
    analysisNetwork.classList.toggle("ml-nav-workspace", inHistory && graph);
    analysisNetwork.hidden = !graph;
    stage6Prepare.hidden = inHistory || !runsForDataset().some(canContinue);
  }

  function renderStage6Status() {
    const state = analysisNetwork.dataset.runState;
    const run = stage6RunsForView().find(run => historyKey(run) === stage6RunSelect.value);
    const empty = stage6Result?.graph.edges.length === 0;
    stage6Source.textContent = run ? historySourceName(run) : "Run";
    stage6RunSelect.options[0].textContent = "Select a run";
    stage6RunSelect.title = run?.run_id ?? "";
    stage6HistoryLabel.textContent = run?.name ?? "";
    stage6HistoryLabel.title = run?.run_id ?? "";
    stage6Status.hidden = state === "ready" && !empty;
    stage6Status.textContent = stage6Labels[empty ? "no-edges" : state] ?? "";
    stage6Summary.hidden = !stage6Status.hidden;
    stage6Retry.hidden = !["empty", "list-error", "load-error"].includes(state);
    renderRunTimeline();
  }

  function setStage6RunState(state) {
    analysisNetwork.dataset.runState = state;
    const ready = state === "ready";
    analysisNetwork.querySelectorAll(".s6-zoom input, .s6-zoom button").forEach(control => {
      control.disabled = !ready;
    });
    renderStage6Status();
  }

  async function getArchivedResult(path, options = {}) {
    const response = await fetch(path, {...options, headers: {"X-Chat-Token": chatToken}});
    if (!response.ok) {
      throw Object.assign(new Error("Could not load archived result"), {status: response.status});
    }
    return response.json();
  }

  async function getSavedStageResult(run, stage, signal) {
    const query = new URLSearchParams({run: run.run_id});
    if (stage !== 3 && stage !== 6) query.set("stage", stage);
    query.set("source", run.source);
    const path = stage === 3 ? "/stage3/results" : stage === 6 ? "/stage6/results" : "/stage/results";
    const result = await getArchivedResult(`${path}?${query}`, {signal});
    if (result.run_id !== run.run_id || (stage === 6 ? result.source !== run.source : stage !== 3 && result.stage !== stage)) {
      throw new Error("Result does not match the selected run and stage");
    }
    return result;
  }

  const resultReadTimeout = "Reading the results timed out. Select Retry loading result to try again.";
  function archivedResultErrorState(error) {
    if (error.status === 504) return "timeout";
    return error.status === 404 ? "empty" : "error";
  }

  function layoutStage6(genes) {
    const columns = Math.ceil(Math.sqrt(genes.length * 1.35));
    const rows = Math.ceil(genes.length / columns);
    const cells = genes.map((_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const rowCells = Math.min(columns, genes.length - row * columns);
      return [
        columns > 1 ? 50 + (column - (rowCells - 1) / 2) * (86 / (columns - 1)) : 50,
        rows > 1 ? 10 + row * (79 / (rows - 1)) : 50,
      ];
    });
    const hub = genes.indexOf("MEGF6");
    if (hub !== -1) {
      const distance = ([x, y]) => (x - 50) ** 2 + (y - 50) ** 2;
      const center = cells.reduce((nearest, cell, index) =>
        distance(cell) < distance(cells[nearest]) ? index : nearest, 0);
      [cells[hub], cells[center]] = [cells[center], cells[hub]];
    }
    return Object.fromEntries(genes.map((gene, index) => [gene, cells[index]]));
  }

  async function loadStage6Run(historyId) {
    stage6Assets?.clear();
    stage6Request?.abort();
    requestedStage6Run = historyId;
    renderRunTimeline();
    stage6Result = null;
    delete analysisNetwork.dataset.runId;
    delete analysisNetwork.dataset.historyId;
    setLiveNetwork({}, []);
    const matchingRuns = stage6RunsForView();
    const run = matchingRuns.find(run => historyKey(run) === historyId);
    if (!run) {
      const state = historyState === "error" ? "list-error" : historyState === "loading" ? "listing"
        : matchingRuns.length ? "choose" : "empty";
      setStage6RunState(state);
      return;
    }
    const request = new AbortController();
    stage6Request = request;
    setStage6RunState("loading");
    try {
      const runId = run.run_id;
      const result = await getSavedStageResult(run, 6, request.signal);
      if (request.signal.aborted) return;
      let {nodes, edges} = result.graph;
      if (run.source === "live" && result.graph.display_nodes) {
        const displayed = new Set(result.graph.display_nodes);
        nodes = nodes.filter(node => displayed.has(node));
        edges = edges.filter(edge => displayed.has(edge.source) && displayed.has(edge.target));
      }
      setLiveNetwork(layoutStage6(nodes), edges.map(({source, target, frequency, coefficient}) =>
        [source, target, frequency, coefficient]), selectedStage6Genes.get(historyId));
      stage6Result = {...result, history_id: historyId, graph: {...result.graph, nodes, edges,
        counts: {...result.graph.counts, genes: nodes.length, connections: edges.length}}};
      rememberTimelineResult(run, 6, result);
      analysisNetwork.dataset.runId = runId;
      analysisNetwork.dataset.historyId = historyId;
      setStage6RunState("ready");
      stage6Assets?.setContext({historyId, identity: run.record_identity, revision: run.revision, source: run.source, runId: run.run_id});
    } catch {
      if (!request.signal.aborted) {
        rememberTimelineResult(run, 6, null, "error");
        setLiveNetwork({}, []);
        setStage6RunState("load-error");
      }
    }
  }

  function syncStage6Choice() {
    if (stage6RunSelect.value !== requestedStage6Run) void loadStage6Run(stage6RunSelect.value);
    else renderStage6Status();
  }

  function syncStage6Picker(rebuild = false) {
    const runs = stage6RunsForView();
    if (rebuild) {
      stage6RunSelect.replaceChildren(new Option("", ""), ...runs.map(run => {
        const option = new Option(`${run.run_id} · ${historySourceName(run)}`, historyKey(run));
        option.dataset.runId = run.run_id;option.dataset.source = run.source;return option;
      }));
      stage6RunSelect.disabled = !runs.length;
    }
    const inHistory = app.dataset.nav === "history" && historyResult?.stage === 6;
    stage6RunSelect.hidden = inHistory;
    stage6HistoryLabel.hidden = !inHistory;
    stage6Back.hidden = !inHistory;
    stage6RunSelect.value = inHistory ? historyResult.historyId : analysisRunByDataset.get(activeDataset.id) ?? "";
    if (!stage6RunSelect.value) stage6RunSelect.value = "";
    syncStage6Choice();
    if (visualizationRun) syncVisualizationPanels();
  }

  stage6RunSelect.addEventListener("change", () => {
    analysisRunByDataset.set(activeDataset.id, stage6RunSelect.value);
    syncStage6Choice();
    syncVisualizationPanels();
  });
  stage6Prepare.addEventListener("click", () => {
    analysisRunByDataset.set(activeDataset.id, "");
    stage6RunSelect.value = "";
    syncStage6Choice();
    syncGenotypeContext();
  });
  stage6Retry.addEventListener("click", () => {
    if (analysisNetwork.dataset.runState === "load-error") void loadStage6Run(stage6RunSelect.value);
    else void loadWorkspaceHistory();
  });
  analysisNetwork.addEventListener("lens:gene-selected", ({detail}) => {
    if (stage6Result) selectedStage6Genes.set(stage6Result.history_id, detail.gene);
  });

  const stage3HistoryPanel = root.querySelector("#lens-history-stage3");
  const stage3Back = byId("stage3-back");
  const stage3Retry = byId("stage3-retry");
  const stage3Plot = stage3HistoryPanel.querySelector(".s3-chart");
  const stage3RemotePlot = document.createElement("img");
  stage3RemotePlot.className = "s3-remote-plot";
  stage3RemotePlot.hidden = true;
  stage3Plot.after(stage3RemotePlot);
  const stage3Legend = stage3HistoryPanel.querySelector("figcaption");
  const stage3Status = stage3HistoryPanel.querySelector("[data-s3-status]");
  const stage3RunLabel = stage3HistoryPanel.querySelector("[data-s3-run]");
  const stage3Components = stage3HistoryPanel.querySelector("[data-s3-components]");
  const stage3Counts = stage3HistoryPanel.querySelectorAll("[data-s3-count]");
  const stage3ComparisonRows = stage3HistoryPanel.querySelector("[data-s3-difference] tbody");
  const stage3MetricNote = stage3HistoryPanel.querySelector(".s3-metric-note");
  const stage3Comparison = [
    ["before", "Before adjustment", "before_sd"],
    ["covariates", "Adjusted for sex and race", "covariates_sd"],
    ["after", "After adjustment", "after_sd"],
  ];
  const stage3States = {
    loading: "Loading the archived Stage 3 result…",
    empty: "This run has no readable Stage 3 archive.",
    error: "Could not load the Stage 3 result.",
    timeout: resultReadTimeout,
  };
  let stage3Result = null;
  let stage3Request;

  function stage3Ticks(points, component) {
    let lowest = 0, highest = 0;
    for (const point of points) {
      lowest = Math.min(lowest, point[component]);
      highest = Math.max(highest, point[component]);
    }
    const targetStep = (highest - lowest) / 5 || 1;
    const magnitude = 10 ** Math.floor(Math.log10(targetStep));
    const step = Math.ceil(targetStep / magnitude) * magnitude;
    const start = Math.floor(lowest / step);
    const end = Math.max(start + 1, Math.ceil(highest / step));
    return Array.from({length: end - start + 1}, (_, offset) => (start + offset) * step);
  }

  function renderStage3History() {
    const locale = "en";
    const run = historyResult?.stage === 3
      ? selectedHistoryResult() : null;
    const state = stage3HistoryPanel.dataset.runState;
    const number = new Intl.NumberFormat(locale);
    const formatSD = new Intl.NumberFormat(locale, {maximumFractionDigits: 5, minimumFractionDigits: 5});
    const formatChange = new Intl.NumberFormat(locale, {maximumFractionDigits: 5, minimumFractionDigits: 5, signDisplay: "exceptZero"});
    const missing = "Not recorded";
    const comparison = stage3Result?.comparison;
    const pca = stage3Result?.pca;

    stage3RunLabel.textContent = run?.name ?? "";
    stage3RunLabel.title = run?.run_id ?? "";
    stage3RunLabel.previousElementSibling.textContent = run?.source === "live"
      ? "Run" : "Archived run";
    stage3Components.textContent = stage3Result ? number.format(stage3Result.npc) : "—";
    for (const count of stage3Counts) {
      const value = stage3Result?.matching[count.dataset.s3Count];
      count.textContent = Number.isInteger(value) ? number.format(value) : "—";
    }
    stage3Status.hidden = !stage3States[state];
    stage3Status.textContent = run?.source === "live" && state === "loading"
      ? "Loading the saved Stage 3 result…"
      : stage3States[state] ?? "";
    stage3Retry.hidden = !["error", "timeout"].includes(state);
    stage3HistoryPanel.querySelector(".s3-figure").hidden = state !== "ready";
    stage3HistoryPanel.querySelector(".ml-result-dock").hidden = state !== "ready";

    const remotePlot = typeof pca?.png_base64 === "string" && pca.png_base64.length <= 2_000_000 &&
      /^iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(pca.png_base64);
    stage3RemotePlot.hidden = !remotePlot;
    if (remotePlot) {
      stage3RemotePlot.src = "data:image/png;base64," + pca.png_base64;
      stage3RemotePlot.alt = "Principal component plot rendered on HPC3; individual scores stay remote.";
    } else stage3RemotePlot.removeAttribute("src");
    stage3Plot.toggleAttribute("hidden", Boolean(remotePlot) || !pca?.points?.length);
    if (remotePlot) {
      const variance = new Intl.NumberFormat(locale, {maximumFractionDigits: 2});
      stage3Legend.textContent = "Rendered on HPC3 · PC1 / PC2 explained variance: " +
        (pca.variance_explained ?? []).map(value => variance.format(value) + "%").join(" / ");
    } else if (pca?.points?.length) {
      const points = pca.points;
      drawStage3Scatter(stage3HistoryPanel, points, stage3Ticks(points, 0), stage3Ticks(points, 1));
      const variance = new Intl.NumberFormat(locale, {maximumFractionDigits: 2});
      const axisNames = ["PC1", "PC2"];
      stage3Plot.querySelectorAll(".s3-axis-title").forEach((axis, index) => {
        axis.textContent = `${axisNames[index]} · ${variance.format(pca.variance_explained[index])}%`;
      });
      stage3Plot.setAttribute("aria-label", `Scatter plot of ${number.format(points.length)} retained individuals on PC1 and PC2`);
      stage3Legend.textContent = pca.source === "signet_smartpca"
        ? "Each point is one retained individual. Coordinates and explained variance come from this run’s SIGNET PCA outputs."
        : ("Each point is one retained individual. The plot is reconstructed from the archived genotype data." );
    } else {
      stage3Plot.querySelector(".s3-points").replaceChildren();
      stage3Legend.textContent = "This archive has no data for the PCA plot.";
    }

    stage3ComparisonRows.replaceChildren();
    stage3MetricNote.hidden = !comparison;
    if (!comparison) {
      const cell = stage3ComparisonRows.insertRow().insertCell();
      cell.colSpan = 3;
      cell.textContent = "Expression comparison is unavailable in this archive.";
      return;
    }
    for (const [key, label, field] of stage3Comparison) {
      const row = stage3ComparisonRows.insertRow();
      row.dataset.s3Comparison = key;
      const value = comparison[field];
      row.insertCell().textContent = label;
      row.insertCell().textContent = value === null ? missing : formatSD.format(value);
      row.insertCell().textContent = key === "before" || value === null ? "—" : formatChange.format(value - comparison.before_sd);
    }
  }

  const archiveSteps = new Set([1, 2, 4, 5]);
  const archivedStepPanel = root.querySelector("#lens-history-stage");
  const archivedStepBack = byId("archive-stage-back");
  const archivedStepRetry = byId("archive-stage-retry");
  const archivedStepChart = archivedStepPanel.querySelector("[data-stage-chart]");
  const archivedStepPlot = archivedStepPanel.querySelector("[data-stage-plot]");
  const archivedStepDock = archivedStepPanel.querySelector("[data-stage-results]");
  const archivedStepTable = archivedStepPanel.querySelector("[data-stage-table]");
  const archivedStepMetrics = archivedStepPanel.querySelector("[data-stage-metrics]");
  const archivedStepSettings = archivedStepPanel.querySelector("[data-stage-settings]");
  const archivedStepStatus = archivedStepPanel.querySelector("[data-stage-status]");
  const savedSettingLabels = {
    "restrict.tcga.geno": "Chromosome",
    "restrict.tcga": "Chromosome",
    mind: "Max. sample missingness",
    geno: "Max. variant missingness",
    hwe: "HWE p-value cutoff",
    int: "Imputation block size (bp)",
    "alpha.cis": "Significance cutoff",
    nperms: "Permutations (low/rare)",
    upstream: "After gene end (base pairs)",
    downstream: "Before gene start (base pairs)",
    nboots: "Bootstrap runs",
    ncis: "ncis (recorded setting)",
    cor: "Instrument correlation limit",
    ncores: "Compute job cores",
    memory: "Compute job memory (GB)",
    walltime: "Compute job time limit",
    npc: "Principal components",
    freq: "Frequency threshold",
    ntop: "Maximum displayed subnetworks",
    cpus: "CPU cores",
    mem_gb: "Memory (GB)",
    hours: "Time limit (hours)",
  };
  function rerunParameterFields(parameters) {
    const integerFields = new Set(["restrict.tcga.geno", "restrict.tcga", "int", "nperms", "upstream", "downstream", "nboots", "ncis", "ncores", "memory", "npc", "ntop", "cpus", "mem_gb"]);
    return [["settings", "Settings"], ["options", "Analysis options"], ["resources", "Resources"]]
      .filter(([group]) => Object.keys(parameters[group] ?? {}).length)
      .map(([group, title]) => `<fieldset><legend>${escapeHistory(title)}</legend>${Object.entries(parameters[group]).map(([key, value]) => {
        const label = Object.hasOwn(savedSettingLabels, key) ? escapeHistory(savedSettingLabels[key]) : escapeHistory(key);
        const number = typeof value === "number";
        return `<label>${label}<input name="${escapeHistory(group + "-" + key)}" data-rerun-group="${group}" data-rerun-field="${escapeHistory(key)}" required
          type="${number ? "number" : "text"}" ${number ? `step="${integerFields.has(key) ? "1" : "any"}" min="0"` : 'spellcheck="false"'}
          ${key.startsWith("restrict.") ? "readonly" : ""} value="${escapeHistory(value)}"></label>`;
      }).join("")}</fieldset>`).join("");
  }
  const savedStepStates = {
    loading: "Loading the archived stage result…",
    empty: "This run has no readable result for this stage.",
    error: "Could not load the archived stage result.",
    timeout: resultReadTimeout,
  };
  const cisCategories = {
    common: "Common variants",
    low: "Low-frequency regions",
    rare: "Rare-variant regions",
  };
  let archivedStepResult = null;
  let archivedStepRequest;

  function viewArchivedStep(stage, summary) {
    const snapshot = snapshots.find(({number}) => number === stage);
    const count = (value) => countLabel.format(value);
    const view = {
      title: snapshot.chartTitle, axis: snapshot.axis,
      tableTitle: snapshot.tableTitle, headers: [...snapshot.headers],
      step: snapshot.step,
    };
    if (stage === 1) {
      const total = summary.genotype_codes.reduce((sum, value) => sum + value, 0);
      view.metrics = [["Samples", summary.samples], ["Variants", summary.variants]];
      view.bars = snapshot.bars.map(([range], index) => [range, summary.nonzero_bins[index]]);
      view.rows = summary.genotype_codes.map((entries, index) =>
        [index, count(entries), total ? `${(entries / total * 100).toFixed(2)}%` : "—"]);
      view.caption = "Each bin includes its lower bound. The last also includes 100%.";
    } else if (stage === 2) {
      view.metrics = [["Samples", summary.samples], ["Genes", summary.genes]];
      view.bars = summary.histogram.map(({lower, upper, count: entries}) => [`${lower}–${upper}`, entries]);
      view.rows = summary.gene_summary.map(({gene, min, median, max}) =>
        [gene, min.toFixed(2), median.toFixed(2), max.toFixed(2)]);
      view.caption = "Each bin includes its lower bound. The last also includes its upper bound.";
    } else if (stage === 4) {
      const total = summary.counts.common + summary.counts.low + summary.counts.rare;
      view.metrics = [["Significant pairs", total], ["Genes represented", summary.genes]];
      view.bars = Object.entries(cisCategories).map(([key, names]) => [names, summary.counts[key]]);
      view.headers[1] = "Variant / region index in category";
      view.rows = summary.pairs.map(({gene, variant, category, p_value}) =>
        [gene, variant, cisCategories[category], p_value]);
      view.caption = "Low-frequency and rare variants are grouped by region.";
    } else {
      const total = summary.frequencies.reduce((sum, {count: edges}) => sum + edges, 0);
      view.title = "Bootstrap frequency of candidate edges";
      view.metrics = [["Candidate edges", total], ["Genes analyzed", summary.genes]];
      view.frequencyAxis = "Bootstrap frequency";
      view.bars = summary.frequencies.map(({frequency, count: edges}) => [frequency, edges]);
      view.rows = summary.edges.map(({source, target, frequency}) => [source, target, percentLabel(frequency)]);
      view.caption = "Candidate edges appeared in at least one bootstrap run. Stage 6 filters them by frequency.";
      if (!summary.edges.length) view.emptyText = "This run produced no candidate edges.";
    }

    // Fit small and large archived results within the existing chart frame.
    const maximum = view.bars.reduce((largest, [, value]) => Math.max(largest, value), 0);
    if (maximum && (maximum < view.step || maximum > 10 * view.step)) {
      view.step = Math.ceil(maximum / 5);
    }
    return view;
  }

  function renderArchivedStep() {
    const recorded = (value) => value ?? "Not recorded";
    const stage = historyResult?.stage;
    const run = archiveSteps.has(stage)
      ? selectedHistoryResult() : null;
    const view = run && archivedStepResult ? viewArchivedStep(stage, archivedStepResult.summary) : null;
    if (view && stage === 4 && run.source === "live") {
      view.tableTitle = "Significant gene–variant associations";
    }
    if (view && stage === 5 && run.source === "live") {
      view.tableTitle = "Candidate edges and frequencies";
    }
    const state = archivedStepPanel.dataset.runState;
    const name = run ? stageData[stage - 1].name : "";
    const job = run ? archivedStepResult?.job ?? run.jobs[historySteps[stage - 1]] : null;
    const definition = (label, value, identity = "") =>
      `<dt>${escapeHistory(label)}</dt><dd${identity}>${escapeHistory(recorded(value))}</dd>`;

    archivedStepPanel.querySelector("h2").textContent = name;
    const liveIncomplete = state === "empty" && run?.source === "live" && job?.state !== "completed";
    archivedStepStatus.textContent = liveIncomplete
      ? genotypeHistoryState(job?.state) : savedStepStates[state] ?? "";
    archivedStepStatus.hidden = !savedStepStates[state];
    archivedStepRetry.hidden = !["error", "timeout"].includes(state);
    archivedStepChart.hidden = !view || !view.bars.length;
    archivedStepDock.hidden = !view;
    archivedStepMetrics.innerHTML = run ? [
      ["Stage", `Stage ${stage}`],
      [run.source === "live" ? "Run" : "Archived run", run.name],
      ...(run.source === "live" ? [["Status", genotypeHistoryState(job?.state)]] : []),
      ...(view?.metrics.map(([label, value]) => [label, countLabel.format(value)]) ?? []),
    ].map(([label, value]) => definition(label, value)).join("") : "";

    const resources = [
      ["cpus", stage === 5 ? "Controller job cores" : "Scheduled job cores"],
      ["mem_gb", stage === 5 ? "Controller job memory (GB)" : "Scheduled job memory (GB)"],
      ["time", stage === 5 ? "Controller job time limit" : "Scheduled job time limit"],
    ];
    const settings = Object.entries({...job?.settings, ...job?.options});
    archivedStepSettings.innerHTML = job ? [
      definition("Job ID", job.job_id),
      ...settings.map(([key, value]) => definition(savedSettingLabels[key] ?? key,
        typeof value === "object" && value !== null ? JSON.stringify(value) : value,
        ` data-stage-setting="${escapeHistory(key)}" title="${escapeHistory(key)}"`)),
      ...resources.filter(([field]) => job.resources?.[field] != null).map(([field, label]) =>
        definition(label, job.resources[field], ` data-stage-resource="${field}"`)),
    ].join("") : "";

    if (!view) {
      archivedStepPlot.replaceChildren();
      archivedStepTable.tBodies[0].replaceChildren();
      return;
    }
    archivedStepChart.querySelector("h3").textContent = view.title;
    archivedStepChart.querySelector("figcaption").textContent = view.caption;
    archivedStepPlot.innerHTML = view.bars.length
      ? countChart(view.bars, view.step, view.axis, view.title, view.frequencyAxis) : "";
    archivedStepPanel.querySelector("[data-stage-table-title]").textContent = view.tableTitle;
    archivedStepTable.setAttribute("aria-label", view.tableTitle);
    archivedStepTable.tHead.rows[0].innerHTML = view.headers.map((title) =>
      `<th scope="col">${escapeHistory(title)}</th>`).join("");
    const rows = view.rows.map((row) => `<tr>${row.map((value) =>
      `<td>${escapeHistory(value)}</td>`).join("")}</tr>`).join("");
    archivedStepTable.tBodies[0].innerHTML = rows || `<tr><td colspan="${view.headers.length}">${escapeHistory(view.emptyText ?? recorded(null))}</td></tr>`;
  }

  async function loadArchivedStep() {
    archivedStepRequest?.abort();
    const {runId, historyId, stage} = historyResult ?? {};
    const run = findHistoryRun(historyId);
    if (!archiveSteps.has(stage) || !run) return;
    const request = new AbortController();
    archivedStepRequest = request;
    archivedStepResult = null;
    delete archivedStepPanel.dataset.runId;
    delete archivedStepPanel.dataset.historyId;
    archivedStepPanel.dataset.stage = stage;
    if (!canReadStage(run, stage)) {
      archivedStepPanel.dataset.runState = "empty";
      renderArchivedStep();
      return;
    }
    archivedStepPanel.dataset.runState = "loading";
    renderArchivedStep();
    try {
      const result = await getSavedStageResult(run, stage, request.signal);
      if (request.signal.aborted) return;
      archivedStepResult = result;
      rememberTimelineResult(run, stage, result);
      archivedStepPanel.dataset.runId = runId;
      archivedStepPanel.dataset.historyId = historyId;
      archivedStepPanel.dataset.runState = "ready";
    } catch (error) {
      if (request.signal.aborted) return;
      archivedStepPanel.dataset.runState = archivedResultErrorState(error);
      rememberTimelineResult(run, stage, null, archivedStepPanel.dataset.runState);
    }
    renderArchivedStep();
  }
  archivedStepRetry.addEventListener("click", () => void loadArchivedStep());

  function clearHistoryResult() {
    historyResult = null;
    stage3Request?.abort();
    archivedStepRequest?.abort();
  }

  async function loadStage3Run() {
    stage3Request?.abort();
    const run = selectedHistoryResult();
    const runId = run?.run_id, historyId = run && historyKey(run);
    if (historyResult?.stage !== 3 || !run) return;
    const request = new AbortController();
    stage3Request = request;
    stage3Result = null;
    delete stage3HistoryPanel.dataset.runId;
    delete stage3HistoryPanel.dataset.historyId;
    if (!canReadStage(run, 3)) {
      stage3HistoryPanel.dataset.runState = "empty";
      renderStage3History();
      return;
    }
    stage3HistoryPanel.dataset.runState = "loading";
    renderStage3History();
    try {
      const result = await getSavedStageResult(run, 3, request.signal);
      if (request.signal.aborted) return;
      stage3Result = result;
      rememberTimelineResult(run, 3, result);
      stage3HistoryPanel.dataset.runId = runId;
      stage3HistoryPanel.dataset.historyId = historyId;
      stage3HistoryPanel.dataset.runState = "ready";
    } catch (error) {
      if (request.signal.aborted) return;
      stage3HistoryPanel.dataset.runState = archivedResultErrorState(error);
      rememberTimelineResult(run, 3, null, stage3HistoryPanel.dataset.runState);
    }
    renderStage3History();
  }
  stage3Retry.addEventListener("click", () => void loadStage3Run());

  const newChatTitle = "New chat";
  const idleChatStatus = "SIGNET Agent · Local service ready";
  const chatOutcomes = {completed: "Ended", failed: "Failed", needs_review: "Needs review", cancelled: "Stopped"};
  const chatRecords = [];
  const sendButton = byId("send");
  const stopButton = byId("stop");
  const deleteChatDialog = byId("delete-chat-dialog");
  const deleteChatConfirm = byId("delete-chat-confirm");
  const deleteChatCancel = byId("delete-chat-cancel");
  const deleteChatError = byId("delete-chat-error");
  let activeChat, chatBusy = false, stopActiveChat;
  let nextChatRecordId = 0;
  let chatToDelete;

  function createMessage(className, text) {
    const message = document.createElement("p");
    message.className = className;
    message.textContent = text;
    return message;
  }

  function appendChatEvent(record, title, result, state) {
    const event = document.createElement("details");
    event.className = "ml-chat-event";
    event.open = !record.events.childElementCount;
    event.innerHTML = `<summary><i data-lucide="terminal" aria-hidden="true"></i><strong></strong>
      <span class="ml-chat-event-state"></span><i class="ml-chat-event-arrow" data-lucide="chevron-down" aria-hidden="true"></i></summary><p></p>`;
    event.querySelector("strong").textContent = title;
    const status = event.querySelector(".ml-chat-event-state");
    const log = event.querySelector("p");
    status.textContent = state;
    log.textContent = result;
    record.emptyEvents.hidden = true;
    record.events.append(event);
    return {event, status, log};
  }

  function toolActivity(record, line, operations) {
    if (typeof line !== "string" || !line.startsWith("SIGNET_TOOL ")) return false;
    let data;
    try { data = JSON.parse(line.slice(12)); } catch { return false; }
    if (!/^[a-f0-9]{32}$/.test(data.operation_id) || !/^[\w]{1,100}$/.test(data.tool_name)) return false;
    const states = {running: "Running", completed: "Completed", failed: "Failed", cancelled: "Cancelled", needs_review: "Needs review"};
    if (!states[data.status]) return false;
    let row = operations.get(data.operation_id);
    if (!row) { row = appendChatEvent(record, data.tool_name, "", states[data.status]); operations.set(data.operation_id, row); }
    row.status.textContent = states[data.status];
    const elapsed = Number.isFinite(data.elapsed_ms) && data.elapsed_ms >= 0 ? `${(data.elapsed_ms / 1000).toFixed(2)} s` : "…";
    row.log.textContent = `Validate parameters and invoke tool (values hidden).\nElapsed: ${elapsed}\nResult: ${String(data.result_summary || "—").slice(0, 300)}`;
    return true;
  }

  const chatDrawers = ["chat-list", "chat-activity"];
  function scrollChatToEnd() {
    if (byId("chat-transcripts").hidden) return;
    const thread = byId("thread");
    thread.scrollTop = thread.scrollHeight;
  }

  function showChatDrawer(key) {
    for (const drawer of chatDrawers) {
      byId(drawer).hidden = drawer !== key;
      byId(drawer + "-toggle").setAttribute("aria-expanded", String(drawer === key));
    }
    byId("chat-transcripts").hidden = Boolean(key);
    byId("thread").scrollTop = 0;
  }

  function openChat(record) {
    if (activeChat) activeChat.draft = input.value;
    activeChat = record;
    for (const chat of chatRecords) {
      const active = chat === record;
      chat.button.setAttribute("aria-pressed", String(active));
      chat.transcript.hidden = chat.activity.hidden = !active;
    }
    byId("chat-title").textContent = record.title;
    byId("chat-status").textContent = chatOutcomes[record.outcome] ?? idleChatStatus;
    input.value = record.draft;
    showChatDrawer(null);
    scrollChatToEnd();
  }

  function createChat(saved) {
    const title = saved?.title ?? newChatTitle;
    const row = document.createElement("div");
    row.className = "ml-chat-record";
    row.hidden = !saved;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ml-nav-list-item";
    button.innerHTML = '<i data-lucide="message-square" aria-hidden="true"></i><span><strong></strong><small></small></span>';
    button.querySelector("strong").textContent = title;
    button.querySelector("small").textContent = "Saved conversation";
    const transcript = document.createElement("div");
    transcript.id = `ml-chat-record-${++nextChatRecordId}`;
    button.setAttribute("aria-controls", transcript.id);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "ml-icon-button ml-chat-delete";
    deleteButton.setAttribute("data-delete-chat", "");
    deleteButton.setAttribute("aria-label", `Delete chat “${title}”`);
    deleteButton.title = "Delete chat";
    deleteButton.innerHTML = '<i data-lucide="trash-2" aria-hidden="true"></i>';
    const activity = document.createElement("div");
    const emptyEvents = createMessage("ml-saved-reply", "No activity yet.");
    const eventList = document.createElement("div");
    eventList.className = "ml-chat-event-list";
    activity.append(emptyEvents, eventList);
    const record = {session: saved?.session ?? crypto.randomUUID(), loaded: !saved, title, row, button, deleteButton, transcript,
      activity, events: eventList, emptyEvents, draft: ""};
    chatRecords.push(record);
    button.addEventListener("click", () => void selectSavedChat(record));
    deleteButton.addEventListener("click", () => askToDeleteChat(record));
    row.append(button, deleteButton);
    byId("chat-records").append(row);
    byId("chat-transcripts").append(transcript);
    byId("chat-events").append(activity);
    return record;
  }

  function setChatBusy(busy) {
    const sendHadFocus = document.activeElement === sendButton;
    chatBusy = busy;
    const canStop = busy && Boolean(stopActiveChat);
    sendButton.hidden = canStop;
    stopButton.hidden = !canStop;
    sendButton.disabled = byId("new").disabled = busy;
    if (canStop && sendHadFocus) stopButton.focus({preventScroll: true});
    for (const {button, deleteButton} of chatRecords) button.disabled = deleteButton.disabled = busy;
  }
  stopButton.addEventListener("click", () => stopActiveChat?.());

  function askToDeleteChat(record) {
    if (chatBusy || record.row.hidden || deleteChatDialog.open) return;
    chatToDelete = record;
    byId("delete-chat-name").textContent = record.title;
    deleteChatError.hidden = true;
    deleteChatDialog.showModal();
  }

  deleteChatCancel.addEventListener("click", () => {
    chatToDelete = null;
    deleteChatDialog.close();
  });
  deleteChatDialog.addEventListener("cancel", event => {
    if (chatBusy) event.preventDefault();
    else chatToDelete = null;
  });
  byId("delete-chat-form").addEventListener("submit", async event => {
    event.preventDefault();
    const record = chatToDelete;
    if (!deleteChatDialog.open || !record || chatBusy) return;
    setChatBusy(true);
    deleteChatError.hidden = true;
    deleteChatConfirm.disabled = deleteChatCancel.disabled = true;
    deleteChatConfirm.textContent = "Deleting…";
    let focus;
    try {
      const response = await fetch(`/chat/${encodeURIComponent(record.session)}`, {
        method: "DELETE", headers: {"X-Chat-Token": chatToken},
      });
      if (!response.ok) throw Error(await readChatError(response));
      const reply = await response.json().catch(() => null);
      if (reply?.deleted !== record.session) throw Error("Could not confirm deletion. Try again.");

      record.row.remove();
      record.transcript.remove();
      record.activity.remove();
      chatRecords.splice(chatRecords.indexOf(record), 1);
      if (record === activeChat) {
        openChat(createChat());
        showChatDrawer("chat-list");
        globalThis.lucide?.createIcons();
      }
      byId("empty-chats").hidden = chatRecords.some(chat => !chat.row.hidden);
      byId("chat-status").textContent = "Chat deleted.";
      chatToDelete = null;
      deleteChatDialog.close();
      focus = byId("chat-list-toggle");
    } catch (error) {
      deleteChatError.textContent = error.message || "Could not delete this chat. Try again.";
      deleteChatError.hidden = false;
      focus = deleteChatConfirm;
    } finally {
      deleteChatConfirm.textContent = "Delete chat";
      deleteChatConfirm.disabled = deleteChatCancel.disabled = false;
      setChatBusy(false);
      focus?.focus();
    }
  });

  function appendChatMessage(record, sender, body) {
    const message = document.createElement("div");
    message.className = "ml-chat-message";
    message.dataset.chatSender = sender;
    const isUser = sender === "user";
    const author = createMessage("ml-chat-author", isUser ? "You" : "Agent");
    if (!isUser) {
      const icon = document.createElement("i");
      icon.dataset.lucide = "bot";
      icon.setAttribute("aria-hidden", "true");
      author.prepend(icon);
    }
    message.append(author, body);
    record.transcript.append(message);
  }

  function createAgentReply(record) {
    const reply = document.createElement("div");
    reply.className = "ml-saved-reply ml-live-reply";
    appendChatMessage(record, "assistant", reply);
    return reply;
  }

  const legacyModelFallback = /^\*\*Model fallback:\*\* `[a-z0-9.-]+` is unavailable \([^\r\n()]+\); this turn uses `([a-z0-9.-]{1,80})`\. Completed tools will not be rerun\.(?:\r?\n\r?\n|$)/;

  function showModelFallback(reply, model) {
    if (typeof model !== "string" || !/^[a-z0-9][a-z0-9.-]{0,79}$/.test(model)) return;
    const message = reply.parentElement;
    if (message.previousElementSibling?.dataset.chatNotice === "model-fallback") return;
    const notice = document.createElement("p");
    notice.className = "ml-chat-notice";
    notice.dataset.chatNotice = "model-fallback";
    notice.textContent = `Switched to ${model}`;
    message.before(notice);
  }

  function renderAgentAnswer(reply, text, modelFallback) {
    const legacy = legacyModelFallback.exec(text);
    showModelFallback(reply, modelFallback ?? legacy?.[1]);
    reply.innerHTML = renderMarkdown(legacy ? text.slice(legacy[0].length) : text);
  }

  async function readChatError(response) {
    const {error} = await response.json().catch(() => ({}));
    return error ?? "The local service rejected the request.";
  }

  function loadChat(record, saved) {
    for (const {role, text, model_fallback} of saved.messages ?? []) {
      if (role === "user") appendChatMessage(record, "user", createMessage("ml-message", text));
      else if (role === "notice") record.transcript.append(createMessage("ml-chat-notice", text));
      else renderAgentAnswer(createAgentReply(record), text, model_fallback);
    }
    for (const events of saved.events ?? []) {
      const operations = new Map();
      let outcome = "completed";
      const logs = events.filter(line => {
        if (typeof line === "string" && line.startsWith("SIGNET_TURN ")) {
          try { const saved = JSON.parse(line.slice(12)); if (chatOutcomes[saved.status]) outcome = saved.status; } catch {}
          return false;
        }
        // Older saved turns may predate the structured outcome record.
        if (/回合失敗|Turn failed/.test(line)) outcome = "failed";
        else if (outcome !== "failed" && /回合需要確認|Turn needs review/.test(line)) outcome = "needs_review";
        return !toolActivity(record, line, operations);
      });
      record.outcome = outcome;
      appendChatEvent(record, "Saved activity", logs.join("\n"), chatOutcomes[outcome]);
    }
    record.loaded = true;
  }

  async function selectSavedChat(record) {
    if (chatBusy) return;
    setChatBusy(true);
    try {
      const response = await fetch("/bootstrap?" + new URLSearchParams({session: record.session}));
      if (!response.ok) throw new Error(await readChatError(response));
      const {initial} = await response.json();
      if (!record.loaded) loadChat(record, initial);
      openChat(record);
      globalThis.lucide?.createIcons();
      byId("chat-list-toggle").focus({preventScroll: true});
    } catch (error) {
      byId("chat-status").textContent = error.message;
    } finally {
      setChatBusy(false);
    }
  }

  for (const saved of initialChat.sessions ?? []) createChat(saved);
  byId("empty-chats").hidden = chatRecords.length > 0;
  const firstChat = chatRecords.find(({session}) => session === initialChat.session) ?? createChat();
  loadChat(firstChat, initialChat);
  openChat(firstChat);

  for (const drawer of chatDrawers) {
    byId(drawer + "-toggle").addEventListener("click", () => showChatDrawer(byId(drawer).hidden ? drawer : null));
  }

  byId("open-model-settings").addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("workspace-open-model-settings"));
  });
  const modelChip = byId("model-chip");
  modelChip.textContent = modelChip.title = chatModel;

  const datasetSelect = byId("dataset-select");
  const datasetEditor = byId("dataset-editor");
  const datasetFiles = byId("dataset-files");
  const datasetForm = byId("dataset-form");
  const datasetSaving = datasetForm.querySelector(".ml-dataset-saving span");
  const duplicateDatasetName = "A dataset with this name already exists.";
  const datasetAdd = byId("dataset-add");
  const datasetDelete = byId("dataset-delete");
  const deleteDatasetDialog = byId("delete-dataset-dialog");
  const deleteDatasetCancel = byId("delete-dataset-cancel");
  const deleteDatasetConfirm = byId("delete-dataset-confirm");
  const deleteDatasetError = byId("delete-dataset-error");
  const datasetName = byId("dataset-name");
  const datasetError = byId("dataset-error");
  const datasetCatalogNotice = byId("dataset-catalog-error");
  let creatingDataset = false;
  let datasetToDelete, deletingDataset = false;
  let datasetFormError = "";

  function renderDatasetLabels() {
    datasetSelect.replaceChildren(...datasets.map((dataset) => {
      const option = document.createElement("option");
      option.value = dataset.id;
      option.textContent = dataset.name;
      return option;
    }));
    datasetSelect.value = activeDataset.id;
    if (!datasets.length) datasetSelect.add(new Option(emptyDataset.name, ""));
    datasetSelect.disabled = !datasetCatalogReady || !datasets.length;
    datasetAdd.disabled = creatingDataset;
    datasetDelete.disabled = !datasetCatalogReady || !activeDataset.persisted;
    const label = activeDataset.name || "Datasets";
    byId("history-dataset-name").textContent = historyScope === "current" ? label
      : historyScope === "unclassified" ? "Unclassified runs" : "All runs";
    byId("stage-dataset-title").textContent = label;
    datasetError.textContent = datasetFormError || "Enter a dataset name.";
    datasetCatalogNotice.textContent = datasetCatalogError;
    datasetCatalogNotice.hidden = !datasetCatalogError;
  }

  function setSidebarOpen(open) {
    const sidebar = byId("chat-panel");
    sidebar.inert = !open;
    sidebar.hidden = !open;
    app.toggleAttribute("data-chat-closed", !open);
  }

  function syncContextChat() {
    const docked = ["data", "history"].includes(app.dataset.nav);
    contextChat.hidden = !docked || !contextChatOpen;
    showContextChat.hidden = !docked || contextChatOpen;
    showContextChat.setAttribute("aria-expanded", String(docked && contextChatOpen));
    hideContextChat.hidden = !docked;

    if (docked) {
      agentView.hidden = false;
      if (agentView.parentElement !== contextChat) {
        contextChat.append(agentView);
        agentView.removeAttribute("role");
        agentView.removeAttribute("aria-labelledby");
        if (contextChatOpen) scrollChatToEnd();
      }
    } else if (agentView.parentElement === contextChat) {
      byId("stage-view").before(agentView);
      agentView.setAttribute("role", "tabpanel");
      agentView.setAttribute("aria-labelledby", tabs[0].id);
    }
  }

  showContextChat.addEventListener("click", () => {
    contextChatOpen = true;
    syncContextChat();
    scrollChatToEnd();
    hideContextChat.focus({preventScroll: true});
  });

  function animateContextChatCollapse() {
    if (typeof contextChat.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const {offsetWidth: width, offsetHeight: height} = contextChat;
    // Measure the launcher before the next paint so it appears only after the dock shrinks.
    showContextChat.hidden = false;
    const {offsetWidth: buttonWidth, offsetHeight: buttonHeight} = showContextChat;
    showContextChat.hidden = true;
    if (!width || !height || !buttonWidth || !buttonHeight) return;
    return contextChat.animate([
      {scale: "1", opacity: 1},
      {scale: `${buttonWidth / width} ${buttonHeight / height}`, opacity: .35},
    ], {duration: 240, easing: "cubic-bezier(.4, 0, .2, 1)", fill: "forwards"});
  }

  hideContextChat.addEventListener("click", async () => {
    if (contextChat.hidden || contextChat.inert) return;
    const previousFocus = document.activeElement;
    const animation = animateContextChatCollapse();
    if (animation) {
      contextChat.inert = true;
      await animation.finished.catch(() => {});
    }
    contextChatOpen = false;
    syncContextChat();
    animation?.cancel();
    contextChat.inert = false;
    if (!showContextChat.hidden && (document.activeElement === previousFocus || document.activeElement === document.body)) {
      showContextChat.focus({preventScroll: true});
    }
  });

  const selectedRuns = new Map();
  const historySelectionKey = () => historyScope === "current" ? `dataset:${activeDataset.id}` : historyScope;
  function renderHistoryStatus(runCount = matchingHistoryRuns().length) {
    const [title, note] = historyState === "loading"
      ? ["Loading run history…", ""]
      : historyState === "error"
        ? ["Could not load run history", ""]
        : historyScope === "current" ? ["No runs yet", "Runs for the selected dataset will appear here."]
          : historyScope === "unclassified" ? ["No unclassified runs", "Runs without recorded dataset ownership will appear here."]
            : ["No runs yet", "All saved runs will appear here."];
    byId("empty-run-list").textContent = byId("empty-history-title").textContent = title;
    byId("empty-history-note").textContent = note;
    byId("history-retry").hidden = historyState !== "error";
    byId("history-scope-note").textContent = historyState !== "ready" && runCount === 0 ? ""
      : `${runCount} ${runCount === 1 ? "run" : "runs"}`;
  }

  function updateHistoryView() {
    const inHistory = app.dataset.nav === "history";
    const savedAnalysis = savedAnalysisView();
    const activeStage = activeStageButton()?.dataset.stage;
    byId("start").hidden = Boolean(activeStage) || !["analysis", "settings"].includes(app.dataset.nav);
    const matchingRuns = matchingHistoryRuns();
    const previousSelection = selectedRuns.get(historySelectionKey());
    const selected = matchingRuns.find(run => historyKey(run) === previousSelection);
    const selectedId = selected ? historyKey(selected) : matchingRuns[0] && historyKey(matchingRuns[0]);
    const showResult = savedAnalysis || inHistory && Boolean(selectedId) && historyResult?.historyId === selectedId;
    const showNetwork = showResult && historyResult.stage === 6;
    const selectedRun = savedAnalysis ? selectedHistoryResult() : matchingRuns.find(run => historyKey(run) === selectedId);
    const showGenotype = showResult && historyResult.stage === 1 && canContinue(selectedRun) &&
      selectedRun.jobs.genotype?.state !== "completed";
    const showExpression = showResult && historyResult.stage === 2 && canContinue(selectedRun) &&
      selectedRun.jobs.expression?.state !== "completed";
    const showAdjustment = showResult && historyResult.stage === 3 && canContinue(selectedRun) &&
      selectedRun.jobs.adjust?.state !== "completed";
    const showCis = showResult && historyResult.stage === 4 && canContinue(selectedRun) &&
      selectedRun.jobs.cis?.state !== "completed";
    const showNetworkRun = showResult && historyResult.stage === 5 && canContinue(selectedRun) &&
      selectedRun.jobs.network?.state !== "completed";
    stage3HistoryPanel.hidden = !showResult || historyResult.stage !== 3 || showAdjustment;
    archivedStepPanel.hidden = !showResult || showGenotype || showExpression || showCis || showNetworkRun || !archiveSteps.has(historyResult.stage);
    stage3Back.hidden = archivedStepBack.hidden = savedAnalysis;
    const genotypePanel = root.querySelector("#lens-stage1");
    genotypePanel.classList.toggle("ml-workspace", !showGenotype);
    genotypePanel.classList.toggle("ml-nav-workspace", showGenotype);
    genotypePanel.hidden = inHistory || savedAnalysis ? !showGenotype : activeStage !== "1";
    const expressionPanel = root.querySelector("#lens-stage2");
    expressionPanel.classList.toggle("ml-workspace", !showExpression);
    expressionPanel.classList.toggle("ml-nav-workspace", showExpression);
    expressionPanel.hidden = inHistory || savedAnalysis ? !showExpression : activeStage !== "2";
    const adjustmentPanel = root.querySelector("#lens-stage3");
    adjustmentPanel.classList.toggle("ml-workspace", !showAdjustment);
    adjustmentPanel.classList.toggle("ml-nav-workspace", showAdjustment);
    adjustmentPanel.hidden = inHistory || savedAnalysis ? !showAdjustment : activeStage !== "3";
    const cisPanel = root.querySelector("#lens-stage4");
    cisPanel.classList.toggle("ml-workspace", !showCis);
    cisPanel.classList.toggle("ml-nav-workspace", showCis);
    cisPanel.hidden = inHistory || savedAnalysis ? !showCis : activeStage !== "4";
    const networkPanel = root.querySelector("#lens-stage5");
    networkPanel.classList.toggle("ml-workspace", !showNetworkRun);
    networkPanel.classList.toggle("ml-nav-workspace", showNetworkRun);
    networkPanel.hidden = inHistory || savedAnalysis ? !showNetworkRun : activeStage !== "5";
    runDetails.hidden = !inHistory || !selectedId || showResult;
    byId("empty-history").hidden = !inHistory || Boolean(selectedId);
    byId("empty-run-list").hidden = Boolean(selectedId);
    for (const button of runList.querySelectorAll("[data-run-target]")) {
      const id = button.dataset.runTarget;
      button.hidden = !matchingRuns.some(run => historyKey(run) === id);
      button.setAttribute("aria-pressed", String(id === selectedId));
      root.querySelector("#" + button.getAttribute("aria-controls")).hidden = id !== selectedId;
    }

    // One graph and table render the same run in both the analysis and history views.
    analysisNetwork.classList.toggle("ml-workspace", !showNetwork);
    analysisNetwork.classList.toggle("ml-nav-workspace", showNetwork);
    analysisNetwork.hidden = inHistory || savedAnalysis ? !showNetwork : activeStage !== "6";
    renderHistoryStatus(matchingRuns.length);
    syncGenotypeContext();
    syncHistoryLogs();
    renderRunTimeline();
  }

  function updateAnalysisView() {
    const isExample = activeDataset.id === exampleDataset.id;
    const hasSavedResults = activeDataset.persisted || isExample || runsForDataset().length > 0;
    app.toggleAttribute("data-no-analysis", !hasSavedResults && historyState === "ready");
    byId("empty-analysis").hidden = !activeStageButton() || hasSavedResults || historyState !== "ready" ||
      !["analysis", "settings"].includes(app.dataset.nav);
    timeline.hidden = !hasSavedResults;
    byId("stage-header").querySelector("span").hidden = !hasSavedResults;
    byId("empty-stage").hidden = hasSavedResults || historyState !== "ready";
    for (const button of stageButtons) {
      button.closest(".ml-stage-entry").hidden = !hasSavedResults;
    }
    syncGenotypeContext();
  }

  async function loadWorkspaceHistory() {
    const request = ++historyRequest;
    const catalogRevision = datasetRevision;
    historyState = "loading";
    updateHistoryView();
    if (!stage6RunSelect.value) void loadStage6Run("");
    try {
      const [{runs}, {datasets: savedDatasets}] = await Promise.all([
        getArchivedResult("/stage6/history"), requestDataset("/signet/datasets"),
      ]);
      if (request !== historyRequest) return;
      if (!Array.isArray(savedDatasets)) throw new Error("The dataset catalog is unavailable.");
      datasetCatalogReady = true;
      datasetCatalogError = "";
      // A catalog read started before a successful save must not replace the newer canonical response.
      if (catalogRevision === datasetRevision) {
        const catalog = savedDatasets.map(makeDataset);
        datasets.splice(0, datasets.length, ...catalog);
        activeDataset = datasets.find(({id}) => id === activeDataset.id) ?? datasets[0] ?? emptyDataset;
      }
      historyRuns = runs.map(run => ({...run, name: savedDisplayName(run.name) ?? run.run_id,
        dataset_name: savedDisplayName(run.dataset_name)})).sort((a, b) => historyTime(b) - historyTime(a));
      historyState = "ready";
      renderHistoryRecords();
      if (!analysisRunByDataset.has(activeDataset.id)) {
        const completed = stage6RunsForDataset().find(run => run.source === "live");
        if (completed) analysisRunByDataset.set(activeDataset.id, historyKey(completed));
      }
      const selectedRun = selectedHistoryResult();
      if (selectedRun && canContinue(selectedRun)) {
        const stage = historyResult.stage;
        if ([1, 2, 4, 5].includes(stage) && selectedRun.jobs[historySteps[stage - 1]]?.state === "completed" &&
          (archivedStepPanel.dataset.historyId !== historyKey(selectedRun) || archivedStepPanel.dataset.stage !== String(stage))) void loadArchivedStep();
        if (stage === 3 && selectedRun.jobs.adjust?.state === "completed" && stage3HistoryPanel.dataset.historyId !== historyKey(selectedRun)) void loadStage3Run();
      }
    } catch (error) {
      if (request !== historyRequest) return;
      historyState = "error";
      datasetCatalogReady = false;
      datasetCatalogError = error.message;
    }
    renderDatasetLabels();
    syncInputFiles();
    syncDatasetReferences();
    updateAnalysisView();
    updateHistoryView();
    requestedStage6Run = null;
    syncStage6Picker(true);
  }
  byId("history-retry").addEventListener("click", () => void loadWorkspaceHistory());

  async function openWorkspaceHistory(runId, stage) {
    historyScope = "current";byId("history-scope").value = historyScope;
    openNavigation("history");
    await loadWorkspaceHistory();
    const run = runsForDataset().find(run => run.run_id === runId && canContinue(run));
    if (app.dataset.nav !== "history" || !run) return;
    selectedRuns.set(historySelectionKey(), historyKey(run));
    clearHistoryResult();updateHistoryView();
    focusHistoryStage(historyKey(run), stage);
  }
  const openGenotypeHistory = runId => openWorkspaceHistory(runId, 1);
  const openExpressionHistory = runId => openWorkspaceHistory(runId, 2);
  const openAdjustmentHistory = runId => openWorkspaceHistory(runId, 3);
  const openCisHistory = runId => openWorkspaceHistory(runId, 4);
  const openNetworkHistory = runId => openWorkspaceHistory(runId, 5);
  const openVisualizationHistory = runId => openWorkspaceHistory(runId, 6);

  function showSavedStage6() {
    const available = stage6RunsForDataset();
    const run = available.find(run => historyKey(run) === analysisRunByDataset.get(activeDataset.id)) ?? available[0];
    if (!run) return;
    analysisRunByDataset.set(activeDataset.id, historyKey(run));
    openNavigation("analysis");
    selectTab(tabs[1]);
    showStage(timeline.querySelector('[data-stage="6"]'), true);
    syncStage6Picker();
  }

  async function refreshVisualizationHistory(runId) {
    await loadWorkspaceHistory();
    const run = stage6RunsForDataset().find(run => run.run_id === runId && canContinue(run));
    if (!run) return;
    const showingRun = app.dataset.nav === "history" && historyResult?.stage === 6 && historyResult.historyId === historyKey(run);
    const showingForm = app.dataset.nav === "analysis" && visualizationFormVisible();
    if (showingRun || showingForm) {
      analysisRunByDataset.set(activeDataset.id, historyKey(run));
      syncStage6Picker(true);
      updateHistoryView();
    }
  }

  function setDatasetFormOpen(open) {
    datasetEditor.hidden = !open;
    datasetFiles.hidden = open;
    datasetAdd.setAttribute("aria-expanded", String(open));
  }

  function closeDatasetForm() {
    if (creatingDataset || datasetEditor.hidden) return;
    setDatasetFormOpen(false);
    datasetForm.reset();
    datasetName.removeAttribute("aria-invalid");
    datasetError.hidden = true;
    datasetFormError = "";
    datasetForm.dataset.saveState = "idle";
  }

  function focusDatasetPane(control) {
    if (app.dataset.nav !== "data") return;
    if (app.hasAttribute("data-chat-closed")) {
      datasetFiles.querySelector("article:not([hidden]) h2").focus();
    } else {
      control.focus();
    }
  }

  function selectDataset(dataset) {
    if (!dataset) return;
    closeDatasetForm();
    if (dataset.id !== activeDataset.id) {
      window.dispatchEvent(new Event("close-dataset-remote-files"));
      activeDataset = dataset;
      clearHistoryResult();
      if (activeStageButton() && !runsForDataset().length) showStage(stageButtons[0], true);
    }
    renderDatasetLabels();
    syncInputFiles();
    syncDatasetReferences();
    updateAnalysisView();
    updateHistoryView();
    syncStage6Picker(true);
  }

  datasetSelect.addEventListener("change", () => {
    selectDataset(datasets.find((dataset) => dataset.id === datasetSelect.value));
  });

  datasetDelete.addEventListener("click", () => {
    if (datasetDelete.disabled || deleteDatasetDialog.open || creatingDataset) return;
    datasetToDelete = activeDataset;
    byId("delete-dataset-name").textContent = datasetToDelete.name;
    deleteDatasetError.hidden = true;
    deleteDatasetDialog.showModal();
  });
  deleteDatasetCancel.addEventListener("click", () => deleteDatasetDialog.close());
  deleteDatasetDialog.addEventListener("close", () => { datasetToDelete = undefined; });
  deleteDatasetDialog.addEventListener("cancel", event => {
    if (deletingDataset) event.preventDefault();
  });
  byId("delete-dataset-form").addEventListener("submit", async event => {
    event.preventDefault();
    const dataset = datasetToDelete;
    if (!deleteDatasetDialog.open || !dataset || deletingDataset) return;
    deletingDataset = true;
    deleteDatasetConfirm.disabled = deleteDatasetCancel.disabled = true;
    deleteDatasetConfirm.textContent = "Deleting…";
    deleteDatasetError.hidden = true;
    try {
      const reply = await requestDataset(`/signet/datasets/${encodeURIComponent(dataset.id)}`, undefined, "DELETE");
      if (reply.deleted !== dataset.id) throw new Error("Could not confirm the deletion. Try again.");
      deletedDatasetIds.add(dataset.id);
      datasetRevision++;
      const index = datasets.findIndex(({id}) => id === dataset.id);
      if (index !== -1) datasets.splice(index, 1);
      if (activeDataset.id === dataset.id) selectDataset(datasets[0] ?? emptyDataset);
      else renderDatasetLabels();
      deleteDatasetDialog.close();
      focusDatasetPane(datasets.length ? datasetSelect : datasetAdd);
      void loadWorkspaceHistory();
    } catch (error) {
      deleteDatasetError.textContent = error.message || "Could not delete this dataset. Try again.";
      deleteDatasetError.hidden = false;
    } finally {
      deletingDataset = false;
      deleteDatasetConfirm.textContent = "Delete dataset";
      deleteDatasetConfirm.disabled = deleteDatasetCancel.disabled = false;
      if (deleteDatasetDialog.open) deleteDatasetConfirm.focus();
    }
  });

  datasetAdd.addEventListener("click", () => {
    if (!datasetEditor.hidden) {
      closeDatasetForm();
      return;
    }
    window.dispatchEvent(new Event("close-dataset-remote-files"));
    setDatasetFormOpen(true);
    datasetName.focus();
  });
  byId("dataset-cancel").addEventListener("click", () => {
    closeDatasetForm();
    focusDatasetPane(datasetAdd);
  });
  datasetName.addEventListener("input", () => {
    datasetName.removeAttribute("aria-invalid");
    datasetError.hidden = true;
  });
  async function createDataset() {
    if (creatingDataset) return;
    const name = datasetName.value.trim();
    if (!name) {
      datasetFormError = "";
      renderDatasetLabels();
      datasetError.hidden = false;
      datasetName.setAttribute("aria-invalid", "true");
      datasetForm.dataset.saveState = "error";
      datasetName.focus();
      return;
    }
    const previousDatasetId = activeDataset.id;
    creatingDataset = true;
    datasetForm.dataset.saveState = "saving";
    datasetSaving.hidden = false;
    datasetError.hidden = true;
    datasetForm.querySelectorAll("input, button").forEach(control => { control.disabled = true; });
    datasetAdd.disabled = true;
    try {
      const record = await requestDataset("/signet/datasets", {name}, "POST");
      const dataset = acceptSavedDataset(record);
      creatingDataset = false;
      if (activeDataset.id === previousDatasetId) {
        selectDataset(dataset);
        showInputChoice(inputChoices[0]);
        focusDatasetPane(datasetSelect);
      } else {
        closeDatasetForm();
        renderDatasetLabels();
      }
      datasetForm.dataset.saveState = "saved";
    } catch (error) {
      datasetFormError = error.message;
      renderDatasetLabels();
      datasetError.hidden = false;
      if (datasetFormError === duplicateDatasetName) datasetName.setAttribute("aria-invalid", "true");
      datasetForm.dataset.saveState = "error";
    } finally {
      creatingDataset = false;
      datasetSaving.hidden = true;
      datasetForm.querySelectorAll("input, button").forEach(control => { control.disabled = false; });
      datasetAdd.disabled = false;
      if (!datasetError.hidden && !datasetEditor.hidden && app.dataset.nav === "data" && document.activeElement === document.body) {
        datasetName.focus();
      }
    }
  }
  datasetForm.addEventListener("submit", event => { event.preventDefault(); void createDataset(); });
  datasetName.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void createDataset();
  });

  const navigation = root.querySelectorAll("[data-nav-target]");
  const startConnection = byId("start-connection");
  const startConnectionStatus = byId("start-connection-status");
  window.addEventListener("workspace-remote-context", event => {
    const connected = event.detail?.connected === true;
    const status = connected ? "Connected" : "Not connected";
    startConnection.toggleAttribute("data-connected", connected);
    if (startConnectionStatus.textContent !== status) startConnectionStatus.textContent = status;
  });

  function openNavigation(view) {
    if (view !== "data") window.dispatchEvent(new Event("close-dataset-remote-files"));
    if (view === "history" && historyResult?.view === "analysis") {
      if (matchingHistoryRuns().some(run => historyKey(run) === historyResult.historyId)) {
        selectedRuns.set(historySelectionKey(), historyResult.historyId);
      } else clearHistoryResult();
    }
    app.dataset.nav = view;
    if (view === "analysis") bindAnalysisStage();
    const analysis = view === "analysis";
    root.querySelector(".ml-segment").hidden = !analysis;
    for (const tab of tabs) {
      root.querySelector("#" + tab.getAttribute("aria-controls")).hidden = !analysis || tab.getAttribute("aria-selected") !== "true";
    }
    syncContextChat();
    for (const panel of root.querySelectorAll("[data-nav-left], [data-nav-right]")) {
      panel.hidden = (panel.dataset.navLeft ?? panel.dataset.navRight) !== view;
    }
    updateAnalysisView();
    updateHistoryView();
    syncStage6Picker(true);
    for (const button of navigation) {
      if (button.dataset.navTarget === view) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    setSidebarOpen(true);
    if (view === "data") syncDatasetReferences(true);
  }
  for (const button of navigation) {
    button.addEventListener("click", () => openNavigation(button.dataset.navTarget));
  }
  for (const button of root.querySelectorAll("[data-start-view]")) {
    button.addEventListener("click", () => {
      openNavigation(button.dataset.startView);
      root.querySelector(`[data-nav-target="${button.dataset.startView}"]`).focus();
    });
  }
  byId("start-stage").addEventListener("click", () => {
    openNavigation("analysis");
    selectTab(tabs[1]);
    if (timeline.hidden) {
      tabs[1].focus();
      return;
    }
    showStage(stageButtons[0], true);
    stageButtons[0].focus();
  });
  const inputChoices = root.querySelectorAll("[data-input-target], [data-reference-navigation]");
  function showInputChoice(button) {
    for (const choice of inputChoices) {
      const selected = choice === button;
      choice.setAttribute("aria-pressed", String(selected));
      root.querySelector("#" + choice.getAttribute("aria-controls")).hidden = !selected;
    }
    const references = button.hasAttribute("data-reference-navigation");
    datasetFiles.querySelector("[data-input-validation]").hidden = references;
    datasetFiles.closest("[data-nav-right]").scrollTop = 0;
    if (references) syncDatasetReferences(true);
    else inputValidation.select(button.dataset.inputTarget);
  }
  for (const button of inputChoices) {
    button.addEventListener("click", () => {
      closeDatasetForm();
      window.dispatchEvent(new Event("close-dataset-remote-files"));
      showInputChoice(button);
    });
  }
  byId("history-scope").addEventListener("change", event => {
    historyScope = ["current", "unclassified", "all"].includes(event.target.value) ? event.target.value : "current";
    clearHistoryResult();renderDatasetLabels();updateHistoryView();syncStage6Picker(true);
    runDetails.scrollTop = 0;
  });
  runList.addEventListener("click", event => {
    const id = event.target.closest("[data-run-target]")?.dataset.runTarget;
    if (!matchingHistoryRuns().some(run => historyKey(run) === id)) return;
    selectedRuns.set(historySelectionKey(), id);
    clearHistoryResult();updateHistoryView();syncStage6Picker(true);
    runDetails.scrollTop = 0;
  });
  runDetails.addEventListener("change", event => {
    const picker = event.target.closest("[data-history-attempt-select]");
    if (picker) {
      const panel = picker.closest("[data-history-stage-panel]");
      historyDetailSelection.set(panel.id, {...historyDetailSelection.get(panel.id), record: picker.value});
      syncHistoryStageDetail(panel);
      syncHistoryLogs();
      return;
    }
    const select = event.target.closest("[data-history-dataset]");
    const id = select?.closest("[data-history-assignment]")?.dataset.historyAssignment;
    if (id) {
      assignmentStates.set(id, {...assignmentStates.get(id), datasetId: select.value, error: "", saved: false});
      const form = select.closest("[data-history-assignment]");
      form.dataset.saveState = "idle";
      form.querySelector("[data-history-assignment-status]").textContent = "Assignment not yet saved; sample matching is not verified.";
    }
  });
  runDetails.addEventListener("submit", async event => {
    const form = event.target.closest("[data-submission-recovery]");
    if (!form) return;
    event.preventDefault();
    const run = findHistoryRun(form.closest("[data-history-id]").dataset.historyId);
    const step = form.dataset.step, job = run?.jobs?.[step], key = form.dataset.submissionRecovery;
    if (!canContinue(run) || !["unknown", "submitting"].includes(job?.state)) return;
    const action = event.submitter?.value ?? "review", prior = submissionReviews.get(key);
    if (prior?.pending || action !== "review" && action !== prior?.result?.recovery?.outcome) return;
    const scope = recoveryRemote, attempt = job.attempt ?? 1, jobId = job.job_id ?? null;
    const state = {...prior, pending: true, error: null, staleEvidence: false};submissionReviews.set(key, state);renderHistoryRecords();updateHistoryView();
    try {
      const result = await requestDataset(`/signet/runs/${encodeURIComponent(run.run_id)}/steps/${encodeURIComponent(step)}/reconcile`,
        {expected_attempt: attempt, expected_job_id: jobId, action, confirmed: action !== "review"}, "POST");
      if (scope !== recoveryRemote || submissionReviews.get(key) !== state || result.record?.run_id !== run.run_id ||
          result.record?.step !== step || (result.record?.attempt ?? 1) !== attempt) return;
      state.result = result;state.error = null;
      if (action !== "review" && !result.applied) {
        state.result = null;state.staleEvidence = true;
      }
      if (result.applied) {submissionReviews.delete(key);await loadWorkspaceHistory();}
    } catch (error) {state.error = error.message;}
    finally {state.pending = false;renderHistoryRecords();updateHistoryView();}
  });
  runDetails.addEventListener("submit", async event => {
    const editor = event.target.closest("[data-rerun-editor]");
    if (editor) {event.preventDefault();editor.querySelector("[data-rerun-create]")?.click();return;}
    const form = event.target.closest("[data-history-assignment]");
    if (!form) return;
    event.preventDefault();
    const id = form.dataset.historyAssignment, run = findHistoryRun(id), datasetId = form.querySelector("[data-history-dataset]").value;
    if (!run?.capabilities?.assign_dataset || assignmentStates.get(id)?.saving || !datasetCatalogReady) return;
    if (!datasets.some(dataset => dataset.persisted && dataset.id === datasetId)) {
      assignmentStates.set(id, {datasetId, error: "Choose an existing dataset."});
      renderHistoryRecords();updateHistoryView();return;
    }
    assignmentStates.set(id, {datasetId, saving: true});renderHistoryRecords();updateHistoryView();
    try {
      const saved = await requestDataset(`/signet/history/${encodeURIComponent(id)}/dataset`, {dataset_id: datasetId, revision: run.revision}, "PATCH");
      if (historyKey(saved) !== id || saved.run_id !== run.run_id || saved.dataset_id !== datasetId) throw new Error("The saved assignment does not match this record.");
      historyRequest++;
      historyState = "ready";
      const index = historyRuns.findIndex(candidate => historyKey(candidate) === id);
      if (index !== -1) historyRuns[index] = saved;
      assignmentStates.set(id, {datasetId, saved: true});
      if (!matchingHistoryRuns().some(candidate => historyKey(candidate) === id)) {
        historyScope = "all";byId("history-scope").value = historyScope;selectedRuns.set(historySelectionKey(), id);
      }
    } catch (error) {assignmentStates.set(id, {datasetId, error: error.message});}
    renderHistoryRecords();renderDatasetLabels();updateHistoryView();syncStage6Picker(true);
  });
  runDetails.addEventListener("click", async event => {
    const button = event.target.closest("[data-rerun-review], [data-rerun-create], [data-rerun-submit]");
    if (!button) return;
    const container = button.closest("[data-rerun-form]");
    const content = container.querySelector("[data-rerun-content]");
    const status = container.querySelector("[data-rerun-status]");
    button.disabled = true;
    try {
      if (button.hasAttribute("data-rerun-review")) {
        const source = button.dataset.rerunSource, step = button.dataset.rerunReview;
        const review = await requestDataset(`/signet/runs/${encodeURIComponent(source)}/steps/${step}/rerun`);
        container.rerunReview = review;container.rerunPlan = null;
        content.innerHTML = `<p>Reuse upstream: ${escapeHistory(review.reuse.join(", ") || "—")}<br>Recompute: ${escapeHistory(review.invalidated.join(", "))}</p>
          <p>Old results are preserved. Submission requires a separate confirmation and remote file checks. Keep original inputs; edit settings, resources and options.</p>
          <form data-rerun-editor aria-label="Linked run parameters"><label>New run name<input name="run-name" data-rerun-name required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]*" spellcheck="false" value="${escapeHistory(source.slice(0, 58))}-rerun"></label>
          ${Object.keys(review.parameters.inputs ?? {}).length ? `<details><summary>Retained input files</summary><dl class="ml-key-values">${savedDefinitions(review.parameters.inputs)}</dl></details>` : ""}
          ${rerunParameterFields(review.parameters)}
          <button type="button" class="ml-nav-action" data-rerun-create>Create linked run (no submission)</button></form>`;
      } else if (button.hasAttribute("data-rerun-create")) {
        if (!content.querySelector("[data-rerun-editor]").reportValidity()) return;
        const review = container.rerunReview;
        const parameters = Object.fromEntries(Object.entries(review.parameters).map(([group, values]) => [group, {...values}]));
        for (const field of content.querySelectorAll("[data-rerun-group]")) {
          parameters[field.dataset.rerunGroup][field.dataset.rerunField] = field.type === "number" ? field.valueAsNumber : field.value;
        }
        const plan = await requestDataset(`/signet/runs/${encodeURIComponent(review.source_run_id)}/steps/${review.step}/rerun`, {
          new_run_id: content.querySelector("[data-rerun-name]").value,
          revision: review.revision, parameters,
        }, "POST");
        container.rerunPlan = plan;
        content.querySelectorAll("input, textarea, button").forEach(control => {control.disabled = true;});
        const confirm = document.createElement("button");
        confirm.type = "button";confirm.className = "ml-nav-action";confirm.dataset.rerunSubmit = "";
        confirm.textContent = `Confirm submission: ${plan.new_run_id}`;
        content.append(confirm);
        status.textContent = "Linked run created locally; nothing submitted.";
      } else {
        await requestDataset(`/signet/runs/${encodeURIComponent(button.dataset.rerunRunId ?? container.rerunPlan.new_run_id)}/rerun/submit`, {confirmed: true}, "POST");
        button.dataset.rerunSubmitted = "true";
        status.textContent = "Submission recorded. Reload history to inspect the new run.";
        return;
      }
    } catch (error) { status.textContent = error.message; }
    finally { if (!button.dataset.rerunSubmitted && (!button.hasAttribute("data-rerun-create") || !container.rerunPlan)) button.disabled = false; }
  });
  runDetails.addEventListener("click", event => {
    const stageChoice = event.target.closest("[data-history-select-stage]");
    if (stageChoice) {
      const article = stageChoice.closest(".ml-history-run");
      historyStageSelection.set(article.dataset.historyId, stageChoice.dataset.historySelectStage);
      syncHistoryStageSelection(article);
      syncHistoryLogs();
      return;
    }
    const tab = event.target.closest("[data-history-detail-tab]");
    if (tab) {
      const panel = tab.closest("[data-history-stage-panel]");
      historyDetailSelection.set(panel.id, {...historyDetailSelection.get(panel.id), tab: tab.dataset.historyDetailTab});
      syncHistoryStageDetail(panel);
      syncHistoryLogs();
      return;
    }
    const button = event.target.closest("[data-run-stage]");
    if (!button) return;
    const stage = Number(button.dataset.runStage), historyId = button.dataset.historyId;
    const run = matchingHistoryRuns().find(run => historyKey(run) === historyId);
    const savedJob = run?.jobs?.[historySteps[stage - 1]];
    if (!run || !(canReadStage(run, stage) || stage === 6 && canReadGraph(run) || canContinue(run) &&
      (Boolean(savedJob) && savedJob.state !== "not_submitted" &&
        (stage > 1 || savedJob.state !== "completed") || stage > 1 && canStartStage(run, stage)))) return;
    historyStageSelection.set(historyId, String(stage));
    clearHistoryResult();
    historyResult = {runId: run.run_id, historyId, stage};
    if (stage === 3 && canReadStage(run, 3)) void loadStage3Run();
    else if (archiveSteps.has(stage) && canReadStage(run, stage)) void loadArchivedStep();
    updateHistoryView();syncStage6Picker(true);
    const genotypeBack = root.querySelector("#lens-stage1 [data-genotype-back]");
    const expressionBack = root.querySelector("#lens-stage2 [data-expression-back]");
    const adjustmentBack = root.querySelector("#lens-stage3 [data-adjust-back]");
    const cisBack = root.querySelector("#lens-stage4 [data-cis-back]");
    const networkBack = root.querySelector("#lens-stage5 [data-network-back]");
    const visualizationBack = visualizationPanel.querySelector("[data-visualize-back]");
    const back = stage === 1 && !root.querySelector("#lens-stage1").hidden ? genotypeBack
      : stage === 2 && !root.querySelector("#lens-stage2").hidden ? expressionBack
      : stage === 3 && !root.querySelector("#lens-stage3").hidden ? adjustmentBack
      : stage === 4 && !root.querySelector("#lens-stage4").hidden ? cisBack
      : stage === 5 && !root.querySelector("#lens-stage5").hidden ? networkBack
      : stage === 6 && !visualizationPanel.hidden ? visualizationBack
      : stage === 3 ? stage3Back : stage === 6 ? stage6Back : archivedStepBack;
    back?.focus({preventScroll: true});
  });
  function focusHistoryStage(historyId, stage) {
    const article = runDetails.querySelector(`#ml-run-${CSS.escape(historyId)}`);
    if (!article) return;
    historyStageSelection.set(historyId, String(stage));
    syncHistoryStageSelection(article);
    syncHistoryLogs();
    const control = article.querySelector(`[data-run-stage="${stage}"]`) ?? article.querySelector(`[data-history-select-stage="${stage}"]`);
    control?.focus({preventScroll: true});
  }
  function backToRunTimeline() {
    if (!historyResult) return;
    const {historyId, stage} = historyResult;
    clearHistoryResult();
    updateHistoryView();
    syncStage6Picker();
    focusHistoryStage(historyId, stage);
  }
  archivedStepBack.addEventListener("click", backToRunTimeline);
  stage3Back.addEventListener("click", backToRunTimeline);
  stage6Back.addEventListener("click", backToRunTimeline);
  byId("close").addEventListener("click", () => {
    setSidebarOpen(false);
    root.querySelector('[data-nav-target][aria-current="page"]').focus();
  });
  byId("new").addEventListener("click", () => {
    if (chatBusy) return;
    openChat(createChat());
    globalThis.lucide?.createIcons();
    input.focus();
  });

  // A user's new selection invalidates outstanding navigation, including delayed graph loads.
  let navigationRevision = 0;
  let navigationAction = 0;
  root.addEventListener("click", event => {
    if (event.isTrusted && event.target.closest("[data-nav-target], [data-nav-right], [data-run-stage], [data-history-select-stage], [data-history-detail-tab], .ml-stage-button, [data-gene], #ml-run-list, #ml-stage6-run")) navigationRevision++;
  }, true);
  root.addEventListener("change", event => {
    if (event.isTrusted) navigationRevision++;
  }, true);
  async function applyWorkspaceAction(action, record, revision) {
    if (!action || action.version !== 1 || !["view_stage", "select_gene"].includes(action.action) ||
      !Number.isInteger(action.stage) || action.stage < 1 || action.stage > 6 ||
      typeof action.history_id !== "string" ||
      !/^(workspace|archive|recorded)--[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(action.history_id) ||
      Object.keys(action).some(key => !["version", "action", "history_id", "stage", "gene"].includes(key)) ||
      (action.action === "select_gene" ? action.stage !== 6 || typeof action.gene !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(action.gene) : action.gene !== undefined)) return false;
    const actionNumber = ++navigationAction;
    const current = () => activeChat === record && navigationRevision === revision && navigationAction === actionNumber;
    const run = findHistoryRun(action.history_id);
    const savedJob = run?.jobs?.[historySteps[action.stage - 1]];
    const readable = canReadStage(run, action.stage) || action.stage === 6 && canReadGraph(run);
    const reviewable = canContinue(run) && (Boolean(savedJob) && savedJob.state !== "not_submitted" &&
      (action.stage > 1 || savedJob.state !== "completed") || action.stage > 1 && canStartStage(run, action.stage));
    if (!current() || !run || !(action.action === "select_gene" ? action.stage === 6 && canReadGraph(run) : readable || reviewable)) return false;
    const dataset = datasets.find(candidate => candidate.id === run.dataset_id);
    if (run.dataset_id && !dataset) return false;
    if (dataset) selectDataset(dataset);
    historyScope = "all";
    byId("history-scope").value = historyScope;
    selectedRuns.set(historySelectionKey(), action.history_id);
    clearHistoryResult();
    historyResult = {runId: run.run_id, historyId: action.history_id, stage: action.stage};
    openNavigation("history");
    if (action.stage === 3) void loadStage3Run();
    else if (archiveSteps.has(action.stage)) void loadArchivedStep();
    if (action.action === "select_gene") {
      await loadStage6Run(action.history_id);
      if (!current() || historyResult?.historyId !== action.history_id || historyResult.stage !== 6 ||
        stage6Result?.history_id !== action.history_id || !stage6Result.graph.nodes.includes(action.gene)) return false;
      analysisNetwork.dispatchEvent(new CustomEvent("lens:select-gene", {detail: {gene: action.gene}}));
    }
    return true;
  }

  async function sendMessage() {
    const text = input.value.trim();
    if (chatBusy || !text) return;
    const record = activeChat;
    const turnId = crypto.randomUUID();
    const navigationAtSend = ++navigationRevision;
    const selection = {context: null};
    window.dispatchEvent(new CustomEvent("workspace-context-request", {detail: selection}));
    const workspace_context = selection.context;
    const status = byId("chat-status");
    const needsReview = "Needs review";
    const turn = appendChatEvent(record, "Conversation turn", "", "Running");
    turn.event.open = true;

    status.textContent = "Waiting for SIGNET Agent…";
    appendChatMessage(record, "user", createMessage("ml-message", text));
    const reply = createAgentReply(record);
    const thinking = document.createElement("span");
    thinking.className = "ml-thinking";
    thinking.setAttribute("aria-hidden", "true");
    thinking.append(...Array.from({length: 3}, () => document.createElement("span")));
    reply.append(thinking);

    let ready = false, stopRequested = false, finished = false, stopNotice;
    let done = false, failed = false, answered = false, outcome = "completed", pendingAnswer;
    function showStopNotice(message) {
      if (!stopNotice) {
        stopNotice = createMessage("ml-chat-notice", message);
        reply.parentElement.after(stopNotice);
      } else stopNotice.textContent = message;
      scrollChatToEnd();
    }
    async function requestStop() {
      try {
        const response = await fetch("/chat/cancel", {
          method: "POST",
          headers: {"Content-Type": "application/json", "X-Chat-Token": chatToken},
          body: JSON.stringify({session: record.session, turn_id: turnId}),
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error();
      } catch {
        if (done || finished) return;
        stopRequested = false;
        stopButton.removeAttribute("aria-disabled");
        thinking.hidden = false;
        status.textContent = "Could not stop the response. Try again.";
        turn.status.textContent = "Running";
        showStopNotice(status.textContent);
      }
    }
    stopActiveChat = () => {
      if (done || stopRequested) return;
      stopRequested = true;
      navigationRevision++;
      stopButton.setAttribute("aria-disabled", "true");
      thinking.hidden = true;
      status.textContent = "Stopping response…";
      turn.status.textContent = "Stopping";
      showStopNotice(status.textContent);
      if (ready) void requestStop();
    };
    setChatBusy(true);
    input.value = "";
    showChatDrawer(null);
    globalThis.lucide?.createIcons();
    reply.scrollIntoView({ block: "nearest" });

    const operations = new Map();
    function showAnswer(text) {
      renderAgentAnswer(reply, text);
      answered = true;
    }
    function consume(line) {
      if (done || !line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === "turn_started" && event.text?.turn_id === turnId && !ready) {
        ready = true;
        if (stopRequested) void requestStop();
      }
      if (event.type === "ui" && event.text?.panel === "workflow" && event.text.visible === true &&
          record === activeChat && navigationAtSend === navigationRevision) {
        openNavigation("settings");
        window.dispatchEvent(new Event("workspace-setup-refresh"));
      }
      if (event.type === "progress" && toolActivity(record, event.text, operations)) return;
      if (event.type === "model_fallback") showModelFallback(reply, event.text?.model);
      if (["progress", "error", "done"].includes(event.type)) {
        turn.log.textContent += (turn.log.textContent ? "\n" : "") + event.text;
      }
      if (event.type === "workspace_action") {
        void applyWorkspaceAction(event.workspace_action ?? event.text, record, navigationAtSend).then(applied => {
          if (!applied) turn.log.textContent += "\n" + "Navigation ignored: stale selection, unavailable result or invalid target.";
        }).catch(() => {
          turn.log.textContent += "\n" + "Navigation unavailable; no analysis was executed.";
        });
      }
      if (event.type === "answer") {
        if (stopRequested) pendingAnswer = event.text;
        else showAnswer(event.text);
      }
      if (event.type === "error") {
        if (answered || pendingAnswer !== undefined || failed) reply.after(createMessage("ml-saved-reply", event.text));
        else reply.textContent = event.text;
        failed = true;
      }
      if (event.type === "done") {
        outcome = chatOutcomes[event.status] ? event.status : failed ? "needs_review" : "completed";
        if (failed && outcome === "completed") outcome = "needs_review";
        done = true;
      }
    }

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json", "X-Chat-Token": chatToken},
        body: JSON.stringify({text, session: record.session, workspace_context, turn_id: turnId}),
      });
      if (!response.ok) throw new Error(await readChatError(response));
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const part = await reader.read();
        buffer += decoder.decode(part.value, {stream: !part.done});
        const lines = buffer.split("\n");
        buffer = lines.pop();
        lines.forEach(consume);
        if (part.done) break;
      }
      consume(buffer);
      if (!done) throw new TypeError();
      if (outcome === "cancelled") showStopNotice("Response stopped.");
      else {
        stopNotice?.remove();
        if (pendingAnswer !== undefined) showAnswer(pendingAnswer);
      }
      if (record.row.hidden) {
        record.title = Array.from(text.replace(/\s+/g, " ")).slice(0, 80).join("");
        record.button.querySelector("strong").textContent = record.title;
        byId("chat-title").textContent = record.title;
        record.deleteButton.setAttribute("aria-label", `Delete chat “${record.title}”`);
        record.row.hidden = false;
        byId("chat-records").prepend(record.row);
        byId("empty-chats").hidden = true;
      }
      record.outcome = outcome;
      status.textContent = chatOutcomes[outcome];
      turn.status.textContent = chatOutcomes[outcome];
    } catch (error) {
      stopNotice?.remove();
      const lostConnection = "Connection interrupted. Check any active jobs before retrying.";
      const detail = error instanceof TypeError || error instanceof SyntaxError ? lostConnection : error.message;
      if (answered || failed) reply.after(createMessage("ml-saved-reply", detail));
      else reply.textContent = detail;
      turn.log.textContent += (turn.log.textContent ? "\n" : "") + detail;
      status.textContent = needsReview;
      turn.status.textContent = needsReview;
      record.outcome = "needs_review";
    } finally {
      finished = true;
      if (thinking.parentNode === reply) {
        const message = reply.parentElement;
        message.remove();
      }
      const chatHadFocus = agentView.contains(document.activeElement);
      stopActiveChat = undefined;
      stopButton.removeAttribute("aria-disabled");
      setChatBusy(false);
      if (!byId("chat-transcripts").hidden && !agentView.hidden && !agentView.parentElement.hidden) {
        if (agentView.parentElement !== contextChat || chatHadFocus) {
          input.focus({preventScroll: true});
        }
        scrollChatToEnd();
      }
    }
  }
  byId("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      byId("composer").requestSubmit();
    }
  });

  genotypeRun = globalThis.mountGenotypeRun({
    panel: root.querySelector("#lens-stage1"),
    token: chatToken,
    onHistoryChanged: () => void loadWorkspaceHistory(),
    onOpenHistory: (runId) => void openGenotypeHistory(runId),
    onBack: backToRunTimeline,
  });
  expressionRun = globalThis.mountExpressionRun({
    panel: root.querySelector("#lens-stage2"),
    token: chatToken,
    onHistoryChanged: () => void loadWorkspaceHistory(),
    onOpenHistory: (runId) => void openExpressionHistory(runId),
    onBack: backToRunTimeline,
  });
  adjustmentRun = globalThis.mountAdjustmentRun({
    panel: root.querySelector("#lens-stage3"),
    token: chatToken,
    onHistoryChanged: () => void loadWorkspaceHistory(),
    onOpenHistory: (runId) => void openAdjustmentHistory(runId),
    onBack: backToRunTimeline,
  });
  cisRun = globalThis.mountCisRun({
    panel: root.querySelector("#lens-stage4"),
    token: chatToken,
    onHistoryChanged: () => void loadWorkspaceHistory(),
    onOpenHistory: (runId) => void openCisHistory(runId),
    onBack: backToRunTimeline,
  });
  networkRun = globalThis.mountNetworkRun({
    panel: root.querySelector("#lens-stage5"),
    token: chatToken,
    onHistoryChanged: () => void loadWorkspaceHistory(),
    onOpenHistory: (runId) => void openNetworkHistory(runId),
    onBack: backToRunTimeline,
  });
  visualizationRun = globalThis.mountVisualizationRun({
    panel: visualizationPanel,
    token: chatToken,
    onHistoryChanged: (runId) => void refreshVisualizationHistory(runId),
    onOpenHistory: (runId) => void openVisualizationHistory(runId),
    onBack: backToRunTimeline,
    onShowResults: showSavedStage6,
  });
  root.addEventListener("change", event => {
    if (event.target.matches(".ml-expression-run-label select")) renderRunTimeline();
  });
  root.addEventListener("click", event => {
    if (event.target.closest("[data-genotype-new]")) renderRunTimeline();
  });
  updateAnalysisView();
  updateHistoryView();
  window.dispatchEvent(new Event("workspace-request-remote-context"));
  globalThis.lucide?.createIcons();
  void loadWorkspaceHistory();
})();
