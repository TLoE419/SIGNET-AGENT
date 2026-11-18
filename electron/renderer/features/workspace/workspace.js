(() => {
  function drawStage3Scatter(panel, points, xTicks, yTicks, inEnglish = false) {
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
      const zh = `第 1 主成分 ${format(x)} · 第 2 主成分 ${format(y)}`;
      const en = `PC1: ${format(x)} · PC2: ${format(y)}`;
      marks.append(svg("circle", {
        cx: xFor(x).toFixed(2),
        cy: yFor(y).toFixed(2),
        r: 2.6,
        "data-tooltip": inEnglish ? en : zh,
        "data-en-data-tooltip": en,
      }));
    }
    panel.querySelector(".s3-points").replaceChildren(marks);
  }

  const exampleStage3 = document.getElementById("lens-stage3");
  const examplePoints = JSON.parse(exampleStage3.querySelector("[data-stage3-points]").textContent);
  drawStage3Scatter(exampleStage3, examplePoints, [-3, 0, 3, 6, 9, 12], [-6, -3, 0, 3, 6]);

  const root = document.getElementById("signet-lens-left-preview");
  const app = root.querySelector(".ml-app");

  function fitApp(width) {
    if (width > 0) app.style.setProperty("--ml-fit", width / app.offsetWidth);
  }
  fitApp(root.getBoundingClientRect().width);
  new ResizeObserver(([entry]) => fitApp(entry.contentRect.width)).observe(root);
  const byId = (id) => root.querySelector("#ml-" + id);
  const inputTypes = [
    ["genotype", "基因型資料", "Genotype data"],
    ["expression", "基因表現量資料", "Gene expression data"],
    ["clinical", "臨床資料", "Clinical data"],
  ];
  function makeDataset({id, name, folder = "", inputs = {}, default_inputs = inputs, persisted = true}) {
    return {id, name, folder, inputs, defaultInputs: default_inputs, persisted};
  }
  const exampleDataset = {
    id: "example-chr1", name: ["第 1 號染色體範例", "Chromosome 1 example"],
    inputs: {genotype: ["study.ped", "study.map"]},
    persisted: false,
  };
  const datasets = [makeDataset(exampleDataset)];
  let activeDataset = datasets[0];
  let datasetRevision = 0;
  let datasetCatalogReady = false;
  let datasetCatalogError = "";
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
  const localDatasetName = (dataset) => dataset.name[root.lang === "en" ? 1 : 0];
  const historyKey = run => run.history_id ?? `${run.source === "live" ? "workspace" : run.source}--${run.run_id}`;
  const findHistoryRun = id => historyRuns.find(run => historyKey(run) === id);
  const canContinue = run => run?.source === "live" && run.origin === "workspace" && run.capabilities?.continue_analysis === true;
  const canReadStage = (run, stage) => run?.capabilities?.stage_results?.includes(String(stage)) === true;
  const canReadGraph = run => run?.capabilities?.stage6_graph === true;
  const runsForDataset = () => historyRuns.filter((run) => run.dataset_id === activeDataset.id);
  const matchingHistoryRuns = () => historyRuns.filter(run => historyScope === "all" ||
    (historyScope === "unclassified" ? !run.dataset_id : run.dataset_id === activeDataset.id));
  const selectedHistoryResult = () => findHistoryRun(historyResult?.historyId);
  const stage6RunsForDataset = () => runsForDataset().filter(canReadGraph);
  const stage6RunsForView = () => app.dataset.nav === "history" ? matchingHistoryRuns().filter(canReadGraph) : stage6RunsForDataset();

  // Read current state synchronously at send time; never cache it on a chat/session.
  window.addEventListener("workspace-context-request", event => {
    if (!datasetCatalogReady || !["analysis", "history"].includes(app.dataset.nav)) return;
    const inHistory = app.dataset.nav === "history";
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

  async function requestDataset(path, body, method = "GET") {
    const response = await fetch(path, {method, body: JSON.stringify(body),
      headers: {"Content-Type": "application/json", "X-Chat-Token": chatToken}});
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error ||
      (root.lang === "en" ? "Could not read or save the dataset." : "無法讀取或儲存資料組。"));
    return result;
  }

  function acceptSavedDataset(record) {
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
  function selectTab(activeTab) {
    for (const tab of tabs) {
      const active = tab === activeTab;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      root.querySelector("#" + tab.getAttribute("aria-controls")).hidden = !active;
    }
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

  let inputValidation;
  const syncInputFiles = (() => {
    const template = byId("current-files-template");
    const inputs = [];
    const statuses = new Map();
    let saving = false;

    function renderInput(input) {
      const files = activeDataset.inputs[input.type] ?? [];
      const defaults = activeDataset.defaultInputs[input.type] ?? [];
      input.paths.replaceChildren(...files.map((file) => {
        const path = document.createElement("code");
        path.textContent = file;
        return path;
      }));
      const none = root.lang === "en" ? "No files selected" : "尚未選擇檔案";
      if (!files.length) input.paths.textContent = none;
      input.caption.textContent = files.length ? files.map((file) => file.split("/").at(-1)).join(" · ") : none;
      input.replaceButton.disabled = !datasetCatalogReady || !activeDataset.persisted || saving;
      input.resetButton.disabled = !datasetCatalogReady || !activeDataset.persisted || saving || JSON.stringify(files) === JSON.stringify(defaults);
      const status = statuses.get(`${activeDataset.id}:${input.type}`);
      input.current.dataset.saveState = status?.state ?? "idle";
      for (const message of input.messages) {
        message.hidden = message.dataset.fileStatus !== status?.state;
        if (message.dataset.fileStatus === "error") message.textContent = status?.error ?? "";
      }
    }

    function renderFiles() {
      for (const input of inputs) renderInput(input);
      inputValidation?.sync();
    }

    async function restoreDefaults(input) {
      if (saving || !datasetCatalogReady || !activeDataset.persisted) return;
      const datasetId = activeDataset.id;
      const files = [...(activeDataset.defaultInputs[input.type] ?? [])];
      const key = `${datasetId}:${input.type}`;
      saving = true;
      statuses.set(key, {state: "saving"});
      renderFiles();
      try {
        const record = await requestDataset(`/signet/datasets/${encodeURIComponent(datasetId)}`,
          {inputs: {[input.type]: files}}, "PATCH");
        if (record.id !== datasetId) throw new Error(root.lang === "en"
          ? "The saved dataset does not match this selection." : "儲存結果與這組資料不一致。");
        acceptSavedDataset(record);
        statuses.set(key, {state: "default"});
        renderDatasetLabels();
      } catch (error) {
        statuses.set(key, {state: "error", error: error.message});
      } finally {
        saving = false;
        renderFiles();
      }
    }

    for (const row of root.querySelectorAll("[data-input-target]")) {
      const article = root.querySelector("#" + row.getAttribute("aria-controls"));
      const current = template.content.firstElementChild.cloneNode(true);
      article.querySelector(".ml-nav-detail-title").after(current);
      const input = {
        current,
        type: row.dataset.inputTarget,
        paths: current.querySelector("[data-current-files]"),
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
          key: input.type, inputKind: input.type, label: labels[root.lang === "en" ? 2 : 1],
          current: paths[0] ?? "", currentPaths: [...paths], datasetId: activeDataset.id,
          multiple: input.type === "genotype", language: root.lang,
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

  inputValidation = window.SignetInputValidation.create({root, getDataset: () => ({
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
      name: "基因型準備", note: "核對資料組檔案後，手動送出基因型前處理。",
      settings: "在右側確認檔案與送算設定。",
      output: "送出後可查看排隊、執行和輸出檢查進度。",
      icon: "grid-3x3",
      preview: matrixPreview(["05050000000000", "00050000000000", "00050000000000", "00000000000000"]),
    },
    {
      name: "基因表現量準備", note: "準備這筆執行所選染色體的基因表現量。",
      settings: "在右側確認這筆執行的檔案與染色體。",
      output: "完成後查看這筆執行的樣本與基因結果。",
      icon: "grid-3x3",
      preview: matrixPreview(["22433443320232", "23432432241223", "45224454353243", "12322342231244"]),
    },
    {
      name: "樣本配對與校正", note: "配對樣本，再用主成分校正基因表現量。",
      settings: "在右側確認臨床資料與主成分數。",
      output: "完成後查看這筆執行的配對與校正結果。",
      icon: "bar-chart-3",
      preview: barPreview([473, 471], ["#b7cfe2", "#4380b2"]),
    },
    {
      name: "近端表現量關聯分析", note: "找出與鄰近基因表現量相關的變異。",
      settings: "在右側確認顯著門檻、分析範圍與置換次數。",
      output: "完成後從歷次執行查看關聯結果。",
      icon: "bar-chart-3",
      preview: barPreview([3, 2, 1], ["#4380b2", "#85afcf", "#b7cfe2"]),
    },
    {
      name: "網路推論", note: "重抽樣推論基因間可能的調控方向。",
      settings: "在右側確認重抽樣次數、相關性門檻與運算資源。",
      output: "完成後從歷次執行查看候選連線與出現頻率。",
      icon: "bar-chart-3",
      preview: barPreview([394, 337], ["#85afcf", "#4380b2"]),
    },
    {
      name: "網路視覺化", note: "按連線出現頻率篩選，輸出基因調控網路。",
      settings: "頻率門檻 0.45，顯示最大的 1 個子網路",
      output: "完整網路含 95 個基因、731 條連線，右側顯示節錄",
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
      chartTitle: "各變異位點的非零基因型編碼比例",
      axis: "變異位點數",
      bars: [["0–1%", 1884], ["1–5%", 495], ["5–10%", 138], ["10–25%", 131], ["25–50%", 174], ["50–100%", 161]],
      step: 500,
      caption: "以 560 個樣本統計 2,983 個變異位點。區間含下限，最後一組也含 100%。",
      settings: [
        ["樣本缺失率上限", "10%"], ["位點缺失率上限", "10%"],
        ["哈溫平衡檢定門檻", "p = 0.0001"], ["插補分塊長度", "5,000,000 個鹼基對"],
      ],
      tableTitle: "基因型編碼統計",
      headers: ["輸出編碼", "筆數", "比例"],
      rows: [["0", "1,552,102", "92.91%"], ["1", "99,798", "5.97%"], ["2", "18,580", "1.11%"]],
    },
    {
      number: 2,
      chartTitle: "轉換後的基因表現量分布",
      axis: "表現量數值筆數",
      bars: [["11–12", 617], ["12–13", 5634], ["13–14", 16258], ["14–15", 18300], ["15–16", 9462], ["16–17", 2116], ["17–18", 230], ["18–19", 13]],
      step: 5000,
      caption: "涵蓋 554 個樣本、95 個基因，共 52,630 筆數值。各區間含下限。",
      settings: [
        ["樣本總讀數下限", "2,500,000"], ["基因條件", "具註解的蛋白質編碼基因"],
        ["表現量處理", "變異數穩定轉換"],
      ],
      tableTitle: "基因表現量摘要節錄",
      headers: ["基因", "最小值", "中位數", "最大值"],
      rows: [
        ["C1orf159", "11.63", "13.82", "17.53"], ["MEGF6", "11.63", "14.12", "17.55"],
        ["CHD5", "11.63", "14.12", "16.94"], ["ACOT7", "11.62", "13.57", "16.76"], ["THAP3", "11.56", "14.31", "17.25"],
      ],
    },
    {
      number: 4,
      chartTitle: "各類變異的顯著關聯配對",
      axis: "顯著配對數",
      bars: [["常見變異", 156], ["低頻區域", 35], ["罕見區域", 15]],
      step: 40,
      caption: "共 206 筆顯著配對，涉及 85 個不同基因。低頻與罕見變異依區域合併分析。",
      settings: [
        ["顯著性門檻", "0.05"], ["上游範圍", "1,000 個鹼基對"],
        ["下游範圍", "1,000 個鹼基對"], ["低頻及罕見區域置換", "100 次"],
      ],
      tableTitle: "顯著配對節錄 · 最小的 5 筆 p 值",
      headers: ["基因", "變異或區域編號", "類別", "p 值"],
      rows: [
        ["P3H1", "35", "常見變異", "0.00010067"], ["MYSM1", "50", "常見變異", "0.00010346"],
        ["FMO5", "100", "常見變異", "0.00010483"], ["DRAXIN", "12", "常見變異", "0.00012454"],
        ["CAPN9", "191", "低頻區域", "0.00013783"],
      ],
    },
    {
      number: 5,
      chartTitle: "候選連線在重抽樣中的出現次數",
      axis: "候選連線數",
      bars: [["1 次（50%）", 394], ["2 次（100%）", 337]],
      step: 100,
      caption: "731 條候選連線至少出現在一次重抽樣中。第 6 階段會依出現頻率篩選。",
      settings: [
        ["重抽樣次數", "2 次"], ["每個基因的標記數上限", "3 個"], ["標記間絕對相關性上限", "0.3"],
        ["網路工作核心數", "2"], ["網路工作記憶體", "8 GB"], ["網路工作時間上限", "4 小時"],
      ],
      tableTitle: "推論連線節錄",
      headers: ["來源基因", "目標基因", "重抽樣出現頻率"],
      rows: [
        ["MEGF6", "CYP4Z1", "50%"], ["MEGF6", "LRRC40", "50%"], ["MEGF6", "HSD17B7", "50%"],
        ["MEGF6", "ATP1B1", "100%"], ["MEGF6", "RABGAP1L", "100%"],
      ],
    },
  ];

  const labelPairs = [
    ["工作區導覽", "Workspace navigation"],
    ["工作區側欄", "Workspace sidebar"],
    ["關閉側欄", "Close sidebar"],
    ["側欄檢視", "Sidebar views"],
    ["分析", "Analysis"],
    ["歷次執行", "Run history"],
    ["示範資料組", "Example dataset"],
    ["同一組模擬資料", "Same simulated dataset"],
    ["輸入資料", "Inputs"],
    ["輸入資料明細", "Input details"],
    ["基因型資料", "Genotype data"],
    ["基因表現量資料", "Gene expression data"],
    ["臨床資料", "Clinical data"],
    ["原始檔案", "Source files"],
    ["送算時的檔案", "Submitted files"],
    ["輸入檔案", "Input file"],
    ["原始樣本", "Input samples"],
    ["原始個體紀錄", "Input participant records"],
    ["資料來源", "Data source"],
    ["為示範分析整理的公開臨床資料", "Public clinical metadata prepared for the example"],
    ["第 1 階段保留的樣本", "Samples retained in stage 1"],
    ["第 1 階段輸出的變異", "Variants in stage 1 output"],
    ["第 2 階段保留的樣本", "Samples retained in stage 2"],
    ["第 2 階段輸出的基因", "Genes in stage 2 output"],
    ["查看第 1 階段", "View stage 1"],
    ["查看第 2 階段", "View stage 2"],
    ["查看第 3 階段", "View stage 3"],
    ["工作區設定", "Workspace settings"],
    ["原型預覽", "Prototype preview"],
    ["已保存的執行", "Saved runs"],
    ["執行明細", "Run details"],
    ["執行", "Run"],
    ["回到執行時間線", "Back to run timeline"],
    ["六階段執行時間線", "Six-stage run timeline"],
    ["本原型使用的執行", "Run shown in prototype"],
    ["重跑 · 階段進度驗證", "Rerun · stage progress check"],
    ["重跑 · 英文展示", "Rerun · English demo"],
    ["工作編號", "Job ID"],
    ["送出時間", "Submitted"],
    ["完成時間", "Finished"],
    ["分配資源", "Allocated resources"],
    ["助理", "Agent"],
    ["對話", "Conversation"],
    ["新增對話", "New conversation"],
    ["請用 Lens 帶我看這份筆記。", "use lens to walk me through this notebook"],
    ["執行紀錄", "Execution history"],
    ["執行中", "Running"],
    ["停止", "Stop"],
    ["已停止", "Stopped"],
    ["撰寫訊息", "Write a message"],
    ["輸入訊息", "Type your message"],
    ["輸入訊息…", "Type your message..."],
    ["程式碼模式（測試版）", "Code Mode (beta)"],
    ["停止執行", "Stop execution"],
    ["送出訊息", "Send message"],
    ["已完成：", "Done:"],
    ["第 1 號染色體", "Chromosome 1"],
    ["模擬分析", "Simulated run"],
    ["階段", "Stage"],
    ["從已完成的執行開啟網路圖與連線表。", "Open a completed run to see its network and connections."],
    ["設定", "Settings"],
    ["輸出", "Output"],
    ["資料", "Data"],
    ["第 1 號染色體 · 模擬結果", "Chromosome 1 · Simulated results"],
    ["第 1 號染色體 · 模擬結果節錄", "Chromosome 1 · Simulated results excerpt"],
    ["基因型準備", "Genotype preparation"],
    ["核對資料組檔案後，手動送出基因型前處理。", "Review the dataset files, then manually submit genotype preparation."],
    ["在右側確認檔案與送算設定。", "Review files and submission settings on the right."],
    ["送出後可查看排隊、執行和輸出檢查進度。", "After submission, follow the queue, job, and output checks."],
    ["基因表現量準備", "Gene expression preparation"],
    ["準備這筆執行所選染色體的基因表現量。", "Prepare expression data for this run’s selected chromosome."],
    ["在右側確認這筆執行的檔案與染色體。", "Review this run’s files and chromosome on the right."],
    ["完成後查看這筆執行的樣本與基因結果。", "View this run’s sample and gene results after completion."],
    ["在右側確認臨床資料與主成分數。", "Review the clinical file and principal component count on the right."],
    ["完成後查看這筆執行的配對與校正結果。", "View this run’s matching and adjustment results after completion."],
    ["只保留第 1 號染色體", "Chromosome 1 only"],
    ["554 個樣本 × 95 個基因", "554 samples × 95 genes"],
    ["樣本配對與校正", "Sample matching and adjustment"],
    ["配對樣本，再用主成分校正基因表現量。", "Match samples, then adjust expression using PCs."],
    ["使用 3 個主成分", "Use 3 principal components"],
    ["初步配對 473 位個體，校正後保留 471 位", "473 matched · 471 retained after adjustment"],
    ["近端表現量關聯分析", "Cis-eQTL analysis"],
    ["找出與鄰近基因表現量相關的變異。", "Test variants for associations with nearby genes."],
    ["在右側確認顯著門檻、分析範圍與置換次數。", "Review the threshold, range and permutations on the right."],
    ["完成後從歷次執行查看關聯結果。", "Open the association results from run history after completion."],
    ["在右側確認重抽樣次數、相關性門檻與運算資源。", "Review bootstrap runs, the correlation threshold and resources on the right."],
    ["完成後從歷次執行查看候選連線與出現頻率。", "Open candidate edges and frequencies from run history after completion."],
    ["顯著門檻 0.05，上下游各 1,000 個鹼基對，置換 100 次", "p < 0.05, ±1 kb, 100 permutations (low-frequency and rare)"],
    ["常見 156 筆、低頻 35 筆、罕見 15 筆", "156 common, 35 low-frequency, 15 rare pairs"],
    ["網路推論", "Network inference"],
    ["重抽樣推論基因間可能的調控方向。", "Use bootstrapping to infer directed gene links."],
    ["重抽樣 2 次，相關性門檻 0.3", "2 bootstrap runs · marker correlation cutoff 0.3"],
    ["394 條連線的出現頻率為 50%，337 條為 100%", "394 edges at 50% · 337 at 100%"],
    ["網路視覺化", "Network visualization"],
    ["按連線出現頻率篩選，輸出基因調控網路。", "Filter edges by frequency to visualize the network."],
    ["頻率門檻 0.45，顯示最大的 1 個子網路", "Frequency cutoff 0.45 · largest subnetwork"],
    ["完整網路含 95 個基因、731 條連線，右側顯示節錄", "Full network: 95 genes, 731 edges · excerpt shown"],
    ["各變異位點的非零基因型編碼比例", "Share of nonzero genotype codes by variant"],
    ["變異位點數", "Variant count"],
    ["以 560 個樣本統計 2,983 個變異位點。區間含下限，最後一組也含 100%。", "2,983 variants across 560 samples. Each bin includes its lower bound. The last also includes 100%."],
    ["樣本缺失率上限", "Max. sample missingness"],
    ["位點缺失率上限", "Max. variant missingness"],
    ["哈溫平衡檢定門檻", "HWE p-value cutoff"],
    ["插補分塊長度", "Imputation block size"],
    ["5,000,000 個鹼基對", "5,000,000 bp"],
    ["基因型編碼統計", "Genotype code summary"],
    ["輸出編碼", "Genotype code"],
    ["筆數", "Count"],
    ["比例", "Share"],
    ["轉換後的基因表現量分布", "Distribution of transformed gene expression"],
    ["表現量數值筆數", "Expression value count"],
    ["涵蓋 554 個樣本、95 個基因，共 52,630 筆數值。各區間含下限。", "52,630 values across 554 samples and 95 genes. Each bin includes its lower bound."],
    ["樣本總讀數下限", "Min. reads per sample"],
    ["基因條件", "Genes included"],
    ["具註解的蛋白質編碼基因", "Annotated protein-coding genes"],
    ["表現量處理", "Expression transform"],
    ["變異數穩定轉換", "Variance-stabilizing transformation"],
    ["基因表現量摘要節錄", "Gene expression summary excerpt"],
    ["基因", "Gene"],
    ["最小值", "Minimum"],
    ["中位數", "Median"],
    ["最大值", "Maximum"],
    ["前兩個主成分的樣本分布", "Sample distribution on the first two principal components"],
    ["471 位個體的散點圖，橫軸為第 1 主成分，縱軸為第 2 主成分", "Scatter plot of 471 individuals. PC1 is on the horizontal axis and PC2 on the vertical axis."],
    ["第 1 主成分", "PC1"],
    ["第 2 主成分", "PC2"],
    ["每個點代表 1 位個體。圖中分數由同次分析保留的基因型資料重算並標準化。", "Each point is one individual. Scores were recomputed from genotypes retained in this run and standardized."],
    ["樣本配對", "Sample matching"],
    ["樣本配對與校正結果", "Sample matching and adjustment results"],
    ["處理步驟", "Processing step"],
    ["數量", "Count"],
    ["基因型輸入", "Genotype inputs"],
    ["560 筆樣本", "560 samples"],
    ["基因表現量輸入", "Gene expression inputs"],
    ["554 筆樣本", "554 samples"],
    ["初步配對", "Initially matched"],
    ["473 位個體", "473 individuals"],
    ["校正後保留", "Retained after adjustment"],
    ["471 位個體", "471 individuals"],
    ["第 3 階段資訊", "Stage 3 details"],
    ["主成分數", "Principal components"],
    ["前", "Top"],
    ["個", ""],
    ["保留變異", "Retained variants"],
    ["1,110 個", "1,110"],
    ["分析基因", "Genes analyzed"],
    ["95 個", "95"],
    ["各類變異的顯著關聯配對", "Significant associations by variant group"],
    ["顯著配對數", "Significant pair count"],
    ["常見變異", "Common variants"],
    ["低頻區域", "Low-frequency regions"],
    ["罕見區域", "Rare-variant regions"],
    ["共 206 筆顯著配對，涉及 85 個不同基因。低頻與罕見變異依區域合併分析。", "206 significant pairs across 85 genes. Low-frequency and rare variants are grouped by region."],
    ["顯著性門檻", "Significance cutoff"],
    ["上游範圍", "Upstream window"],
    ["下游範圍", "Downstream window"],
    ["1,000 個鹼基對", "1,000 bp"],
    ["低頻及罕見區域置換", "Permutations (low/rare)"],
    ["100 次", "100"],
    ["顯著配對節錄 · 最小的 5 筆 p 值", "Significant pairs · 5 lowest p-values"],
    ["變異或區域編號", "Variant or region ID"],
    ["類別", "Category"],
    ["p 值", "p-value"],
    ["候選連線在重抽樣中的出現次數", "Candidate edge frequency across bootstrap runs"],
    ["候選連線數", "Candidate edge count"],
    ["1 次（50%）", "1 of 2 runs (50%)"],
    ["2 次（100%）", "2 of 2 runs (100%)"],
    ["731 條候選連線至少出現在一次重抽樣中。第 6 階段會依出現頻率篩選。", "731 candidate edges appeared in at least one bootstrap run. Stage 6 filters by frequency."],
    ["重抽樣次數", "Bootstrap runs"],
    ["2 次", "2"],
    ["每個基因的標記數上限", "Max. markers per gene"],
    ["3 個", "3"],
    ["標記間絕對相關性上限", "Max. absolute marker correlation"],
    ["網路工作核心數", "Network job cores"],
    ["網路工作記憶體", "Network job memory"],
    ["網路工作時間上限", "Network job time limit"],
    ["4 小時", "4 hours"],
    ["推論連線節錄", "Inferred edge excerpt"],
    ["來源基因", "Source gene"],
    ["目標基因", "Target gene"],
    ["重抽樣出現頻率", "Bootstrap frequency"],
    ["網路圖縮放", "Network zoom"],
    ["縮小網路圖", "Zoom out on network"],
    ["放大網路圖", "Zoom in on network"],
    ["可選取基因的調控網路", "Regulatory network with selectable genes"],
    ["連線資料", "Edge data"],
    ["基因調控連線", "Gene regulatory edges"],
    ["重抽樣頻率", "Bootstrap frequency"],
    ["係數", "Coefficient"],
    ["網路圖資訊", "Network details"],
    ["基因調控網路", "Gene regulatory network"],
    ["圖中範圍", "Shown"],
    ["清除選取", "Clear selection"],
  ];
  for (let number = 1; number <= stageData.length; number++) {
    labelPairs.push([`第 ${number} 階段`, `Stage ${number}`], [`第 ${number} 階段設定`, `Stage ${number} settings`]);
  }
  const toEnglish = new Map(labelPairs);
  const toChinese = new Map(labelPairs.map(([chinese, english]) => [english, chinese]));
  const englishLabel = (text) => toEnglish.get(text) ?? text;
  const escapeHistory = (value) => String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
  const countLabel = new Intl.NumberFormat("en-US");
  function countChart(bars, step, axis, title) {
    const maximum = step * (Math.floor(Math.max(...bars.map(([, value]) => value)) / step) + 1);
    const left = 74, right = 636, top = 50, bottom = 354;
    const columnWidth = (right - left) / bars.length;
    const barWidth = Math.min(128, columnWidth - Math.min(12, columnWidth / 2));
    const yFor = (value) => bottom - value / maximum * (bottom - top);
    const grid = Array.from({ length: maximum / step + 1 }, (_, index) => {
      const value = index * step;
      const y = yFor(value);
      return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" class="ml-count-grid"/>
        <text x="${left - 9}" y="${y + 4}" text-anchor="end">${countLabel.format(value)}</text>`;
    }).join("");
    const columns = bars.map(([label, value], index) => {
      const x = left + (index + .5) * columnWidth;
      const y = yFor(value);
      const formatted = countLabel.format(value);
      return `<rect class="ml-count-bar" x="${x - barWidth / 2}" y="${y}" width="${barWidth}" height="${bottom - y}" rx="2"/>
        <text class="ml-count-label" x="${x}" y="${y - 9}" text-anchor="middle">${formatted}</text>
        <text x="${x}" y="${bottom + 28}" text-anchor="middle">${escapeHistory(label)}</text>`;
    }).join("");
    const description = bars.map(([label, value]) => `${label} ${countLabel.format(value)}`).join("，");
    const englishDescription = bars.map(([label, value]) => `${englishLabel(label)} ${countLabel.format(value)}`).join(", ");
    return `<svg class="ml-count-chart" viewBox="0 0 660 410" role="img" aria-label="${escapeHistory(`${title}。${axis}：${description}`)}"
        data-en-aria-label="${escapeHistory(`${englishLabel(title)}. ${englishLabel(axis)}: ${englishDescription}`)}">
      <text x="${left}" y="23">${escapeHistory(axis)}</text>
      ${grid}${columns}
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
      <aside class="ml-result-inspector" aria-label="第 ${number} 階段設定">
        <header class="ml-result-inspector-heading">
          <i data-lucide="${icon}" aria-hidden="true"></i>
          <h2 id="lens-stage${number}-title">${name}</h2>
        </header>
        <dl class="ml-result-context">
          <dt>階段</dt><dd>第 ${number} 階段</dd>
          <dt>資料</dt><dd>第 1 號染色體 · 模擬結果</dd>
          ${settingsMarkup}
        </dl>
      </aside>
    </section>`;
  }).join("");
  app.insertAdjacentHTML("beforeend", snapshotMarkup);

  const timeline = byId("timeline");
  timeline.innerHTML = stageData.map(({ name, note, settings, output, icon, preview }, index) => {
    const number = index + 1;
    const expanded = number === stageData.length;
    return `<li class="ml-stage-entry">
      <p class="ml-stage-note"><span class="ml-stage-marker" aria-hidden="true"><i data-lucide="message-square-text"></i></span>${expanded ? "從已完成的執行開啟網路圖與連線表。" : note}</p>
      <button type="button" class="ml-stage-button" data-stage="${number}" aria-expanded="${expanded}" aria-controls="ml-stage-detail-${number}" ${expanded ? 'aria-current="step"' : ''}>
        <span class="ml-stage-title">
          <span class="ml-stage-marker" aria-hidden="true"><i data-lucide="list"></i></span>
          <span class="ml-stage-number">第 ${number} 階段</span>${name}
          <i data-lucide="chevron-down" class="ml-stage-chevron" aria-hidden="true"></i>
        </span>
        <span class="ml-stage-preview" aria-hidden="true">
          <span class="ml-stage-marker"><i data-lucide="${icon}"></i></span>
          <svg class="ml-stage-thumbnail" viewBox="0 0 132 36">${preview}</svg>
        </span>
      </button>
      <dl class="ml-stage-detail" id="ml-stage-detail-${number}" ${expanded ? "" : "hidden"}>
        <dt>設定</dt>${expanded ? '<dd id="ml-stage6-settings" data-live-language></dd>' : `<dd>${settings}</dd>`}
        <dt>輸出</dt>${expanded ? '<dd id="ml-stage6-output" data-live-language></dd>' : `<dd>${output}</dd>`}
      </dl>
    </li>`;
  }).join("");
  const stageButtons = timeline.querySelectorAll(".ml-stage-button");
  const stageResults = root.querySelectorAll(".ml-workspace");
  function syncGenotypeContext() {
    const stageContext = ["手動執行", "Manual execution"];
    const liveRuns = runsForDataset().filter(canContinue);
    const historyRun = selectedHistoryResult();
    const continuationRuns = app.dataset.nav === "history" ? (canContinue(historyRun) ? [historyRun] : []) : liveRuns;
    const continuationDataset = app.dataset.nav === "history" ? historyRun?.dataset_id ?? activeDataset.id : activeDataset.id;
    const genotypeHistory = app.dataset.nav === "history" && historyResult?.stage === 1 &&
      canContinue(historyRun) && historyRun.jobs.genotype?.state !== "completed";
    const genotypeDataset = genotypeHistory ? {
      id: continuationDataset,
      name: historyRun.dataset_name ?? datasets.find(dataset => dataset.id === continuationDataset)?.name ?? [continuationDataset, continuationDataset],
      inputs: historyRun.inputs,
      persisted: false,
      ready: datasetCatalogReady,
    } : {id: activeDataset.id, name: activeDataset.name, inputs: activeDataset.inputs,
      persisted: activeDataset.persisted, ready: datasetCatalogReady};
    byId("stage-header").querySelector("span").textContent = stageContext[root.lang === "en" ? 1 : 0];
    genotypeRun?.setContext({
      datasetId: genotypeDataset.id,
      dataset: genotypeDataset,
      runs: genotypeHistory ? continuationRuns : liveRuns,
      runId: genotypeHistory ? historyRun.run_id : null,
      language: root.lang,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "1" || genotypeHistory,
    });
    expressionRun?.setContext({
      datasetId: continuationDataset,
      language: root.lang,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "2" ||
        app.dataset.nav === "history" && historyResult?.stage === 2,
      runs: continuationRuns,
      runId: app.dataset.nav === "history" && historyResult?.stage === 2 ? historyResult.runId : null,
    });
    adjustmentRun?.setContext({
      datasetId: continuationDataset,
      language: root.lang,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "3" ||
        app.dataset.nav === "history" && historyResult?.stage === 3,
      runs: continuationRuns,
      runId: app.dataset.nav === "history" && historyResult?.stage === 3 ? historyResult.runId : null,
    });
    cisRun?.setContext({
      datasetId: continuationDataset,
      language: root.lang,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "4" ||
        app.dataset.nav === "history" && historyResult?.stage === 4,
      runs: continuationRuns,
      runId: app.dataset.nav === "history" && historyResult?.stage === 4 ? historyResult.runId : null,
    });
    networkRun?.setContext({
      datasetId: continuationDataset,
      language: root.lang,
      visible: app.dataset.nav === "analysis" &&
        timeline.querySelector('[aria-current="step"]')?.dataset.stage === "5" ||
        app.dataset.nav === "history" && historyResult?.stage === 5,
      runs: continuationRuns,
      runId: app.dataset.nav === "history" && historyResult?.stage === 5 ? historyResult.runId : null,
    });
    visualizationRun?.setContext({
      datasetId: continuationDataset,
      language: root.lang,
      visible: ["analysis", "history"].includes(app.dataset.nav) && visualizationFormVisible(),
      runs: continuationRuns,
      runId: app.dataset.nav === "history" && historyResult?.stage === 6 ? historyResult.runId : null,
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
    timeline.querySelector('[aria-current="step"]').removeAttribute("aria-current");
    button.setAttribute("aria-current", "step");
    syncGenotypeContext();
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
    graphMeta.setAttribute("data-live-language", "");
    const svg = (tag, attributes) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };

    let nodes, edges, nodeElements, edgeElements;
    function setNetwork(nextNodes, nextEdges, selectedGene = null) {
      nodes = nextNodes;
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
      const inEnglish = stage.closest("[lang]").lang === "en";
      graphMeta.textContent = inEnglish
        ? `${nodeElements.length} genes · ${edges.length} edges`
        : `${nodeElements.length} 個基因 · ${edges.length} 條連線`;
      for (const node of nodeElements) {
        const { gene: label } = node.dataset;
        node.setAttribute("aria-label", inEnglish ? `View connections for ${label}` : `查看 ${label} 的調控關係`);
      }
      if (gene) {
        const incoming = matched.filter(([, target]) => target === gene).length;
        const outgoing = matched.filter(([source]) => source === gene).length;
        const name = document.createElement("strong");
        name.textContent = gene;
        summary.replaceChildren(name, inEnglish
          ? ` · ${incoming} incoming (dashed) · ${outgoing} outgoing`
          : ` · 指向此基因 ${incoming} 條（虛線） · 從此基因指出 ${outgoing} 條`);
      } else {
        summary.textContent = inEnglish ? "Select a gene to see its connections." : "點選基因查看相連的調控關係。";
      }
      rowCount.textContent = inEnglish
        ? `${matched.length} ${matched.length === 1 ? "edge" : "edges"}`
        : `${matched.length} 筆`;
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
    stage.addEventListener("lens:language-changed", () => {
      const gene = stage.dataset.selectedGene || null;
      updateReadout(gene, edgesFor(gene));
    });
    setNetwork({}, []);
    return setNetwork;
  }

  const runList = byId("run-list");
  const runDetails = byId("run-details");
  let historyLogViews = [];
  const networkOutput = ([genes, edges]) => [
    `${genes} 個基因 · ${edges} 條連線`,
    `${genes} genes · ${edges} edges`,
  ];
  const historySteps = ["genotype", "expression", "adjust", "cis", "network", "visualize"];
  const historyText = (chinese, english) =>
    `<span data-history-zh="${escapeHistory(chinese)}" data-history-en="${escapeHistory(english)}"></span>`;
  const historyLabel = (chinese) => historyText(chinese, englishLabel(chinese));
  const clockTime = (value) => value?.match(/T(\d{2}:\d{2}:\d{2})/)?.[1] ?? "";
  const fullTime = (value) => value?.replace("T", " ").replace(/([+-]\d{2})(\d{2})$/, " $1:$2") ?? "";
  const notRecorded = () => historyText("未記錄", "Not recorded");

  const genotypeHistoryStates = {
    submitting: ["正在提交", "Submitting"], submitted: ["已送出", "Submitted"],
    pending: ["排隊中", "Queued"], running: ["執行中", "Running"],
    validating: ["正在檢查輸出", "Checking outputs"], completed: ["已完成", "Completed"],
    failed: ["失敗", "Failed"], cancelling: ["正在取消", "Cancelling"], cancelled: ["已取消", "Cancelled"],
    unknown: ["待確認狀態", "Status unconfirmed"], not_submitted: ["尚未送出", "Not submitted"],
    prepared: ["已準備，未記錄實際執行", "Prepared; execution not recorded"],
    process_completed: ["程序已完成，未驗證科學結果", "Process completed; scientific outputs unverified"],
    configured: ["已保存設定，未記錄執行", "Configured; execution not recorded"],
    recorded: ["已保存工具紀錄", "Tool activity recorded"],
    verified_completed: ["技術輸出已驗證", "Technical outputs verified"],
    starting: ["執行是否開始待確認", "Execution start unconfirmed"],
    not_recorded: ["未記錄", "Not recorded"],
  };
  const genotypeHistoryState = state => genotypeHistoryStates[state] ?? (state ? [state, state] : ["未記錄", "Not recorded"]);
  const historyJob = run => Object.values(run.jobs ?? {}).filter(job => job && typeof job === "object")
    .sort((a, b) => (Date.parse(a.finished_at || a.submitted_at) || 0) - (Date.parse(b.finished_at || b.submitted_at) || 0)).at(-1);
  const historyTime = run => Date.parse(run.finished_at || historyJob(run)?.finished_at || run.submitted_at || historyJob(run)?.submitted_at) || 0;
  const historySourceName = run => ({workspace: ["工作區執行", "Workspace run"], slurm: ["舊工具排程工作", "Legacy scheduler job"],
    agent: ["Agent 工具紀錄", "Agent tool record"], archive: ["封存結果", "Archived result"]})[run.origin] ?? ["來源未記錄", "Source not recorded"];
  const associationName = run => run.association?.status === "manual" ? ["手動歸類", "Manually assigned"]
    : run.dataset_id ? ["已記錄資料組", "Recorded dataset"] : ["未分類", "Unclassified"];
  const historyStateLabel = (state, savedOnly = false) => (savedOnly ? historyText("最後保存的狀態：", "Last recorded state: ") : "") + historyText(...genotypeHistoryState(state));
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
    return `<form data-submission-recovery="${escapeHistory(key)}" data-step="${escapeHistory(step)}">
      <p>${historyText("送出結果不明。核對只讀取本次嘗試的憑證與排程器證據，不會送算或取消工作。", "Submission is unconfirmed. Reconciliation only reads this attempt’s receipt and scheduler evidence; it never submits or cancels jobs.")}</p>
      <button class="ml-nav-action" type="submit" value="review" ${review?.pending ? "disabled" : ""}>${historyText("人工核對送出狀態", "Review submission evidence")}</button>
      <p role="status">${escapeHistory(review?.error ?? review?.result?.recovery?.detail ?? "")}</p>
      ${review?.result ? `<dl class="ml-key-values">${savedDefinitions(review.result.recovery.evidence)}</dl>` : ""}
      ${review?.result && ["adopt", "unsubmitted"].includes(review.result.recovery.outcome) ? `<p>${historyText("請核對來源、工作與嘗試次數；確認後僅更新紀錄。若確認未送出，仍須另行審閱一般重試表單。", "Review the source, job and attempt. Confirmation updates the record only; an unsubmitted attempt still requires the normal retry review.")}</p><button class="ml-nav-action" type="submit" value="${review.result.recovery.outcome}" ${review.pending ? "disabled" : ""}>${historyText("確認採用以上核對結果", "Confirm this recovery result")}</button>` : ""}
      <p>${escapeHistory(run.run_id)} · ${escapeHistory(step)} · ${job.attempt ?? 1} · ${escapeHistory(job.job_id ?? "—")}</p>
    </form>`;
  }

  const historyDatasetName = id => datasets.find(dataset => dataset.id === id)?.name ?? (id ? [id, id] : ["未分類", "Unclassified"]);
  const recordedValue = value => value == null ? notRecorded() : escapeHistory(typeof value === "object" ? JSON.stringify(value) : value);
  const submissionAudit = job => Array.isArray(job.submission_checks) && job.submission_checks.length ?
    `<details><summary>${historyText("送出狀態核對紀錄", "Submission reconciliation audit")}</summary>${job.submission_checks.slice(-25).map(check => `<p>${recordedValue(check.at)} · ${recordedValue(check.action)} · ${recordedValue(check.outcome)}<br>${recordedValue(check.detail)}<br>${recordedValue(check.evidence)}</p>`).join("")}</details>` : "";
  const savedDefinitions = value => Object.entries(value ?? {}).map(([key, item]) =>
    `<dt>${escapeHistory(key)}</dt><dd>${recordedValue(item)}</dd>`).join("") || `<dt>${historyText("內容", "Contents")}</dt><dd>${notRecorded()}</dd>`;
  function savedJobContent(job, operation = false) {
    const evidence = job.settings_evidence ?? (Object.keys(job.settings ?? {}).length || Object.keys(job.options ?? {}).length ? "recorded" : "not_recorded");
    const evidenceCopy = ({recorded: ["實際保存的設定", "Recorded settings"], prepared_snapshot: ["準備時的設定；不代表已執行", "Prepared settings; execution not implied"],
      not_recorded: ["設定未記錄", "Settings not recorded"]})[evidence] ?? [evidence, evidence];
    return `${submissionAudit(job)}<p data-settings-evidence="${escapeHistory(evidence)}">${historyText(...evidenceCopy)}</p>
        <dl class="ml-key-values"><dt>${historyText("工作編號", "Job ID")}</dt><dd>${recordedValue(job.job_id)}</dd>
          <dt>${historyText("送出時間", "Submitted at")}</dt><dd>${recordedValue(job.submitted_at)}</dd>
          <dt>${historyText("開始時間", "Started at")}</dt><dd>${recordedValue(job.started_at)}</dd>
          <dt>${historyText("結束時間", "Finished at")}</dt><dd>${recordedValue(job.finished_at ?? job.ended_at)}</dd>
          ${operation ? `<dt>${historyText("實際執行", "Executed")}</dt><dd>${job.executed === true ? historyText("是", "Yes") : job.executed === false ? historyText("否", "No") : notRecorded()}</dd>` : ""}
          <dt>${historyText("紀錄來源", "Record source")}</dt><dd>${recordedValue(job.record_file)}</dd>
          ${job.reason ? `<dt>${historyText("說明", "Reason")}</dt><dd>${recordedValue(job.reason)}</dd>` : ""}</dl>
        ${[["inputs", ["保存的輸入檔案", "Saved inputs"]], ["settings", ["保存的設定", "Saved settings"]], ["options", ["保存的選項", "Saved options"]], ["resources", ["保存的資源", "Saved resources"]]]
          .filter(([field]) => field !== "options" || Object.keys(job.options ?? {}).length)
          .map(([field, title]) => `<h4>${historyText(...title)}</h4><dl class="ml-key-values" data-history-saved="${field}">${savedDefinitions(job[field])}</dl>`).join("")}`;
  }
  const attemptResultNames = {
    recorded_completed: ["紀錄顯示已完成", "Recorded as completed"],
    recorded_failed: ["紀錄顯示失敗", "Recorded as failed"],
    recorded_cancelled: ["紀錄顯示已取消", "Recorded as cancelled"],
    pending: ["尚未記錄最終結果", "Final result not recorded"],
    not_recorded: ["結果未記錄", "Result not recorded"],
  };
  function outputCheckSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return "";
    return `<dl class="ml-key-values">${[["state", ["狀態", "State"]], ["reason", ["說明", "Reason"]],
      ["slurm_state", ["排程器狀態", "Scheduler state"]], ["exit_code", ["結束代碼", "Exit code"]],
      ["missing_outputs", ["當時缺少的檔案", "Missing outputs at the time"]], ["failure_hints", ["失敗提示", "Failure hints"]]]
      .filter(([field]) => snapshot[field] != null)
      .map(([field, label]) => `<dt>${historyText(...label)}</dt><dd>${field === "state" ? historyStateLabel(snapshot[field]) : recordedValue(snapshot[field])}</dd>`).join("")}</dl>
      ${["missing_outputs", "failure_hints"].filter(field => Array.isArray(snapshot[field]) && Number.isSafeInteger(snapshot[field + "_total"]) && snapshot[field + "_total"] > snapshot[field].length)
        .map(field => `<p data-history-output-check-truncated>${historyText(`這份核對摘要顯示前 ${snapshot[field].length} 項，共 ${snapshot[field + "_total"]} 項。`, `This check summary shows the first ${snapshot[field].length} of ${snapshot[field + "_total"]} items.`)}</p>`).join("")}`;
  }
  function savedOutputChecks(record) {
    const checks = Array.isArray(record.output_checks) ? record.output_checks.filter(check => check && typeof check === "object").slice(-25) : [];
    if (!checks.length && !record.original_failure) return "";
    const total = Number.isSafeInteger(record.output_checks_total) && record.output_checks_total >= checks.length ? record.output_checks_total : checks.length;
    return `<details data-history-output-checks data-output-check-detail="all"><summary>${historyText("輸出重新核對紀錄", "Output recheck history")} · ${total}</summary>
      <p>${historyText("這些是同一個工作、同一次嘗試的結果核對，沒有重新送算。", "These checks belong to the same job and attempt; no new analysis was submitted.")}</p>
      ${record.original_failure ? `<h4>${historyText("最初保存的失敗紀錄", "Original recorded failure")}</h4><div data-history-original-failure>${outputCheckSnapshot(record.original_failure)}</div>` : ""}
      <ol>${checks.map((check, index) => `<li data-history-output-check><time>${recordedValue(check.at)}</time>
        <details data-output-check-detail="${total - checks.length + index}-before"><summary>${historyText("核對前", "Before the check")}</summary>${outputCheckSnapshot(check.before)}</details>
        <details data-output-check-detail="${total - checks.length + index}-after"><summary>${historyText("核對後", "After the check")}</summary>${outputCheckSnapshot(check.after)}</details></li>`).join("")}</ol>
      ${total > checks.length ? `<p>${historyText(`顯示最近 ${checks.length} 次核對，最初失敗紀錄仍保留。`, `Showing the latest ${checks.length} checks; the original failure remains preserved.`)}</p>` : ""}
    </details>`;
  }
  function savedAttemptResult(attempt) {
    const result = attempt.result ?? {};
    const record = attempt.record ?? {};
    const outputs = Array.isArray(result.outputs) ? result.outputs.filter(output => output && typeof output.path === "string") : [];
    const outputStatus = {downloaded: ["紀錄顯示已下載", "Recorded as downloaded"], missing: ["紀錄顯示缺少", "Recorded as missing"],
      not_recorded: ["檔案狀態未記錄", "File status not recorded"]};
    return `<section class="ml-history-attempt-result" data-history-attempt-result>
      <h4>${historyText("保存的結果", "Saved result")}</h4>
      <p>${historyText(...(attemptResultNames[result.status] ?? attemptResultNames.not_recorded))}</p>
      <dl class="ml-key-values">${[["slurm_state", ["排程器狀態", "Scheduler state"]], ["exit_code", ["結束代碼", "Exit code"]],
        ["failure_hints", ["保存的失敗提示", "Recorded failure hints"]], ["missing_outputs", ["當時缺少的檔案", "Missing outputs at the time"]]]
        .filter(([field]) => record[field] != null)
        .map(([field, label]) => `<dt>${historyText(...label)}</dt><dd>${recordedValue(record[field])}</dd>`).join("")}</dl>
      ${outputs.length ? `<ul class="ml-history-attempt-outputs">${outputs.map(output => `<li><code>${recordedValue(output.path)}</code> · ${historyText(...(outputStatus[output.status] ?? outputStatus.not_recorded))}</li>`).join("")}</ul>` : ""}
    </section>`;
  }
  function savedAttempts(attempts) {
    return `<div class="ml-history-attempts">${[...attempts].sort((a, b) => Number(b.current) - Number(a.current) || (b.number ?? 0) - (a.number ?? 0)).map(attempt => {
      const number = attempt.number ?? "unknown";
      const available = attempt.availability === "recorded" && Boolean(attempt.record);
      const title = attempt.number == null ? historyText("嘗試次數未記錄", "Attempt number not recorded")
        : historyText(`第 ${attempt.number} 次嘗試`, `Attempt ${attempt.number}`);
      const state = available ? historyStateLabel(attempt.record.state ?? attempt.record.status, true)
        : historyText(attempt.availability === "invalid" ? "保存的紀錄無法讀取" : "缺少保存的紀錄", attempt.availability === "invalid" ? "Saved record unreadable" : "Saved record missing");
      const savedEvents = attempt.record?.history;
      const events = Array.isArray(savedEvents) ? savedEvents.filter(event => event && typeof event.state === "string" && typeof event.at === "string") : [];
      const unreadableEvents = savedEvents != null && (!Array.isArray(savedEvents) || events.length !== savedEvents.length);
      return `<details class="ml-history-attempt" data-history-attempt="${escapeHistory(number)}" data-attempt-record="${escapeHistory(attempt.record_file)}" data-attempt-current="${attempt.current === true}" data-attempt-available="${available}">
        <summary>${title}${attempt.current ? ` · ${historyText("目前紀錄", "Current record")}` : ""}<span class="ml-history-attempt-state">${state}</span></summary>
        <div class="ml-history-job-content">
          ${available ? savedJobContent({...attempt.record, record_file: attempt.record_file}) + savedAttemptResult(attempt) + savedOutputChecks(attempt.record) : `<p>${historyText("這次嘗試的檔案、設定與結果無法從現有紀錄確認。", "The inputs, settings and results of this attempt cannot be confirmed from the saved records.")}</p><p>${historyText("紀錄來源", "Record source")} · <code>${recordedValue(attempt.record_file)}</code></p>`}
          ${(attempt.issues ?? []).length ? `<p class="ml-history-record-note">${attempt.issues.map(escapeHistory).join(" ")}</p>` : ""}
          ${events.length ? `<h4>${historyText("保存的狀態時間線", "Recorded state timeline")}</h4><ol class="ml-history-attempt-events" data-history-attempt-events>${events.map(event => `<li>${historyText(...genotypeHistoryState(event.state))} · <time>${recordedValue(event.at)}</time>${event.reason ? ` · ${recordedValue(event.reason)}` : ""}</li>`).join("")}</ol>` : ""}
          ${unreadableEvents ? `<p data-history-attempt-event-warning>${historyText("部分保存的時間線無法讀取。", "Part of the recorded timeline is unreadable.")}</p>` : ""}
          ${available ? `<div data-history-job-logs data-log-kind="attempt" data-log-record="${escapeHistory(attempt.record_file)}"></div>` : ""}
        </div></details>`;
    }).join("")}</div>`;
  }
  function savedJobDetails(job, key, operation = false, savedOnly = false, attempts = []) {
    return `<details class="ml-run-step ml-history-saved-job" ${operation ? `data-history-operation="${escapeHistory(key)}" data-history-operation-record="${escapeHistory(job.record_file)}"` : `data-history-job="${escapeHistory(key)}"`}>
      <summary>${escapeHistory(key)} · <span data-history-job-state>${historyStateLabel(job.state ?? job.status, savedOnly || operation)}</span>
        ${attempts.length ? `<span class="ml-history-attempt-count">${historyText(`嘗試紀錄（${attempts.length}）`, `Attempt records (${attempts.length})`)}</span>` : ""}</summary>
      ${attempts.length ? savedAttempts(attempts) : `<div class="ml-history-job-content">${savedJobContent(job, operation)}<div data-history-job-logs data-log-kind="${operation ? "operation" : "job"}" data-log-record="${escapeHistory(job.record_file)}"></div></div>`}</details>`;
  }
  function canStartStage(run, number) {
    return canContinue(run) && number > 1 && historySteps.slice(0, number - 1).every(step => run.jobs?.[step]?.state === "completed");
  }
  function historyDisclosureKey(details) {
    const job = details.closest("[data-history-job], [data-history-operation]");
    const scope = job?.dataset.historyJob ?? (job?.dataset.historyOperation ? `${job.dataset.historyOperation}:${job.dataset.historyOperationRecord}` : details.hasAttribute("data-history-provenance") ? "provenance" : "inputs");
    const outputCheck = details.dataset.outputCheckDetail;
    const record = outputCheck ? details.closest("[data-attempt-record]")?.dataset.attemptRecord : "";
    return `${details.closest("[data-history-id]")?.dataset.historyId}|${scope}|${details.dataset.attemptRecord ?? details.dataset.historyAttempt ?? record ?? ""}${outputCheck ? `|output-check:${outputCheck}` : ""}`;
  }
  function renderHistoryRecords() {
    const expanded = new Set([...runDetails.querySelectorAll("details[open]:not([data-job-logs])")].map(details =>
      historyDisclosureKey(details)));
    for (const {view} of historyLogViews) view.destroy();
    historyLogViews = [];
    runList.innerHTML = historyRuns.map(run => {
      const key = escapeHistory(historyKey(run)), id = escapeHistory(run.run_id);
      const state = run.status ?? historyJob(run)?.state;
      const started = fullTime(run.submitted_at ?? run.jobs?.genotype?.submitted_at ?? historyJob(run)?.submitted_at);
      const icon = state === "completed" ? "circle-check" : "history";
      return `<button class="ml-nav-list-item" type="button" data-run-target="${key}" data-history-id="${key}" data-run-id="${id}" aria-controls="ml-run-${key}" aria-pressed="false">
        <i data-lucide="${icon}" aria-hidden="true"></i><span><strong>${historyText(...run.name)}</strong>
        <small>${historyText(...historySourceName(run))} · ${historyStateLabel(state, run.source === "recorded")}</small>
        <small>${escapeHistory(started)}</small></span></button>`;
    }).join("");
    runDetails.innerHTML = historyRuns.map(run => {
      const key = escapeHistory(historyKey(run)), id = escapeHistory(run.run_id);
      const initialJob = run.jobs?.genotype ?? historyJob(run);
      const finished = fullTime(run.finished_at ?? historyJob(run)?.finished_at);
      const state = run.status ?? historyJob(run)?.state;
      const summary = canReadGraph(run) && run.graph ? historyText(...networkOutput([run.graph.genes, run.graph.connections])) : "";
      const stages = historySteps.map((step, offset) => {
        const job = run.jobs?.[step], number = offset + 1;
        const attempts = run.attempts?.[step] ?? [];
        const linked = canReadStage(run, number) || number === 6 && canReadGraph(run) ||
          canContinue(run) && (Boolean(job) && job.state !== "not_submitted" &&
            (number > 1 || job.state !== "completed") || number > 1 && canStartStage(run, number));
        if (!job && !linked && !attempts.length) return "";
        const title = `<i data-lucide="${job?.state === "completed" ? "circle-check" : "history"}" aria-hidden="true"></i>
          ${historyText(`第 ${number} 階段`, `Stage ${number}`)}<strong>${historyLabel(stageData[offset].name)}</strong>
          <time datetime="${escapeHistory(job?.finished_at)}">${escapeHistory(clockTime(job?.finished_at))}</time>`;
        const panel = number === 1 && canContinue(run) && job?.state !== "completed" ? "lens-stage1"
          : number === 6 && canContinue(run) && job?.state !== "completed" ? "lens-stage6-run"
          : [2, 3, 4, 5].includes(number) && canContinue(run) && job?.state !== "completed" ? `lens-stage${number}`
          : number === 3 ? "lens-history-stage3" : number === 6 ? "lens-stage6" : "lens-history-stage";
        const link = linked ? `<button type="button" class="ml-run-step-link" data-run-stage="${number}" data-run-id="${id}" data-history-id="${key}" aria-controls="${panel}">
          ${title}<i data-lucide="arrow-right" aria-hidden="true"></i></button>` : "";
        const rerun = run.source === "live" && job?.state === "completed" ? `<details data-rerun-form><summary>${historyText("核對參數並建立新執行", "Review parameters and create linked run")}</summary>
          <button type="button" data-rerun-review="${step}" data-rerun-source="${id}">${historyText("讀取原始參數與影響", "Load original parameters and impact")}</button><div data-rerun-content></div><p role="status" data-rerun-status></p></details>` : "";
        return `<li>${link}${rerun}${job || attempts.length ? savedJobDetails(job ?? {}, step, false, run.source === "recorded", attempts) : ""}${submissionRecovery(run, step, job)}</li>`;
      }).join("");
      const genericJobs = [...new Set([...Object.keys(run.jobs ?? {}), ...Object.keys(run.attempts ?? {})])].filter(step => !historySteps.includes(step))
        .map(step => savedJobDetails(run.jobs?.[step] ?? {}, step, false, run.source === "recorded", run.attempts?.[step])).join("");
      const operations = (run.operations ?? []).map(operation => savedJobDetails(operation, operation.operation ?? "operation", true)).join("");
      const snapshot = inputTypes.map(([type, zh, en]) => {
        const files = run.inputs?.[type] ?? [];
        return `<dt>${historyText(zh, en)}</dt><dd>${files.length ? files.map(file => `<code>${escapeHistory(file)}</code>`).join("<br>") : notRecorded()}</dd>`;
      }).join("");
      const assignment = assignmentStates.get(historyKey(run)) ?? {};
      const association = historyText(...associationName(run));
      const associationNote = run.association?.status === "manual" ? historyText("此歸類僅供整理紀錄，不代表已確認樣本或檔案配對。", "This assignment organizes records; it does not verify sample or file matching.") : "";
      const assignForm = run.capabilities?.assign_dataset ? `<form class="ml-history-assignment" data-history-assignment="${key}" data-save-state="${assignment.saving ? "saving" : assignment.error ? "error" : assignment.saved ? "saved" : "idle"}">
        <label><span>${historyText("歸類到資料組", "Assign to dataset")}</span><select data-history-dataset ${assignment.saving || !datasetCatalogReady ? "disabled" : ""}>
          <option value="">${root.lang === "en" ? "Choose an existing dataset" : "選擇現有資料組"}</option>
          ${datasets.filter(dataset => dataset.persisted).map(dataset => `<option value="${escapeHistory(dataset.id)}" ${(assignment.datasetId ?? run.dataset_id) === dataset.id ? "selected" : ""}>${escapeHistory(localDatasetName(dataset))}</option>`).join("")}</select></label>
        <button type="submit" class="ml-nav-action" data-history-assign ${assignment.saving || !datasetCatalogReady ? "disabled" : ""}>${historyText(assignment.saving ? "正在保存…" : "保存歸類", assignment.saving ? "Saving…" : "Save assignment")}</button>
        <p data-history-assignment-status role="status">${assignment.error ? escapeHistory(assignment.error) : assignment.saved ? historyText("歸類已保存。", "Assignment saved.") : historyText("僅整理執行紀錄，不會更改檔案、設定或確認樣本配對。", "Organizes run history only; files, settings and sample matching are unchanged.")}</p></form>` : "";
      return `<article class="ml-nav-detail" id="ml-run-${key}" data-history-id="${key}" data-run-id="${id}" hidden>
        <header class="ml-nav-detail-title"><i data-lucide="history" aria-hidden="true"></i><h2>${historyText(...run.name)}</h2></header>
        <p class="ml-run-overview">${id}<br>${escapeHistory(fullTime(run.submitted_at ?? initialJob?.submitted_at))}${finished ? " – " + escapeHistory(finished) : ""}<br>
          <span data-history-source>${historyText(...historySourceName(run))}</span> · <span data-history-state>${historyStateLabel(state, run.source === "recorded")}</span>${summary ? `<br>${summary}` : ""}</p>
        ${run.rerun && run.source === "live" && (!run.jobs?.[run.rerun.step] || run.jobs[run.rerun.step].state === "not_submitted") ? `<div data-rerun-form><p>${historyText("已建立關聯執行，尚未送出。確認後將檢查遠端上游檔案並排程。", "Linked run created; not submitted. Confirmation checks remote upstream files and submits the stage.")}</p><button type="button" data-rerun-submit data-rerun-run-id="${id}">${historyText("確認送出", "Confirm submission")}: ${id}</button><div data-rerun-content></div><p role="status" data-rerun-status></p></div>` : ""}
        ${run.rerun ? `<p data-rerun-link>${historyText("關聯來源", "Linked source")}: ${escapeHistory(run.rerun.source_run_id)} · ${escapeHistory(run.rerun.step)}</p>` : ""}
        <p data-history-association>${association} · ${historyText(...historyDatasetName(run.dataset_id))}${associationNote ? `<br>${associationNote}` : ""}</p>
        ${run.provenance ? `<details class="ml-run-inputs" data-history-provenance><summary>${historyText("保存的執行來源", "Recorded run provenance")}</summary><dl class="ml-key-values">${savedDefinitions(run.provenance)}</dl></details>` : ""}
        ${(run.issues ?? []).length ? `<p class="ml-history-record-note">${run.issues.map(escapeHistory).join(" ")}</p>` : ""}
        ${assignForm}<details class="ml-run-inputs" open><summary>${historyText("執行時使用的檔案", "Input files at execution")}</summary><dl class="ml-key-values">${snapshot}</dl></details>
        <ol class="ml-run-timeline" aria-label="${root.lang === "en" ? "Run timeline" : "執行時間線"}">${stages}</ol>
        ${genericJobs}${operations}${!stages && !genericJobs && !operations ? `<p>${historyText("未保存可讀的工作設定。", "No readable job settings were recorded.")}</p>` : ""}
      </article>`;
    }).join("");
    for (const details of runDetails.querySelectorAll("details:not([data-job-logs])")) {
      if (expanded.has(historyDisclosureKey(details))) details.open = true;
    }
    if (globalThis.SignetJobLogs) for (const host of runDetails.querySelectorAll("[data-history-job-logs]")) {
      const run = findHistoryRun(host.closest("[data-history-id]").dataset.historyId);
      const step = host.closest("[data-history-job]")?.dataset.historyJob;
      const operation = host.closest("[data-history-operation]")?.dataset.historyOperation;
      const attempt = host.dataset.logKind === "attempt" ? run.attempts?.[step]?.find(attempt => attempt.record_file === host.dataset.logRecord) : null;
      const record = operation ? run.operations?.find(record => record.operation === operation && record.record_file === host.dataset.logRecord) : attempt?.record ?? run.jobs?.[step];
      const context = {historyId: historyKey(run), runId: run.run_id, source: run.source, datasetId: run.dataset_id,
        step, operation, number: attempt ? attempt.number : run.source === "archive" ? null : record?.attempt ?? 1,
        current: attempt?.current ?? true, recordFile: attempt?.record_file ?? record?.record_file ?? `steps/${step}.json`,
        recordIdentity: run.record_identity, recordRevision: record?.record_revision, record,
        prepared: Boolean(operation && (record?.status === "prepared" || record?.record_file?.endsWith(".plan.json")))};
      const view = globalThis.SignetJobLogs.mount({host, token: () => chatToken});
      historyLogViews.push({view, context});
    }
    renderHistoryLanguage();
    globalThis.lucide?.createIcons();
  }

  function renderHistoryLanguage() {
    const key = root.lang === "en" ? "historyEn" : "historyZh";
    for (const node of root.querySelectorAll("[data-history-zh]")) node.textContent = node.dataset[key];
    for (const timeline of runDetails.querySelectorAll(".ml-run-timeline")) {
      timeline.setAttribute("aria-label", root.lang === "en" ? "Run timeline" : "執行時間線");
    }
    for (const option of runDetails.querySelectorAll("[data-history-dataset] option")) {
      option.textContent = option.value ? historyDatasetName(option.value)[root.lang === "en" ? 1 : 0]
        : root.lang === "en" ? "Choose an existing dataset" : "選擇現有資料組";
    }
    syncHistoryLogs();
  }
  function syncHistoryLogs() {
    for (const {view, context} of historyLogViews) view.setContext({...context, language: root.lang, visible: app.dataset.nav === "history"});
  }

  const analysisNetwork = root.querySelector("#lens-stage6");
  const setLiveNetwork = mountNetwork(analysisNetwork);

  const input = byId("input");
  const initialChat = JSON.parse(document.getElementById("initial-chat").textContent);
  const chatToken = document.querySelector('meta[name="chat-token"]').content;
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
    listing: ["讀取已完成的執行…", "Finding completed runs…"],
    empty: ["目前沒有可檢視的第 6 階段結果。", "No Stage 6 results are available."],
    choose: ["選擇一筆已完成的執行。", "Choose a completed run."],
    loading: ["讀取網路圖和連線表…", "Loading network and connections…"],
    "list-error": ["無法讀取已完成的執行。", "Could not load completed runs."],
    "load-error": ["無法讀取這筆執行的結果。", "Could not load this run’s results."],
    "no-edges": ["這筆執行沒有匯出的連線。", "This run has no exported edges."],
  };
  const selectedStage6Genes = new Map();
  const analysisRunByDataset = new Map();
  let stage6Result = null;
  let stage6Request;
  let requestedStage6Run = null;
  analysisNetwork.dataset.runState = "listing";

  function visualizationFormVisible() {
    if (app.dataset.nav === "history") {
      const run = selectedHistoryResult();
      return historyResult?.stage === 6 && canContinue(run) && run.jobs.visualize?.state !== "completed";
    }
    if (!["analysis", "settings"].includes(app.dataset.nav)) return false;
    return timeline.querySelector('[aria-current="step"]')?.dataset.stage === "6" &&
      runsForDataset().some(canContinue) &&
      !stage6RunsForDataset().some(run => historyKey(run) === stage6RunSelect.value);
  }

  function syncVisualizationPanels() {
    const inHistory = app.dataset.nav === "history";
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
    const language = root.lang === "en" ? 1 : 0;
    const state = analysisNetwork.dataset.runState;
    const run = stage6RunsForView().find(run => historyKey(run) === stage6RunSelect.value);
    const [counts, frequency, topNetworks] = [stage6Result?.graph.counts, stage6Result?.frequency, stage6Result?.top_networks];
    const empty = stage6Result?.graph.edges.length === 0;
    stage6Source.textContent = run ? historySourceName(run)[language] : ["執行", "Run"][language];
    stage6RunSelect.options[0].textContent = ["選擇執行", "Select a run"][language];
    stage6RunSelect.title = run?.run_id ?? "";
    stage6HistoryLabel.textContent = run?.name[language] ?? "";
    stage6HistoryLabel.title = run?.run_id ?? "";
    stage6Status.hidden = state === "ready" && !empty;
    stage6Status.textContent = (stage6Labels[empty ? "no-edges" : state] ?? ["", ""])[language];
    stage6Summary.hidden = !stage6Status.hidden;
    stage6Retry.hidden = !["empty", "list-error", "load-error"].includes(state);
    byId("stage6-settings").textContent = Number.isFinite(frequency) && Number.isInteger(topNetworks)
      ? [`頻率門檻 ${frequency} · 顯示前 ${topNetworks} 個子網路`, `Frequency threshold ${frequency} · Top ${topNetworks} subnetworks`][language]
      : "—";
    byId("stage6-output").textContent = counts ? networkOutput([counts.genes, counts.connections])[language] : "—";
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
    stage6Request?.abort();
    requestedStage6Run = historyId;
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
      const query = new URLSearchParams({run: runId, source: run.source});
      const result = await getArchivedResult("/stage6/results?" + query, {signal: request.signal});
      if (request.signal.aborted) return;
      if (result.run_id !== runId || result.source !== run.source) {
        throw new Error("Stage 6 result belongs to a different run");
      }
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
      analysisNetwork.dataset.runId = runId;
      analysisNetwork.dataset.historyId = historyId;
      setStage6RunState("ready");
    } catch {
      if (!request.signal.aborted) {
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
        const option = new Option(`${run.run_id} · ${historySourceName(run)[root.lang === "en" ? 1 : 0]}`, historyKey(run));
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
  const stage3Legend = stage3HistoryPanel.querySelector("figcaption");
  const stage3Status = stage3HistoryPanel.querySelector("[data-s3-status]");
  const stage3RunLabel = stage3HistoryPanel.querySelector("[data-s3-run]");
  const stage3Components = stage3HistoryPanel.querySelector("[data-s3-components]");
  const stage3Counts = stage3HistoryPanel.querySelectorAll("[data-s3-count]");
  const stage3ComparisonRows = stage3HistoryPanel.querySelector("[data-s3-difference] tbody");
  const stage3MetricNote = stage3HistoryPanel.querySelector(".s3-metric-note");
  const stage3Comparison = [
    ["before", "校正前", "Before adjustment", "before_sd"],
    ["covariates", "僅校正性別與種族", "Adjusted for sex and race", "covariates_sd"],
    ["after", "校正後", "After adjustment", "after_sd"],
  ];
  const stage3States = {
    loading: ["讀取第 3 階段封存結果…", "Loading the archived Stage 3 result…"],
    empty: ["這次執行沒有可讀取的第 3 階段封存結果。", "This run has no readable Stage 3 archive."],
    error: ["無法載入第 3 階段結果。", "Could not load the Stage 3 result."],
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
    const inEnglish = root.lang === "en";
    const locale = inEnglish ? "en" : "zh-Hant";
    const run = historyResult?.stage === 3
      ? selectedHistoryResult() : null;
    const state = stage3HistoryPanel.dataset.runState;
    const number = new Intl.NumberFormat(locale);
    const formatSD = new Intl.NumberFormat(locale, {maximumFractionDigits: 5, minimumFractionDigits: 5});
    const formatChange = new Intl.NumberFormat(locale, {maximumFractionDigits: 5, minimumFractionDigits: 5, signDisplay: "exceptZero"});
    const missing = inEnglish ? "Not recorded" : "未記錄";
    const comparison = stage3Result?.comparison;
    const pca = stage3Result?.pca;

    stage3RunLabel.textContent = run?.name[inEnglish ? 1 : 0] ?? "";
    stage3RunLabel.title = run?.run_id ?? "";
    stage3RunLabel.previousElementSibling.textContent = run?.source === "live"
      ? (inEnglish ? "Run" : "執行") : (inEnglish ? "Archived run" : "封存執行");
    stage3Components.textContent = stage3Result ? number.format(stage3Result.npc) : "—";
    for (const count of stage3Counts) {
      const value = stage3Result?.matching[count.dataset.s3Count];
      count.textContent = Number.isInteger(value) ? number.format(value) : "—";
    }
    stage3Status.hidden = !stage3States[state];
    stage3Status.textContent = run?.source === "live" && state === "loading"
      ? (inEnglish ? "Loading the saved Stage 3 result…" : "讀取第 3 階段結果…")
      : stage3States[state]?.[inEnglish ? 1 : 0] ?? "";
    stage3Retry.hidden = state !== "error";
    stage3HistoryPanel.querySelector(".s3-figure").hidden = state !== "ready";
    stage3HistoryPanel.querySelector(".ml-result-dock").hidden = state !== "ready";

    stage3Plot.toggleAttribute("hidden", !pca?.points.length);
    if (pca?.points.length) {
      const points = pca.points;
      drawStage3Scatter(stage3HistoryPanel, points, stage3Ticks(points, 0), stage3Ticks(points, 1), inEnglish);
      const variance = new Intl.NumberFormat(locale, {maximumFractionDigits: 2});
      const axisNames = inEnglish ? ["PC1", "PC2"] : ["第 1 主成分", "第 2 主成分"];
      stage3Plot.querySelectorAll(".s3-axis-title").forEach((axis, index) => {
        axis.textContent = `${axisNames[index]} · ${variance.format(pca.variance_explained[index])}%`;
      });
      stage3Plot.setAttribute("aria-label", inEnglish
        ? `Scatter plot of ${number.format(points.length)} retained individuals on PC1 and PC2`
        : `${number.format(points.length)} 位保留個體在第 1 與第 2 主成分上的散點圖`);
      stage3Legend.textContent = pca.source === "signet_smartpca"
        ? (inEnglish ? "Each point is one retained individual. Coordinates and explained variance come from this run’s SIGNET PCA outputs."
          : "每個點代表一位保留個體。座標與解釋變異比例來自這筆執行的主成分分析輸出。")
        : (inEnglish ? "Each point is one retained individual. The plot is reconstructed from the archived genotype data."
          : "每個點代表一位保留個體。散點圖由封存的基因型資料重建。" );
    } else {
      stage3Plot.querySelector(".s3-points").replaceChildren();
      stage3Legend.textContent = inEnglish ? "This archive has no data for the PCA plot." : "這份封存結果沒有可繪製主成分圖的資料。";
    }

    stage3ComparisonRows.replaceChildren();
    stage3MetricNote.hidden = !comparison;
    if (!comparison) {
      const cell = stage3ComparisonRows.insertRow().insertCell();
      cell.colSpan = 3;
      cell.textContent = inEnglish ? "Expression comparison is unavailable in this archive." : "這份封存結果沒有校正前後的比較資料。";
      return;
    }
    for (const [key, zh, en, field] of stage3Comparison) {
      const row = stage3ComparisonRows.insertRow();
      row.dataset.s3Comparison = key;
      const value = comparison[field];
      row.insertCell().textContent = inEnglish ? en : zh;
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
    "restrict.tcga.geno": ["染色體", "Chromosome"],
    "restrict.tcga": ["染色體", "Chromosome"],
    mind: ["樣本缺失率上限", "Max. sample missingness"],
    geno: ["位點缺失率上限", "Max. variant missingness"],
    hwe: ["哈溫平衡檢定門檻", "HWE p-value cutoff"],
    int: ["插補分塊長度（鹼基對）", "Imputation block size (bp)"],
    "alpha.cis": ["顯著性門檻", "Significance cutoff"],
    nperms: ["低頻及罕見區域置換", "Permutations (low/rare)"],
    upstream: ["基因終點後的範圍（鹼基對）", "After gene end (base pairs)"],
    downstream: ["基因起點前的範圍（鹼基對）", "Before gene start (base pairs)"],
    nboots: ["重抽樣次數", "Bootstrap runs"],
    ncis: ["ncis（原流程設定）", "ncis (recorded setting)"],
    cor: ["工具變異相關性上限", "Instrument correlation limit"],
    ncores: ["每個計算工作核心數", "Compute job cores"],
    memory: ["每個計算工作記憶體（GB）", "Compute job memory (GB)"],
    walltime: ["每個計算工作時間上限", "Compute job time limit"],
  };
  const savedStepStates = {
    loading: ["讀取階段封存結果…", "Loading the archived stage result…"],
    empty: ["這次執行沒有可讀取的階段封存結果。", "This run has no readable result for this stage."],
    error: ["無法載入階段封存結果。", "Could not load the archived stage result."],
  };
  const cisCategories = {
    common: ["常見變異", "Common variants"],
    low: ["低頻區域", "Low-frequency regions"],
    rare: ["罕見區域", "Rare-variant regions"],
  };
  let archivedStepResult = null;
  let archivedStepRequest;

  function viewArchivedStep(stage, summary, language) {
    const snapshot = snapshots.find(({number}) => number === stage);
    const local = (zh, en) => [zh, en][language];
    const label = (zh) => language ? englishLabel(zh) : zh;
    const count = (value) => countLabel.format(value);
    const percent = (value) => `${Number((value * 100).toFixed(6))}%`;
    const view = {
      title: label(snapshot.chartTitle), axis: label(snapshot.axis),
      tableTitle: label(snapshot.tableTitle), headers: snapshot.headers.map(label),
      step: snapshot.step,
    };
    if (stage === 1) {
      const total = summary.genotype_codes.reduce((sum, value) => sum + value, 0);
      view.metrics = [[local("樣本數", "Samples"), summary.samples], [local("變異數", "Variants"), summary.variants]];
      view.bars = snapshot.bars.map(([range], index) => [range, summary.nonzero_bins[index]]);
      view.rows = summary.genotype_codes.map((entries, index) =>
        [index, count(entries), total ? `${(entries / total * 100).toFixed(2)}%` : "—"]);
      view.caption = local("各區間含下限，最後一組也含 100%。",
        "Each bin includes its lower bound. The last also includes 100%.");
    } else if (stage === 2) {
      view.metrics = [[local("樣本數", "Samples"), summary.samples], [local("基因數", "Genes"), summary.genes]];
      view.bars = summary.histogram.map(({lower, upper, count: entries}) => [`${lower}–${upper}`, entries]);
      view.rows = summary.gene_summary.map(({gene, min, median, max}) =>
        [gene, min.toFixed(2), median.toFixed(2), max.toFixed(2)]);
      view.caption = local("各區間含下限，最後一組也含上限。", "Each bin includes its lower bound. The last also includes its upper bound.");
    } else if (stage === 4) {
      const total = summary.counts.common + summary.counts.low + summary.counts.rare;
      view.metrics = [[local("顯著配對數", "Significant pairs"), total], [local("涉及基因數", "Genes represented"), summary.genes]];
      view.bars = Object.entries(cisCategories).map(([key, names]) => [names[language], summary.counts[key]]);
      view.headers[1] = local("類別內的變異／區域編號", "Variant / region index in category");
      view.rows = summary.pairs.map(({gene, variant, category, p_value}) =>
        [gene, variant, cisCategories[category][language], p_value]);
      view.caption = local("低頻與罕見變異依區域合併分析。", "Low-frequency and rare variants are grouped by region.");
    } else {
      const total = summary.frequencies.reduce((sum, {count: edges}) => sum + edges, 0);
      view.title = local("候選連線的重抽樣出現頻率", "Bootstrap frequency of candidate edges");
      view.metrics = [[local("候選連線數", "Candidate edges"), total], [local("分析基因數", "Genes analyzed"), summary.genes]];
      view.bars = summary.frequencies.map(({frequency, count: edges}) => [percent(frequency), edges]);
      view.rows = summary.edges.map(({source, target, frequency}) => [source, target, percent(frequency)]);
      view.caption = local("顯示至少出現一次的候選連線。第 6 階段會依出現頻率篩選。",
        "Candidate edges appeared in at least one bootstrap run. Stage 6 filters them by frequency.");
      if (!summary.edges.length) view.emptyText = local("這次執行沒有出現候選連線。", "This run produced no candidate edges.");
    }

    // Fit small and large archived results within the existing chart frame.
    const maximum = view.bars.reduce((largest, [, value]) => Math.max(largest, value), 0);
    if (maximum && (maximum < view.step || maximum > 10 * view.step)) {
      view.step = Math.ceil(maximum / 5);
    }
    return view;
  }

  function renderArchivedStep() {
    const language = root.lang === "en" ? 1 : 0;
    const local = (zh, en) => [zh, en][language];
    const recorded = (value) => value ?? local("未記錄", "Not recorded");
    const stage = historyResult?.stage;
    const run = archiveSteps.has(stage)
      ? selectedHistoryResult() : null;
    const view = run && archivedStepResult ? viewArchivedStep(stage, archivedStepResult.summary, language) : null;
    if (view && stage === 4 && run.source === "live") {
      view.tableTitle = local("顯著基因與變異關聯", "Significant gene–variant associations");
    }
    if (view && stage === 5 && run.source === "live") {
      view.tableTitle = local("候選連線與出現頻率", "Candidate edges and frequencies");
    }
    const state = archivedStepPanel.dataset.runState;
    const name = run ? stageData[stage - 1].name : "";
    const job = run ? archivedStepResult?.job ?? run.jobs[historySteps[stage - 1]] : null;
    const definition = (label, value, identity = "") =>
      `<dt>${escapeHistory(label)}</dt><dd${identity}>${escapeHistory(recorded(value))}</dd>`;

    archivedStepPanel.querySelector("h2").textContent = language ? englishLabel(name) : name;
    const liveIncomplete = state === "empty" && run?.source === "live" && job?.state !== "completed";
    archivedStepStatus.textContent = liveIncomplete
      ? genotypeHistoryState(job?.state)[language] : savedStepStates[state]?.[language] ?? "";
    archivedStepStatus.hidden = !savedStepStates[state];
    archivedStepRetry.hidden = state !== "error";
    archivedStepChart.hidden = !view || !view.bars.length;
    archivedStepDock.hidden = !view;
    archivedStepMetrics.innerHTML = run ? [
      [local("階段", "Stage"), local(`第 ${stage} 階段`, `Stage ${stage}`)],
      [run.source === "live" ? local("執行", "Run") : local("封存執行", "Archived run"), run.name[language]],
      ...(run.source === "live" ? [[local("狀態", "Status"), genotypeHistoryState(job?.state)[language]]] : []),
      ...(view?.metrics.map(([label, value]) => [label, countLabel.format(value)]) ?? []),
    ].map(([label, value]) => definition(label, value)).join("") : "";

    const resources = [
      ["cpus", stage === 5 ? local("監控工作核心數", "Controller job cores") : local("排程工作核心數", "Scheduled job cores")],
      ["mem_gb", stage === 5 ? local("監控工作記憶體（GB）", "Controller job memory (GB)") : local("排程工作記憶體（GB）", "Scheduled job memory (GB)")],
      ["time", stage === 5 ? local("監控工作時間上限", "Controller job time limit") : local("排程工作時間上限", "Scheduled job time limit")],
    ];
    const settings = Object.entries({...job?.settings, ...job?.options});
    archivedStepSettings.innerHTML = job ? [
      definition(local("工作編號", "Job ID"), job.job_id),
      ...settings.map(([key, value]) => definition(savedSettingLabels[key]?.[language] ?? key,
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
    archivedStepPlot.innerHTML = view.bars.length ? countChart(view.bars, view.step, view.axis, view.title) : "";
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
    if (!archiveSteps.has(stage) || !run || !canReadStage(run, stage)) return;
    const request = new AbortController();
    archivedStepRequest = request;
    archivedStepResult = null;
    delete archivedStepPanel.dataset.runId;
    archivedStepPanel.dataset.stage = stage;
    archivedStepPanel.dataset.runState = "loading";
    renderArchivedStep();
    try {
      const params = new URLSearchParams({run: runId, stage});
      params.set("source", run.source);
      const result = await getArchivedResult("/stage/results?" + params, {signal: request.signal});
      if (request.signal.aborted) return;
      if (result.run_id !== runId || result.stage !== stage) throw new Error("Result does not match the selected run and stage");
      archivedStepResult = result;
      archivedStepPanel.dataset.runId = runId;
      archivedStepPanel.dataset.historyId = historyId;
      archivedStepPanel.dataset.runState = "ready";
    } catch (error) {
      if (request.signal.aborted) return;
      archivedStepPanel.dataset.runState = error.status === 404 ? "empty" : "error";
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
    if (historyResult?.stage !== 3 || !run || !canReadStage(run, 3)) return;
    const request = new AbortController();
    stage3Request = request;
    stage3Result = null;
    delete stage3HistoryPanel.dataset.runId;
    stage3HistoryPanel.dataset.runState = "loading";
    renderStage3History();
    try {
      const params = new URLSearchParams({run: runId});
      params.set("source", run.source);
      const result = await getArchivedResult("/stage3/results?" + params, {signal: request.signal});
      if (request.signal.aborted) return;
      if (result.run_id !== runId) throw new Error("Stage 3 result belongs to a different run");
      stage3Result = result;
      stage3HistoryPanel.dataset.runId = runId;
      stage3HistoryPanel.dataset.historyId = historyId;
      stage3HistoryPanel.dataset.runState = "ready";
    } catch (error) {
      if (request.signal.aborted) return;
      stage3HistoryPanel.dataset.runState = error.status === 404 ? "empty" : "error";
    }
    renderStage3History();
  }
  stage3Retry.addEventListener("click", () => void loadStage3Run());

  const newChatTitle = ["新對話", "New chat"];
  const idleChatStatus = ["SIGNET Agent · 本機服務已啟動", "SIGNET Agent · Local service ready"];
  const chatRecords = [];
  const chatLabels = new Map();
  let activeChat, chatBusy = false;

  function renderChatLanguage() {
    for (const [node, labels] of chatLabels) node.textContent = labels[root.lang === "en" ? 1 : 0];
  }

  function chatLabel(node, label) {
    if (Array.isArray(label)) {
      chatLabels.set(node, label);
      node.textContent = label[root.lang === "en" ? 1 : 0];
    } else {
      chatLabels.delete(node);
      node.textContent = label;
    }
  }

  function createMessage(className, text) {
    const message = document.createElement("p");
    message.className = className;
    if (Array.isArray(text)) chatLabel(message, text);
    else message.textContent = text;
    return message;
  }

  function appendChatEvent(record, title, result, state) {
    const event = document.createElement("details");
    event.className = "ml-chat-event";
    event.open = !record.events.childElementCount;
    event.innerHTML = `<summary><i data-lucide="terminal" aria-hidden="true"></i><strong></strong>
      <span class="ml-chat-event-state"></span><i class="ml-chat-event-arrow" data-lucide="chevron-down" aria-hidden="true"></i></summary><p></p>`;
    chatLabel(event.querySelector("strong"), title);
    const status = event.querySelector(".ml-chat-event-state");
    const log = event.querySelector("p");
    chatLabel(status, state);
    log.textContent = result;
    record.emptyEvents.hidden = true;
    record.events.append(event);
    return {event, status, log};
  }

  const chatDrawers = ["chat-list", "chat-activity"];
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
    chatLabel(byId("chat-title"), record.title);
    chatLabel(byId("chat-status"), idleChatStatus);
    input.value = record.draft;
    showChatDrawer(null);
    if (record.transcript.lastElementChild) {
      byId("thread").scrollTop = byId("thread").scrollHeight;
    }
  }

  function createChat(saved) {
    const title = saved?.title ?? newChatTitle;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ml-nav-list-item";
    button.innerHTML = '<i data-lucide="message-square" aria-hidden="true"></i><span><strong></strong><small></small></span>';
    chatLabel(button.querySelector("strong"), title);
    chatLabel(button.querySelector("small"), ["已存對話", "Saved conversation"]);
    button.hidden = !saved;
    const transcript = document.createElement("div");
    transcript.id = `ml-chat-record-${chatRecords.length + 1}`;
    button.setAttribute("aria-controls", transcript.id);
    const activity = document.createElement("div");
    const emptyEvents = createMessage("ml-saved-reply", ["目前沒有執行活動。", "No activity yet."]);
    const eventList = document.createElement("div");
    eventList.className = "ml-chat-event-list";
    activity.append(emptyEvents, eventList);
    const record = {session: saved?.session ?? crypto.randomUUID(), loaded: !saved, title, button, transcript,
      activity, events: eventList, emptyEvents, draft: ""};
    chatRecords.push(record);
    button.addEventListener("click", () => void selectSavedChat(record));
    byId("chat-records").append(button);
    byId("chat-transcripts").append(transcript);
    byId("chat-events").append(activity);
    return record;
  }

  function setChatBusy(busy) {
    chatBusy = busy;
    byId("send").disabled = byId("new").disabled = busy;
    for (const {button} of chatRecords) button.disabled = busy;
  }

  function createAgentReply(record) {
    const reply = document.createElement("div");
    reply.className = "ml-saved-reply ml-live-reply";
    record.transcript.append(reply);
    return reply;
  }

  function renderAgentAnswer(reply, text) {
    chatLabels.delete(reply);
    reply.innerHTML = renderMarkdown(text);
  }

  async function readChatError(response) {
    const {error} = await response.json().catch(() => ({}));
    return error ?? (root.lang === "en" ? "The local service rejected the request." : "本機服務拒絕請求。");
  }

  function loadChat(record, saved) {
    for (const {role, text} of saved.messages ?? []) {
      if (role === "user") record.transcript.append(createMessage("ml-message", text));
      else renderAgentAnswer(createAgentReply(record), text);
    }
    for (const events of saved.events ?? []) {
      appendChatEvent(record, ["已存執行紀錄", "Saved activity"], events.join("\n"), ["已結束", "Ended"]);
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
      chatLabel(byId("chat-status"), error.message);
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

  // Bind generated and static UI before any user messages are added.
  const translations = [];
  function bindTranslation(source, write, englishOverride, chineseOverride) {
    const label = source.trim();
    if (!label) return;
    const english = englishOverride ?? englishLabel(label);
    const chinese = chineseOverride ?? toChinese.get(label) ?? label;
    if (english === chinese) return;
    translations.push((inEnglish) => write(source.replace(label, () => inEnglish ? english : chinese)));
  }

  const textNodes = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest("style, script, [data-live-language]")) continue;
    bindTranslation(node.data, (value) => { node.data = value; }, parent.dataset.enText, parent.dataset.zhText);
  }
  for (const attribute of ["aria-label", "data-tooltip", "placeholder"]) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      bindTranslation(
        element.getAttribute(attribute),
        (value) => element.setAttribute(attribute, value),
        element.getAttribute(`data-en-${attribute}`),
        element.getAttribute(`data-zh-${attribute}`),
      );
    }
  }

  const languageButton = byId("language");
  const modelChip = byId("model-chip");
  modelChip.textContent = modelChip.title = chatModel;
  byId("model-select").add(new Option(chatModel));

  const datasetSelect = byId("dataset-select");
  const datasetForm = byId("dataset-form");
  const datasetAdd = byId("dataset-add");
  const datasetName = byId("dataset-name");
  const datasetError = byId("dataset-error");
  const datasetCatalogNotice = byId("dataset-catalog-error");
  let creatingDataset = false;
  let datasetFormError = "";

  function renderDatasetLabels() {
    datasetSelect.replaceChildren(...datasets.map((dataset) => {
      const option = document.createElement("option");
      option.value = dataset.id;
      option.textContent = localDatasetName(dataset);
      return option;
    }));
    datasetSelect.value = activeDataset.id;
    datasetSelect.disabled = !datasetCatalogReady || !datasets.length;
    datasetAdd.disabled = creatingDataset;
    const label = localDatasetName(activeDataset) || (root.lang === "en" ? "Datasets" : "資料組");
    byId("history-dataset-name").textContent = historyScope === "current" ? label
      : historyScope === "unclassified" ? (root.lang === "en" ? "Unclassified runs" : "未分類的執行") : (root.lang === "en" ? "All runs" : "全部執行");
    byId("history-scope-note").textContent = historyScope === "current" ? (root.lang === "en" ? "Selected dataset" : "目前資料組")
      : (root.lang === "en" ? "All recorded sources" : "所有已保存的來源");
    byId("stage-dataset-title").textContent = label;
    datasetError.textContent = datasetFormError || (root.lang === "en" ? "Enter a dataset name." : "請輸入資料組名稱。");
    datasetCatalogNotice.textContent = datasetCatalogError;
    datasetCatalogNotice.hidden = !datasetCatalogError;
  }

  function setLanguage(lang) {
    root.lang = lang;
    const inEnglish = lang === "en";
    for (const translate of translations) translate(inEnglish);
    renderChatLanguage();
    analysisNetwork.dispatchEvent(new Event("lens:language-changed"));
    renderHistoryLanguage();
    renderHistoryStatus();
    renderStage6Status();
    renderStage3History();
    renderArchivedStep();
    syncGenotypeContext();
    renderDatasetLabels();
    syncInputFiles();
    languageButton.textContent = inEnglish ? "中文" : "EN";
    languageButton.lang = inEnglish ? "zh-Hant" : "en";
    languageButton.setAttribute("aria-label", inEnglish ? "切換為繁體中文" : "Switch to English");
  }
  languageButton.addEventListener("click", () => setLanguage(root.lang === "en" ? "zh-Hant" : "en"));
  setLanguage(root.lang);

  function setSidebarOpen(open) {
    byId("chat-panel").hidden = !open;
    app.toggleAttribute("data-chat-closed", !open);
  }

  const selectedRuns = new Map();
  const historySelectionKey = () => historyScope === "current" ? `dataset:${activeDataset.id}` : historyScope;
  function renderHistoryStatus() {
    const copy = historyState === "loading"
      ? ["讀取執行紀錄…", "Loading run history…", "", ""]
      : historyState === "error"
        ? ["無法讀取執行紀錄", "Could not load run history", "", ""]
        : historyScope === "current" ? ["尚無執行紀錄", "No runs yet", "這裡會顯示目前資料組的執行紀錄。", "Runs for the selected dataset will appear here."]
          : historyScope === "unclassified" ? ["尚無未分類紀錄", "No unclassified runs", "未記錄資料組歸屬的執行會顯示在這裡。", "Runs without recorded dataset ownership will appear here."]
            : ["尚無執行紀錄", "No runs yet", "所有已保存的執行會顯示在這裡。", "All saved runs will appear here."];
    const language = root.lang === "en" ? 1 : 0;
    byId("empty-run-list").textContent = byId("empty-history-title").textContent = copy[language];
    byId("empty-history-note").textContent = copy[language + 2];
    byId("history-retry").hidden = historyState !== "error";
  }

  function updateHistoryView() {
    const inHistory = app.dataset.nav === "history";
    const matchingRuns = matchingHistoryRuns();
    const previousSelection = selectedRuns.get(historySelectionKey());
    const selected = matchingRuns.find(run => historyKey(run) === previousSelection);
    const selectedId = selected ? historyKey(selected) : matchingRuns[0] && historyKey(matchingRuns[0]);
    const showResult = inHistory && Boolean(selectedId) && historyResult?.historyId === selectedId;
    const showNetwork = showResult && historyResult.stage === 6;
    const selectedRun = matchingRuns.find(run => historyKey(run) === selectedId);
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
    const genotypePanel = root.querySelector("#lens-stage1");
    genotypePanel.classList.toggle("ml-workspace", !showGenotype);
    genotypePanel.classList.toggle("ml-nav-workspace", showGenotype);
    genotypePanel.hidden = inHistory ? !showGenotype : timeline.querySelector('[aria-current="step"]').dataset.stage !== "1";
    const expressionPanel = root.querySelector("#lens-stage2");
    expressionPanel.classList.toggle("ml-workspace", !showExpression);
    expressionPanel.classList.toggle("ml-nav-workspace", showExpression);
    expressionPanel.hidden = inHistory ? !showExpression : timeline.querySelector('[aria-current="step"]').dataset.stage !== "2";
    const adjustmentPanel = root.querySelector("#lens-stage3");
    adjustmentPanel.classList.toggle("ml-workspace", !showAdjustment);
    adjustmentPanel.classList.toggle("ml-nav-workspace", showAdjustment);
    adjustmentPanel.hidden = inHistory ? !showAdjustment : timeline.querySelector('[aria-current="step"]').dataset.stage !== "3";
    const cisPanel = root.querySelector("#lens-stage4");
    cisPanel.classList.toggle("ml-workspace", !showCis);
    cisPanel.classList.toggle("ml-nav-workspace", showCis);
    cisPanel.hidden = inHistory ? !showCis : timeline.querySelector('[aria-current="step"]').dataset.stage !== "4";
    const networkPanel = root.querySelector("#lens-stage5");
    networkPanel.classList.toggle("ml-workspace", !showNetworkRun);
    networkPanel.classList.toggle("ml-nav-workspace", showNetworkRun);
    networkPanel.hidden = inHistory ? !showNetworkRun : timeline.querySelector('[aria-current="step"]').dataset.stage !== "5";
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
    analysisNetwork.hidden = inHistory ? !showNetwork : timeline.querySelector('[aria-current="step"]').dataset.stage !== "6";
    renderHistoryStatus();
    syncGenotypeContext();
    syncHistoryLogs();
  }

  function updateAnalysisView() {
    const isExample = activeDataset.id === exampleDataset.id;
    const hasSavedResults = activeDataset.persisted || isExample || runsForDataset().length > 0;
    app.toggleAttribute("data-no-analysis", !hasSavedResults && historyState === "ready");
    byId("empty-analysis").hidden = hasSavedResults || historyState !== "ready" || !["analysis", "settings"].includes(app.dataset.nav);
    timeline.hidden = !hasSavedResults;
    byId("stage-header").querySelector("span").hidden = !hasSavedResults;
    byId("empty-stage").hidden = hasSavedResults || historyState !== "ready";
    // Manual stages and saved network results share the existing stage workspace.
    const activeStage = timeline.querySelector('[aria-current="step"]').dataset.stage;
    if (!["1", "2", "3", "4", "5", "6"].includes(activeStage)) {
      showStage(stageButtons[0], true);
    }
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
      if (!Array.isArray(savedDatasets)) throw new Error(root.lang === "en"
        ? "The dataset catalog is unavailable." : "資料組清單無法使用。");
      datasetCatalogReady = true;
      datasetCatalogError = "";
      // A catalog read started before a successful save must not replace the newer canonical response.
      if (catalogRevision === datasetRevision) {
        const catalog = savedDatasets.map(makeDataset);
        if (!catalog.some(({id}) => id === exampleDataset.id)) catalog.unshift(makeDataset(exampleDataset));
        datasets.splice(0, datasets.length, ...catalog);
        activeDataset = datasets.find(({id}) => id === activeDataset.id) ?? datasets[0];
      }
      historyRuns = [...runs].sort((a, b) => historyTime(b) - historyTime(a));
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
    syncInputFiles(true);
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
    runDetails.querySelector(`[data-run-stage="${stage}"][data-history-id="${CSS.escape(historyKey(run))}"]`)?.focus({preventScroll: true});
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

  function closeDatasetForm() {
    if (creatingDataset) return;
    datasetForm.hidden = true;
    datasetAdd.setAttribute("aria-expanded", "false");
    datasetForm.reset();
    datasetError.hidden = true;
    datasetFormError = "";
    datasetForm.dataset.saveState = "idle";
  }

  function selectDataset(dataset) {
    if (!dataset) return;
    closeDatasetForm();
    if (dataset.id !== activeDataset.id) {
      window.dispatchEvent(new Event("close-dataset-remote-files"));
      activeDataset = dataset;
      clearHistoryResult();
      if (!runsForDataset().length) showStage(stageButtons[0], true);
    }
    renderDatasetLabels();
    syncInputFiles(true);
    updateAnalysisView();
    updateHistoryView();
    syncStage6Picker(true);
  }

  datasetSelect.addEventListener("change", () => {
    selectDataset(datasets.find((dataset) => dataset.id === datasetSelect.value));
  });
  datasetAdd.addEventListener("click", () => {
    if (!datasetForm.hidden) {
      closeDatasetForm();
      return;
    }
    datasetForm.hidden = false;
    datasetAdd.setAttribute("aria-expanded", "true");
    datasetName.focus();
  });
  byId("dataset-cancel").addEventListener("click", () => {
    closeDatasetForm();
    datasetAdd.focus();
  });
  async function createDataset() {
    if (creatingDataset) return;
    const name = datasetName.value.trim();
    if (!name) {
      datasetFormError = "";
      renderDatasetLabels();
      datasetError.hidden = false;
      datasetForm.dataset.saveState = "error";
      datasetName.focus();
      return;
    }
    const previousDatasetId = activeDataset.id;
    creatingDataset = true;
    datasetForm.dataset.saveState = "saving";
    datasetError.hidden = true;
    datasetForm.querySelectorAll("input, button").forEach(control => { control.disabled = true; });
    datasetAdd.disabled = true;
    try {
      const record = await requestDataset("/signet/datasets", {name: [name, name]}, "POST");
      const dataset = acceptSavedDataset(record);
      creatingDataset = false;
      if (activeDataset.id === previousDatasetId) {
        selectDataset(dataset);
        datasetSelect.focus();
      } else {
        closeDatasetForm();
        renderDatasetLabels();
      }
      datasetForm.dataset.saveState = "saved";
    } catch (error) {
      datasetFormError = error.message;
      renderDatasetLabels();
      datasetError.hidden = false;
      datasetForm.dataset.saveState = "error";
    } finally {
      creatingDataset = false;
      datasetForm.querySelectorAll("input, button").forEach(control => { control.disabled = false; });
      datasetAdd.disabled = false;
    }
  }
  byId("dataset-create").addEventListener("click", () => void createDataset());
  datasetForm.addEventListener("submit", event => { event.preventDefault(); void createDataset(); });
  datasetName.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void createDataset();
  });

  const navigation = root.querySelectorAll("[data-nav-target]");
  function openNavigation(view) {
    if (view !== "data") window.dispatchEvent(new Event("close-dataset-remote-files"));
    app.dataset.nav = view;
    const analysis = view === "analysis";
    root.querySelector(".ml-segment").hidden = !analysis;
    for (const tab of tabs) {
      root.querySelector("#" + tab.getAttribute("aria-controls")).hidden = !analysis || tab.getAttribute("aria-selected") !== "true";
    }
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
  }
  for (const button of navigation) {
    button.addEventListener("click", () => openNavigation(button.dataset.navTarget));
  }
  const inputChoices = root.querySelectorAll("[data-input-target]");
  for (const button of inputChoices) {
    button.addEventListener("click", () => {
      window.dispatchEvent(new Event("close-dataset-remote-files"));
      for (const choice of inputChoices) {
        const selected = choice === button;
        choice.setAttribute("aria-pressed", String(selected));
        root.querySelector("#" + choice.getAttribute("aria-controls")).hidden = !selected;
      }
    });
  }
  byId("history-scope").addEventListener("change", event => {
    historyScope = ["current", "unclassified", "all"].includes(event.target.value) ? event.target.value : "current";
    clearHistoryResult();renderDatasetLabels();updateHistoryView();syncStage6Picker(true);
  });
  runList.addEventListener("click", event => {
    const id = event.target.closest("[data-run-target]")?.dataset.runTarget;
    if (!matchingHistoryRuns().some(run => historyKey(run) === id)) return;
    selectedRuns.set(historySelectionKey(), id);
    clearHistoryResult();updateHistoryView();syncStage6Picker(true);
  });
  runDetails.addEventListener("change", event => {
    const select = event.target.closest("[data-history-dataset]");
    const id = select?.closest("[data-history-assignment]")?.dataset.historyAssignment;
    if (id) {
      assignmentStates.set(id, {...assignmentStates.get(id), datasetId: select.value, error: "", saved: false});
      const form = select.closest("[data-history-assignment]");
      form.dataset.saveState = "idle";
      form.querySelector("[data-history-assignment-status]").textContent = root.lang === "en"
        ? "Assignment not yet saved; sample matching is not verified." : "歸類尚未保存；尚未確認樣本配對。";
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
    const state = {...prior, pending: true};submissionReviews.set(key, state);renderHistoryRecords();
    try {
      const result = await requestDataset(`/signet/runs/${encodeURIComponent(run.run_id)}/steps/${encodeURIComponent(step)}/reconcile`,
        {expected_attempt: attempt, expected_job_id: jobId, action, confirmed: action !== "review"}, "POST");
      if (scope !== recoveryRemote || submissionReviews.get(key) !== state || result.record?.run_id !== run.run_id ||
          result.record?.step !== step || (result.record?.attempt ?? 1) !== attempt) return;
      state.result = result;state.error = null;
      if (action !== "review" && !result.applied) {
        state.result = null;state.error = historyText("證據已變更或尚未完成審閱，請重新核對。", "Evidence changed or review is incomplete. Review the evidence again.");
      }
      if (result.applied) {submissionReviews.delete(key);await loadWorkspaceHistory();}
    } catch (error) {state.error = error.message;}
    finally {state.pending = false;renderHistoryRecords();}
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
      assignmentStates.set(id, {datasetId, error: root.lang === "en" ? "Choose an existing dataset." : "請選擇現有資料組。"});
      renderHistoryRecords();updateHistoryView();return;
    }
    assignmentStates.set(id, {datasetId, saving: true});renderHistoryRecords();updateHistoryView();
    try {
      const saved = await requestDataset(`/signet/history/${encodeURIComponent(id)}/dataset`, {dataset_id: datasetId, revision: run.revision}, "PATCH");
      if (historyKey(saved) !== id || saved.run_id !== run.run_id || saved.dataset_id !== datasetId) throw new Error(root.lang === "en" ? "The saved assignment does not match this record." : "保存的歸類與這筆紀錄不符。");
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
        content.innerHTML = `<p>${historyText("沿用上游", "Reuse upstream")}: ${escapeHistory(review.reuse.join(", ") || "—")}<br>${historyText("必須重新執行", "Recompute")}: ${escapeHistory(review.invalidated.join(", "))}</p>
          <p>${historyText("舊結果保留。建立後仍須另外確認送出；送出時核對遠端檔案。原始輸入固定，可編輯設定、資源及選項。", "Old results are preserved. Submission requires a separate confirmation and remote file checks. Keep original inputs; edit settings, resources and options.")}</p>
          <form data-rerun-editor aria-label="${historyText("關聯執行參數", "Linked run parameters")}"><label>${historyText("新執行名稱", "New run name")}<input name="run-name" data-rerun-name required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" spellcheck="false" value="${escapeHistory(source.slice(0, 58))}-rerun"></label>
          <label>${historyText("執行參數", "Run parameters")}<textarea name="parameters" spellcheck="false" data-rerun-parameters rows="12" style="width:100%;box-sizing:border-box">${escapeHistory(JSON.stringify(review.parameters, null, 2))}</textarea></label>
          <button type="button" data-rerun-create>${historyText("建立關聯執行（尚不送出）", "Create linked run (no submission)")}</button></form>`;
      } else if (button.hasAttribute("data-rerun-create")) {
        if (!content.querySelector("[data-rerun-editor]").reportValidity()) return;
        const review = container.rerunReview;
        const plan = await requestDataset(`/signet/runs/${encodeURIComponent(review.source_run_id)}/steps/${review.step}/rerun`, {
          new_run_id: content.querySelector("[data-rerun-name]").value,
          revision: review.revision, parameters: JSON.parse(content.querySelector("[data-rerun-parameters]").value),
        }, "POST");
        container.rerunPlan = plan;
        content.querySelectorAll("input, textarea, button").forEach(control => {control.disabled = true;});
        const confirm = document.createElement("button");
        confirm.type = "button";confirm.dataset.rerunSubmit = "";
        confirm.textContent = root.lang === "en" ? `Confirm submission: ${plan.new_run_id}` : `確認送出：${plan.new_run_id}`;
        content.append(confirm);
        status.textContent = root.lang === "en" ? "Linked run created locally; nothing submitted." : "已建立本機關聯執行，尚未送出。";
      } else {
        await requestDataset(`/signet/runs/${encodeURIComponent(button.dataset.rerunRunId ?? container.rerunPlan.new_run_id)}/rerun/submit`, {confirmed: true}, "POST");
        button.dataset.rerunSubmitted = "true";
        status.textContent = root.lang === "en" ? "Submission recorded. Reload history to inspect the new run." : "已記錄送出，請重新讀取歷史查看新執行。";
        return;
      }
    } catch (error) { status.textContent = error.message; }
    finally { if (!button.dataset.rerunSubmitted && (!button.hasAttribute("data-rerun-create") || !container.rerunPlan)) button.disabled = false; }
  });
  runDetails.addEventListener("click", event => {
    const button = event.target.closest("[data-run-stage]");
    if (!button) return;
    const stage = Number(button.dataset.runStage), historyId = button.dataset.historyId;
    const run = matchingHistoryRuns().find(run => historyKey(run) === historyId);
    const savedJob = run?.jobs?.[historySteps[stage - 1]];
    if (!run || !(canReadStage(run, stage) || stage === 6 && canReadGraph(run) || canContinue(run) &&
      (Boolean(savedJob) && savedJob.state !== "not_submitted" &&
        (stage > 1 || savedJob.state !== "completed") || stage > 1 && canStartStage(run, stage)))) return;
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
  function backToRunTimeline() {
    if (!historyResult) return;
    const {historyId, stage} = historyResult;
    clearHistoryResult();
    updateHistoryView();
    syncStage6Picker();
    runDetails.querySelector(`[data-run-stage="${stage}"][data-history-id="${CSS.escape(historyId)}"]`)?.focus({ preventScroll: true });
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

  async function sendMessage() {
    const text = input.value.trim();
    if (chatBusy || !text) return;
    const record = activeChat;
    const status = byId("chat-status");
    const needsReview = ["需要確認", "Needs review"];
    const ended = ["已結束", "Ended"];
    const turn = appendChatEvent(record, ["對話回合", "Conversation turn"], "", ["執行中", "Running"]);
    turn.event.open = true;

    setChatBusy(true);
    chatLabel(status, ["等待 SIGNET Agent 回覆…", "Waiting for SIGNET Agent…"]);
    record.transcript.append(createMessage("ml-message", text));
    const reply = createAgentReply(record);
    chatLabel(reply, ["處理中…進度可在「執行活動」查看。", "Working… Follow along in Activity."]);
    input.value = "";
    showChatDrawer(null);
    globalThis.lucide?.createIcons();
    reply.scrollIntoView({ block: "nearest" });

    let done = false, failed = false, answered = false;
    function consume(line) {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (["progress", "error", "done"].includes(event.type)) {
        turn.log.textContent += (turn.log.textContent ? "\n" : "") + event.text;
      }
      if (event.type === "answer") {
        renderAgentAnswer(reply, event.text);
        answered = true;
      }
      if (event.type === "error") {
        chatLabel(reply, event.text);
        failed = true;
      }
      if (event.type === "done") done = true;
    }

    try {
      const response = await fetch("/chat", {
        method: "POST",
        headers: {"Content-Type": "application/json", "X-Chat-Token": chatToken},
        body: JSON.stringify({text, session: record.session, language: root.lang}),
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
      if (record.button.hidden) {
        record.title = Array.from(text.replace(/\s+/g, " ")).slice(0, 80).join("");
        chatLabel(record.button.querySelector("strong"), record.title);
        chatLabel(byId("chat-title"), record.title);
        record.button.hidden = false;
        byId("chat-records").prepend(record.button);
        byId("empty-chats").hidden = true;
      }
      chatLabel(status, failed ? needsReview : ["回合結束", "Turn ended"]);
      chatLabel(turn.status, failed ? needsReview : ended);
    } catch (error) {
      const lostConnection = ["連線中斷。已啟動的工具可能仍在執行，請先核對工作狀態。",
        "Connection interrupted. Check any active jobs before retrying."];
      const detail = error instanceof TypeError || error instanceof SyntaxError ? lostConnection : error.message;
      if (answered || failed) reply.after(createMessage("ml-saved-reply", detail));
      else chatLabel(reply, detail);
      turn.log.textContent += (turn.log.textContent ? "\n" : "") + (Array.isArray(detail) ? detail[root.lang === "en" ? 1 : 0] : detail);
      chatLabel(status, needsReview);
      chatLabel(turn.status, needsReview);
    } finally {
      setChatBusy(false);
      if (!byId("chat-transcripts").hidden && !byId("agent-view").hidden && !byId("chat-panel").hidden) {
        input.focus({preventScroll: true});
        byId("thread").scrollTop = byId("thread").scrollHeight;
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
  updateAnalysisView();
  updateHistoryView();
  globalThis.lucide?.createIcons();
  void loadWorkspaceHistory();
})();
