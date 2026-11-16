(() => {
  const panel = document.getElementById("lens-stage3");
  const points = JSON.parse(panel.querySelector("[data-stage3-points]").textContent);
  const svg = (tag, attrs) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const bounds = { left: 68, right: 636, top: 18, bottom: 350 };
  const xFor = (value) => bounds.left + (value + 3) / 15 * (bounds.right - bounds.left);
  const yFor = (value) => bounds.bottom - (value + 6) / 12 * (bounds.bottom - bounds.top);
  const axes = panel.querySelector(".s3-axes");
  const gridLine = (value, attrs) => svg("line", {
    ...attrs,
    class: value === 0 ? "s3-grid-line s3-zero" : "s3-grid-line",
  });

  for (const value of [-3, 0, 3, 6, 9, 12]) {
    const x = xFor(value);
    const tick = svg("text", { x, y: bounds.bottom + 19, "text-anchor": "middle" });
    tick.textContent = value;
    axes.append(gridLine(value, { x1: x, x2: x, y1: bounds.top, y2: bounds.bottom }), tick);
  }
  for (const value of [-6, -3, 0, 3, 6]) {
    const y = yFor(value);
    const tick = svg("text", { x: bounds.left - 9, y: y + 4, "text-anchor": "end" });
    tick.textContent = value;
    axes.append(gridLine(value, { x1: bounds.left, x2: bounds.right, y1: y, y2: y }), tick);
  }
  panel.querySelector(".s3-points").append(...points.map(([x, y]) => svg("circle", {
    cx: xFor(x).toFixed(2),
    cy: yFor(y).toFixed(2),
    r: 2.6,
    "data-tooltip": `第 1 主成分 ${x} · 第 2 主成分 ${y}`,
    "data-en-data-tooltip": `PC1: ${x} · PC2: ${y}`,
  })));
})();

(() => {
  const root = document.getElementById("signet-lens-left-preview");
  const app = root.querySelector(".ml-app");

  function fitApp(width) {
    if (width > 0) app.style.setProperty("--ml-fit", width / app.offsetWidth);
  }
  fitApp(root.getBoundingClientRect().width);
  new ResizeObserver(([entry]) => fitApp(entry.contentRect.width)).observe(root);
  const byId = (id) => root.querySelector("#ml-" + id);
  // File selections edit a dataset's draft; saved run inputs are execution-time snapshots.
  const savedRuns = JSON.parse(byId("saved-runs").textContent);
  const simulatedFiles = {
    genotype: [["cohort-b.ped", "cohort-b.map"], ["cohort-b-reviewed.ped", "cohort-b-reviewed.map"]],
    expression: [["cohort-b-expression.tsv"], ["cohort-b-expression-review.tsv"]],
    clinical: [["cohort-b-clinical.tsv"], ["cohort-b-clinical-review.tsv"]],
  };
  const datasets = [
    {
      id: "example-chr1",
      name: ["第 1 號染色體範例", "Chromosome 1 example"],
      folder: "/demo/signet/chr1",
      files: {
        genotype: [["study.ped", "study.map"], ["study-qc-preview.ped", "study-qc-preview.map"]],
        expression: [["example_gexp"], ["expression-review.tsv"]],
        clinical: [["official-demo-chr1-restart-clinical.tsv"], ["clinical-review.tsv"]],
      },
      selections: { genotype: 0, expression: 0, clinical: 0 },
    },
    {
      id: "simulated-cohort-b",
      name: ["模擬資料組 B", "Simulated dataset B"],
      folder: "/demo/signet/cohort-b",
      files: simulatedFiles,
      selections: { genotype: 0, expression: 0, clinical: 0 },
    },
  ];
  let activeDataset = datasets[0];
  const localDatasetName = (dataset) => dataset.name[root.lang === "en" ? 1 : 0];
  const runsForDataset = () => savedRuns.filter((run) => run.datasetId === activeDataset.id);
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

  const syncInputFiles = (() => {
    const picker = byId("file-picker");
    const template = byId("current-files-template");
    const radios = [...picker.querySelectorAll("input")];
    const optionPaths = [...picker.querySelectorAll("[data-picker-file]")];
    const applyButton = picker.querySelector("[data-input-apply]");
    const directory = picker.querySelector(".ml-input-picker-directory code");
    const inputs = [];
    let activeInput = null;

    function closePicker(restoreFocus = true) {
      if (!activeInput) return;
      const { replaceButton } = activeInput;
      picker.hidden = true;
      replaceButton.setAttribute("aria-expanded", "false");
      activeInput = null;
      if (restoreFocus) replaceButton.focus({ preventScroll: true });
    }

    function renderInput(input) {
      const selection = activeDataset.selections[input.type];
      const files = activeDataset.files[input.type][selection] ?? [];
      input.paths.replaceChildren(...files.map((file) => {
        const path = document.createElement("code");
        path.textContent = `${activeDataset.folder}/${file}`;
        return path;
      }));
      const none = root.lang === "en" ? "No files selected" : "尚未選擇檔案";
      if (!files.length) input.paths.textContent = none;
      input.caption.textContent = files.length ? files.join(" · ") : none;
      input.resetButton.disabled = selection === 0 || selection === undefined;
    }

    function setFileStatus(input, status) {
      for (const message of input.messages) {
        message.hidden = message.dataset.fileStatus !== status;
      }
    }

    function selectFiles(input, selection, status) {
      activeDataset.selections[input.type] = selection;
      renderInput(input);
      setFileStatus(input, status);
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
      input.replaceButton.setAttribute("aria-controls", picker.id);
      input.replaceButton.setAttribute("aria-expanded", "false");
      input.replaceButton.addEventListener("click", () => {
        if (activeInput === input) {
          closePicker();
          return;
        }
        closePicker(false);
        activeInput = input;
        const selection = activeDataset.selections[input.type];
        for (const [index, radio] of radios.entries()) {
          radio.checked = index === selection;
          optionPaths[index].textContent = activeDataset.files[input.type][index].join(" · ");
        }
        directory.textContent = activeDataset.folder;
        applyButton.disabled = selection === undefined;
        input.current.after(picker);
        picker.hidden = false;
        input.replaceButton.setAttribute("aria-expanded", "true");
        radios[selection ?? 0].focus({ preventScroll: true });
      });
      input.resetButton.addEventListener("click", () => {
        if (activeInput === input) closePicker();
        selectFiles(input, 0, "default");
        input.replaceButton.focus({ preventScroll: true });
      });
      row.addEventListener("click", () => closePicker(false));
    }

    picker.addEventListener("change", () => { applyButton.disabled = !radios.some((radio) => radio.checked); });
    applyButton.addEventListener("click", () => {
      const selection = radios.findIndex((radio) => radio.checked);
      if (!activeInput || selection === -1) return;
      selectFiles(activeInput, selection, "applied");
      closePicker();
    });
    picker.querySelector("[data-input-cancel]").addEventListener("click", () => closePicker());
    picker.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePicker();
    });
    for (const button of root.querySelectorAll("[data-nav-target], [data-open-stage]")) {
      button.addEventListener("click", () => closePicker(false));
    }
    return (datasetChanged = false) => {
      if (datasetChanged) closePicker(false);
      for (const input of inputs) {
        renderInput(input);
        if (datasetChanged) setFileStatus(input);
      }
    };
  })();

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
      name: "基因型準備", note: "篩選第 1 號染色體的基因型資料。",
      settings: "樣本及變異缺失率上限各 10%",
      output: "560 個樣本 × 2,983 個變異",
      icon: "grid-3x3",
      preview: matrixPreview(["05050000000000", "00050000000000", "00050000000000", "00000000000000"]),
    },
    {
      name: "基因表現量準備", note: "擷取第 1 號染色體上的基因表現量。",
      settings: "只保留第 1 號染色體",
      output: "554 個樣本 × 95 個基因",
      icon: "grid-3x3",
      preview: matrixPreview(["22433443320232", "23432432241223", "45224454353243", "12322342231244"]),
    },
    {
      name: "樣本配對與校正", note: "配對樣本，再用主成分校正基因表現量。",
      settings: "使用 3 個主成分",
      output: "初步配對 473 位個體，校正後保留 471 位",
      icon: "bar-chart-3",
      preview: barPreview([473, 471], ["#b7cfe2", "#4380b2"]),
    },
    {
      name: "近端表現量關聯分析", note: "找出與鄰近基因表現量相關的變異。",
      settings: "顯著門檻 0.05，上下游各 1,000 個鹼基對，置換 100 次",
      output: "常見 156 筆、低頻 35 筆、罕見 15 筆",
      icon: "bar-chart-3",
      preview: barPreview([156, 35, 15], ["#4380b2", "#85afcf", "#b7cfe2"]),
    },
    {
      name: "網路推論", note: "重抽樣推論基因間可能的調控方向。",
      settings: "重抽樣 2 次，相關性門檻 0.3",
      output: "394 條連線的出現頻率為 50%，337 條為 100%",
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
    ["開啟原型的分析結果", "Open results in analysis view"],
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
    ["設定", "Settings"],
    ["輸出", "Output"],
    ["資料", "Data"],
    ["第 1 號染色體 · 模擬結果", "Chromosome 1 · Simulated results"],
    ["第 1 號染色體 · 模擬結果節錄", "Chromosome 1 · Simulated results excerpt"],
    ["基因型準備", "Genotype preparation"],
    ["篩選第 1 號染色體的基因型資料。", "Filter genotypes on chromosome 1."],
    ["樣本及變異缺失率上限各 10%", "10% missingness limit for samples and variants"],
    ["560 個樣本 × 2,983 個變異", "560 samples × 2,983 variants"],
    ["基因表現量準備", "Gene expression preparation"],
    ["擷取第 1 號染色體上的基因表現量。", "Extract expression data for chromosome 1."],
    ["只保留第 1 號染色體", "Chromosome 1 only"],
    ["554 個樣本 × 95 個基因", "554 samples × 95 genes"],
    ["樣本配對與校正", "Sample matching and adjustment"],
    ["配對樣本，再用主成分校正基因表現量。", "Match samples, then adjust expression using PCs."],
    ["使用 3 個主成分", "Use 3 principal components"],
    ["初步配對 473 位個體，校正後保留 471 位", "473 matched · 471 retained after adjustment"],
    ["近端表現量關聯分析", "Cis-eQTL analysis"],
    ["找出與鄰近基因表現量相關的變異。", "Test variants for associations with nearby genes."],
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
  const countLabel = new Intl.NumberFormat("en-US");
  function countChart(bars, step, axis, title) {
    const maximum = step * (Math.floor(Math.max(...bars.map(([, value]) => value)) / step) + 1);
    const left = 74, right = 636, top = 50, bottom = 354;
    const columnWidth = (right - left) / bars.length;
    const barWidth = Math.min(128, columnWidth - 12);
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
        <text x="${x}" y="${bottom + 28}" text-anchor="middle">${label}</text>`;
    }).join("");
    const description = bars.map(([label, value]) => `${label} ${countLabel.format(value)}`).join("，");
    const englishDescription = bars.map(([label, value]) => `${englishLabel(label)} ${countLabel.format(value)}`).join(", ");
    return `<svg class="ml-count-chart" viewBox="0 0 660 410" role="img" aria-label="${title}。${axis}：${description}"
        data-en-aria-label="${englishLabel(title)}. ${englishLabel(axis)}: ${englishDescription}">
      <text x="${left}" y="23">${axis}</text>
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
      <p class="ml-stage-note"><span class="ml-stage-marker" aria-hidden="true"><i data-lucide="message-square-text"></i></span>${note}</p>
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
        <dt>設定</dt><dd>${settings}</dd>
        <dt>輸出</dt><dd>${output}</dd>
      </dl>
    </li>`;
  }).join("");
  const stageButtons = timeline.querySelectorAll(".ml-stage-button");
  const stageResults = root.querySelectorAll(".ml-workspace");
  function showStage(button, open) {
    for (const entry of stageButtons) {
      const expanded = entry === button && open;
      entry.setAttribute("aria-expanded", String(expanded));
      root.querySelector("#" + entry.getAttribute("aria-controls")).hidden = !expanded;
    }
    for (const panel of stageResults) panel.hidden = panel.id !== "lens-stage" + button.dataset.stage;
    timeline.querySelector('[aria-current="step"]').removeAttribute("aria-current");
    button.setAttribute("aria-current", "step");
  }
  for (const button of stageButtons) {
    button.addEventListener("click", () => {
      showStage(button, button.getAttribute("aria-expanded") === "false");
    });
  }

  const networkNodes = {
    ABCD3: [17, 33], HSD17B7: [35, 14], C1orf159: [15, 65], MEGF6: [36, 45],
    LRRC40: [54, 23], ATP1B1: [58, 67], RABGAP1L: [54, 90], CHD5: [64, 42],
    MYSM1: [72, 15], PGD: [82, 58], FRRS1: [86, 78], CYP4Z1: [18, 12],
    GBP2: [15, 86], KDM1A: [35, 78], LGALS8: [88, 31], DAP3: [75, 94]
  };

  function mountNetwork(stage, nodes, edges) {
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
    const reset = stage.querySelector(".s6-reset");
    const table = stage.querySelector(".ml-result-dock");
    const tableViewport = stage.querySelector(".ml-result-table");
    const rows = table.querySelector("tbody");
    const rowCount = table.querySelector(".s6-row-count");


    const positions = Object.fromEntries(Object.entries(nodes).map(([name, [x, y]]) =>
      [name, [16 + 5.9 * x, 18 + 2.91 * y]]));
    const graphMeta = stage.querySelector(".s6-graph-meta");
    const geneCount = Object.keys(nodes).length;
    graphMeta.textContent = `節錄 ${geneCount} 個基因 · ${edges.length} 條連線`;
    graphMeta.dataset.enText = `${geneCount} genes · ${edges.length} edges shown`;
    const svg = (tag, attributes) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    };

    const edgeElements = edges.map(([source, target]) => {
      const [x1, y1] = positions[source];
      const [x2, y2] = positions[target];
      const direction = Math.atan2(y2 - y1, x2 - x1);
      const reciprocal = edges.some(([a, b]) => a === target && b === source);
      const bend = reciprocal ? 18 : 0;
      const cx = (x1 + x2) / 2 - Math.sin(direction) * bend;
      const cy = (y1 + y2) / 2 + Math.cos(direction) * bend;
      const angle = Math.atan2(y2 - cy, x2 - cx);
      const endX = x2 - 10 * Math.cos(angle);
      const endY = y2 - 10 * Math.sin(angle);
      return svg("path", {
        class: "s6-edge",
        d: `M${x1} ${y1} Q${cx} ${cy} ${endX} ${endY}`,
        "data-source": source,
        "data-target": target
      });
    });
    edgeLayer.append(...edgeElements);

    const nodeElements = Object.entries(positions).map(([gene, [x, y]]) => {
      const node = svg("g", {
        class: "s6-gene",
        transform: `translate(${x} ${y})`,
        role: "button",
        tabindex: "0",
        "data-gene": gene,
        "aria-label": `查看 ${gene} 的調控關係`,
        "data-en-aria-label": `View connections for ${gene}`,
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
    nodeLayer.append(...nodeElements);

    const edgesFor = (gene) => gene ? edges.filter(([source, target]) => gene === source || gene === target) : edges;
    function updateReadout(gene, matched) {
      const inEnglish = stage.closest("[lang]").lang === "en";
      if (gene) {
        const incoming = matched.filter(([, target]) => target === gene).length;
        const outgoing = matched.length - incoming;
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

      const resultRows = matched.map(([source, target, frequency, coefficient]) => {
        const row = document.createElement("tr");
        const coefficientText = Number(coefficient.toFixed(5)).toString();
        for (const value of [source, target, frequency.toFixed(2), coefficientText]) {
          const cell = row.insertCell();
          cell.textContent = value;
          if (value === gene) cell.dataset.focused = "true";
        }
        return row;
      });
      rows.replaceChildren(...resultRows);
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
    render(null);
  }

  const edgesByRun = JSON.parse(byId("run-edges").textContent);
  const runNames = ["本原型使用的執行", "重跑 · 階段進度驗證", "重跑 · 英文展示"];
  const runList = byId("run-list");
  const runDetails = byId("run-details");
  const localNumber = (value) => countLabel.format(value);
  const networkOutput = ([genes, edges]) => [
    `${genes} 個基因 · ${edges} 條連線`,
    `${genes} genes · ${edges} edges`,
  ];
  function jobDetails(job, settings, output, englishOutput) {
    return `<dl class="ml-key-values">
      <dt>工作編號</dt><dd>${job.id}</dd>
      <dt>送出時間</dt><dd>${job.start}</dd>
      <dt>完成時間</dt><dd>${job.end}</dd>
      <dt>分配資源</dt><dd data-en-text="${job.cpu} cores · ${job.ram} GB">${job.cpu} 核心 · ${job.ram} GB</dd>
      <dt>設定</dt><dd>${settings}</dd>
      <dt>輸出</dt><dd data-en-text="${englishOutput}">${output}</dd>
    </dl>`;
  }
  const analysisNetwork = root.querySelector("#lens-stage6");
  const historyNetworks = savedRuns.map((run, index) => {
    const panel = analysisNetwork.cloneNode(true);
    panel.id = `ml-run-network-${index}`;
    panel.className = "ml-nav-workspace ml-history-network";
    panel.hidden = true;
    for (const style of panel.querySelectorAll("style")) style.remove();
    for (const element of panel.querySelectorAll("[id]")) element.id = panel.id + "-" + element.id;
    for (const element of [panel, ...panel.querySelectorAll("[aria-labelledby]")]) {
      element.setAttribute("aria-labelledby", panel.id + "-" + element.getAttribute("aria-labelledby"));
    }

    const [fullOutput, englishFullOutput] = networkOutput(run.network);
    const lastJob = run.jobs.at(-1);
    panel.querySelector(".ml-result-context").insertAdjacentHTML("beforeend",
      `<dt>執行</dt><dd>${runNames[index]}<br><time datetime="${run.date}T${lastJob.end}-08:00">${run.date} · ${lastJob.end}</time></dd>`);
    panel.querySelector(".ml-result-inspector").insertAdjacentHTML("beforeend", `
      <button type="button" class="ml-nav-action" data-run-back="${index}">回到執行時間線</button>
      <details class="s6-run-job"><summary>執行明細</summary>
        ${jobDetails(lastJob, stageData.at(-1).settings, fullOutput, englishFullOutput)}
      </details>`);
    analysisNetwork.before(panel);
    const edges = edgesByRun[run.id];
    const presentGenes = new Set(edges.flatMap(([source, target]) => [source, target]));
    const nodes = Object.fromEntries(Object.entries(networkNodes).filter(([gene]) => presentGenes.has(gene)));
    mountNetwork(panel, nodes, edges);
    return panel;
  });
  mountNetwork(analysisNetwork, networkNodes, edgesByRun[savedRuns[0].id]);

  runList.innerHTML = savedRuns.map((run, index) => `
    <button class="ml-nav-list-item" type="button" data-run-target="${index}" aria-controls="ml-run-${index}" aria-pressed="${index === 0}">
      <i data-lucide="circle-check" aria-hidden="true"></i>
      <span><strong>${runNames[index]}</strong><small>${run.date} · ${run.jobs[0].start}</small></span>
    </button>`).reverse().join("");
  runDetails.innerHTML = savedRuns.map((run, index) => {
    const [samples, variants] = run.geno.map(localNumber);
    const [expressionSamples, expressionGenes] = run.expression.map(localNumber);
    const [retained, adjustedVariants] = run.adjusted.map(localNumber);
    const [common, low, rare] = run.cis.map(localNumber);
    const [half, full] = run.frequency.map(localNumber);
    const [genes, edges] = run.network.map(localNumber);
    const outputPairs = [
      [`${samples} 個樣本 × ${variants} 個變異`, `${samples} samples × ${variants} variants`],
      [`${expressionSamples} 個樣本 × ${expressionGenes} 個基因`, `${expressionSamples} samples × ${expressionGenes} genes`],
      [`配對 ${run.matched} 位 · 保留 ${retained} 位和 ${adjustedVariants} 個變異`, `${run.matched} matched · ${retained} individuals and ${adjustedVariants} variants retained`],
      [`常見 ${common} 筆 · 低頻 ${low} 筆 · 罕見 ${rare} 筆`, `${common} common, ${low} low-frequency and ${rare} rare pairs`],
      [`${half} 條連線出現 1 次 · ${full} 條出現 2 次`, `${half} edges in 1 run · ${full} in 2 runs`],
    ];
    const stages = run.jobs.map((job, offset) => {
      const stage = stageData[offset];
      if (offset === 5) {
        return `<li>
          <button type="button" class="ml-run-step-link" data-run-network="${index}" aria-controls="ml-run-network-${index}">
            <i data-lucide="circle-check" aria-hidden="true"></i>
            <span>第 6 階段</span><strong>${stage.name}</strong>
            <time datetime="${run.date}T${job.end}-08:00">${job.end}</time>
            <i data-lucide="arrow-right" aria-hidden="true"></i>
          </button>
        </li>`;
      }
      return `<li><details class="ml-run-step">
        <summary>
          <i data-lucide="circle-check" aria-hidden="true"></i>
          <span>第 ${offset + 1} 階段</span><strong>${stage.name}</strong>
          <time datetime="${run.date}T${job.end}-08:00">${job.end}</time>
          <i data-lucide="chevron-down" class="ml-run-chevron" aria-hidden="true"></i>
        </summary>
        ${jobDetails(job, stage.settings, ...outputPairs[offset])}
      </details></li>`;
    }).join("");
    return `<article class="ml-nav-detail" id="ml-run-${index}" ${index ? "hidden" : ""}>
      <header class="ml-nav-detail-title"><i data-lucide="history" aria-hidden="true"></i><h2>${runNames[index]}</h2></header>
      <p class="ml-run-overview">${run.date} · ${run.jobs[0].start}–${run.jobs.at(-1).end} (UTC−08:00)<br>
        <span data-en-text="6 stages completed · ${genes} genes · ${edges} edges">完成 6 個階段 · ${genes} 個基因 · ${edges} 條連線</span>
      </p>
      <details class="ml-run-inputs">
        <summary data-en-text="Input files at execution">執行時使用的檔案</summary>
        <dl class="ml-key-values">
          <dt>基因型資料</dt><dd>${run.inputs.genotype.map((file) => `<code>${file}</code>`).join("<br>")}</dd>
          <dt>基因表現量資料</dt><dd><code>${run.inputs.expression}</code></dd>
          <dt>臨床資料</dt><dd><code>${run.inputs.clinical}</code></dd>
        </dl>
      </details>
      <ol class="ml-run-timeline" aria-label="六階段執行時間線">${stages}</ol>
      ${index === 0 ? '<button type="button" class="ml-nav-action" data-open-stage="6">開啟原型的分析結果</button>' : ''}
    </article>`;
  }).join("");

  const input = byId("input");
  const initialChat = JSON.parse(document.getElementById("initial-chat").textContent);
  const chatToken = document.querySelector('meta[name="chat-token"]').content;
  const chatModel = document.querySelector('meta[name="model-label"]').content;
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
  const remoteSwitch = byId("remote-switch");
  const remoteStatus = byId("remote-status");
  const checkEnvironment = byId("check-environment");
  const checkSummary = byId("check-summary");
  const readinessChecks = byId("environment-checks").querySelectorAll(".ml-settings-status");
  let environmentChecked = false;

  function renderRemoteSettings() {
    const connected = remoteSwitch.getAttribute("aria-checked") === "true";
    const english = root.lang === "en";
    remoteStatus.textContent = connected ? (english ? "Simulated connection" : "模擬已連線") : (english ? "Disconnected" : "未連線");
    remoteStatus.dataset.ready = String(connected);
    checkEnvironment.disabled = !connected;
    if (environmentChecked) {
      checkSummary.textContent = english
        ? `${readinessChecks.length}/${readinessChecks.length} ready in this preview.`
        : `模擬檢查完成，${readinessChecks.length}/${readinessChecks.length} 項就緒。`;
    } else {
      checkSummary.textContent = connected
        ? (english ? "Run the simulated readiness check." : "可執行模擬就緒檢查。")
        : (english ? "Enable the simulated connection to check readiness." : "開啟模擬連線後可檢查。");
    }
    for (const check of readinessChecks) {
      check.dataset.ready = String(environmentChecked);
      check.textContent = environmentChecked ? (english ? "Ready" : "已就緒") : (english ? "Not checked" : "未檢查");
    }
  }

  remoteSwitch.addEventListener("click", () => {
    const connected = remoteSwitch.getAttribute("aria-checked") === "true";
    remoteSwitch.setAttribute("aria-checked", String(!connected));
    environmentChecked = false;
    renderRemoteSettings();
  });
  checkEnvironment.addEventListener("click", () => {
    environmentChecked = true;
    renderRemoteSettings();
  });
  const modelChip = byId("model-chip");
  modelChip.textContent = modelChip.title = chatModel;
  byId("model-select").add(new Option(chatModel));

  const datasetSelect = byId("dataset-select");
  const datasetForm = byId("dataset-form");
  const datasetAdd = byId("dataset-add");
  const datasetName = byId("dataset-name");
  const datasetError = byId("dataset-error");

  function renderDatasetLabels() {
    datasetSelect.replaceChildren(...datasets.map((dataset) => {
      const option = document.createElement("option");
      option.value = dataset.id;
      option.textContent = localDatasetName(dataset);
      return option;
    }));
    datasetSelect.value = activeDataset.id;
    const label = localDatasetName(activeDataset);
    byId("history-dataset-name").textContent = label;
    byId("stage-dataset-title").textContent = label;
    datasetError.textContent = root.lang === "en" ? "Enter a dataset name." : "請輸入資料組名稱。";
  }

  function setLanguage(lang) {
    root.lang = lang;
    const inEnglish = lang === "en";
    for (const translate of translations) translate(inEnglish);
    renderChatLanguage();
    for (const network of [analysisNetwork, ...historyNetworks]) {
      network.dispatchEvent(new Event("lens:language-changed"));
    }
    renderRemoteSettings();
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

  let historyNetworkIndex = null;
  const selectedRuns = new Map();
  function updateHistoryView() {
    const inHistory = app.dataset.nav === "history";
    const matchingRuns = runsForDataset();
    const selected = selectedRuns.get(activeDataset.id) ?? matchingRuns[0]?.id;
    const showNetwork = historyNetworkIndex !== null && savedRuns[historyNetworkIndex].id === selected;
    runDetails.hidden = !inHistory || !matchingRuns.length || showNetwork;
    byId("empty-history").hidden = !inHistory || matchingRuns.length > 0;
    byId("empty-run-list").hidden = matchingRuns.length > 0;
    for (const button of runList.querySelectorAll("[data-run-target]")) {
      const run = savedRuns[Number(button.dataset.runTarget)];
      button.hidden = run.datasetId !== activeDataset.id;
      button.setAttribute("aria-pressed", String(run.id === selected));
      root.querySelector("#" + button.getAttribute("aria-controls")).hidden = run.id !== selected;
    }
    historyNetworks.forEach((panel, index) => {
      panel.hidden = !inHistory || !showNetwork || index !== historyNetworkIndex;
    });
  }

  function updateAnalysisView() {
    const hasSavedResults = runsForDataset().length > 0;
    app.toggleAttribute("data-no-analysis", !hasSavedResults);
    byId("empty-analysis").hidden = hasSavedResults || !["analysis", "settings"].includes(app.dataset.nav);
    timeline.hidden = !hasSavedResults;
    byId("stage-header").querySelector("span").hidden = !hasSavedResults;
    byId("empty-stage").hidden = hasSavedResults;
    for (const details of root.querySelectorAll("[data-archived-input]")) details.hidden = !hasSavedResults;
  }

  function closeDatasetForm() {
    datasetForm.hidden = true;
    datasetAdd.setAttribute("aria-expanded", "false");
    datasetForm.reset();
    datasetError.hidden = true;
  }

  function selectDataset(dataset) {
    closeDatasetForm();
    if (dataset !== activeDataset) {
      activeDataset = dataset;
      historyNetworkIndex = null;
      globalThis.lucide?.createIcons();
    }
    renderDatasetLabels();
    syncInputFiles(true);
    updateHistoryView();
    updateAnalysisView();
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
  function createDataset() {
    const name = datasetName.value.trim();
    if (!name) {
      datasetError.hidden = false;
      datasetName.focus();
      return;
    }
    const dataset = {
      id: `dataset-${datasets.length + 1}`,
      name: [name, name],
      folder: "/demo/signet/cohort-b",
      files: simulatedFiles,
      selections: {},
    };
    datasets.push(dataset);
    selectDataset(dataset);
    datasetSelect.focus();
  }
  byId("dataset-create").addEventListener("click", createDataset);
  datasetName.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    createDataset();
  });

  const navigation = root.querySelectorAll("[data-nav-target]");
  function openNavigation(view) {
    app.dataset.nav = view;
    const analysis = view === "analysis";
    root.querySelector(".ml-segment").hidden = !analysis;
    for (const tab of tabs) {
      root.querySelector("#" + tab.getAttribute("aria-controls")).hidden = !analysis || tab.getAttribute("aria-selected") !== "true";
    }
    for (const panel of root.querySelectorAll("[data-nav-left], [data-nav-right]")) {
      panel.hidden = (panel.dataset.navLeft ?? panel.dataset.navRight) !== view;
    }
    updateHistoryView();
    updateAnalysisView();
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
      for (const choice of inputChoices) {
        const selected = choice === button;
        choice.setAttribute("aria-pressed", String(selected));
        root.querySelector("#" + choice.getAttribute("aria-controls")).hidden = !selected;
      }
    });
  }
  for (const button of runList.querySelectorAll("[data-run-target]")) {
    button.addEventListener("click", () => {
      selectedRuns.set(activeDataset.id, savedRuns[Number(button.dataset.runTarget)].id);
      historyNetworkIndex = null;
      updateHistoryView();
    });
  }
  for (const button of root.querySelectorAll("[data-run-network]")) {
    button.addEventListener("click", () => {
      historyNetworkIndex = Number(button.dataset.runNetwork);
      updateHistoryView();
      historyNetworks[historyNetworkIndex].querySelector("[data-run-back]").focus({ preventScroll: true });
    });
  }
  for (const button of root.querySelectorAll("[data-run-back]")) {
    button.addEventListener("click", () => {
      historyNetworkIndex = null;
      updateHistoryView();
      runDetails.querySelector(`[data-run-network="${button.dataset.runBack}"]`).focus({ preventScroll: true });
    });
  }
  for (const button of root.querySelectorAll("[data-open-stage]")) {
    button.addEventListener("click", () => {
      openNavigation("analysis");
      selectTab(byId("stage-tab"));
      const stageButton = timeline.querySelector(`[data-stage="${button.dataset.openStage}"]`);
      showStage(stageButton, true);
      stageButton.focus({ preventScroll: true });
    });
  }

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

  updateHistoryView();
  updateAnalysisView();
  globalThis.lucide?.createIcons();
})();
