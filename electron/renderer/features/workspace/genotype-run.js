(() => {
  "use strict";

  const exampleDataset = "example-chr1";
  const examplePath = "/signet/genotype/example";
  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  const pollInterval = 15_000;
  const inputKeys = ["ped.file", "map.file", "ref", "gmap"];
  const parameters = [
    ["restrict.tcga.geno", 1, 1, 1], ["mind", 0, 1, "any"], ["geno", 0, 1, "any"],
    ["hwe", 0, 1, "any"], ["int", 1, 100_000_000, 1],
  ];
  const resources = ["cpus", "mem_gb", "hours"];
  const labels = {
    title: ["基因型準備", "Genotype preparation"],
    stage: ["第 1 階段", "Stage 1"],
    example: ["第 1 號染色體範例", "Chromosome 1 example"],
    review: ["檢查範例檔案", "Check example files"],
    checking: ["正在核對範例檔案…", "Checking example files…"],
    ready: ["可以核對並送出", "Ready to review and submit"],
    unavailable: ["範例尚未就緒", "The example is not ready"],
    readyPrompt: ["確認檔案與設定後，按「送出第 1 階段」。", "Review the files and settings, then select Submit Stage 1."],
    connect: ["請先到「設定 → 遠端運算」連線並確認環境就緒，再回來檢查範例。", "Connect and verify the environment in Settings → Remote compute, then check the example again."],
    inputs: ["範例輸入檔案", "Example inputs"],
    settings: ["設定", "Settings"],
    resources: ["運算資源", "Resources"],
    submit: ["送出第 1 階段", "Submit Stage 1"],
    refresh: ["重新查詢狀態", "Refresh status"],
    history: ["查看歷次執行", "View run history"],
    newRun: ["準備新的執行", "Prepare a new run"],
    runID: ["執行編號", "Run ID"],
    jobID: ["排程工作編號", "Scheduler job ID"],
    progress: ["執行進度", "Run progress"],
    "ped.file": ["基因型檔案", "Genotype file"],
    "map.file": ["變異位置檔案", "Variant map"],
    ref: ["補值參考檔", "Imputation reference"],
    gmap: ["遺傳圖譜", "Genetic map"],
    "restrict.tcga.geno": ["染色體", "Chromosome"],
    mind: ["樣本缺失率上限", "Max. sample missingness"],
    geno: ["變異缺失率上限", "Max. variant missingness"],
    hwe: ["哈溫平衡門檻", "HWE cutoff"],
    int: ["補值區塊長度（鹼基對）", "Imputation chunk length (bp)"],
    cpus: ["核心數", "CPU cores"],
    mem_gb: ["記憶體（GB）", "Memory (GB)"],
    hours: ["時間上限（小時）", "Time limit (hours)"],
    idle: ["尚未送出", "Not submitted"],
    submitting: ["正在送出", "Submitting"],
    submitted: ["已送出，等待排程狀態", "Submitted, waiting for scheduler status"],
    pending: ["排隊中", "Queued"],
    running: ["執行中", "Running"],
    validating: ["正在檢查並收取結果", "Checking and collecting results"],
    completed: ["已完成", "Completed"],
    cancelling: ["等待取消", "Cancelling"],
    cancelled: ["已取消", "Cancelled"],
    failed: ["執行失敗", "Failed"],
    unknown: ["待確認", "Status unconfirmed"],
    interrupted: ["連線中斷，顯示上次確認的狀態。", "Connection interrupted. Showing the last confirmed status."],
    uncertain: ["送出結果待確認。請查詢這筆執行的狀態。", "Submission outcome is unconfirmed. Check this run’s status."],
    serviceError: ["無法讀取本機服務。", "Could not read the local service."],
  };

  window.mountGenotypeRun = function mountGenotypeRun({panel, token, onHistoryChanged, onOpenHistory}) {
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main" data-live-language>
        <header>
          <p class="ml-genotype-eyebrow" data-genotype-copy="stage"></p>
          <h2 id="lens-stage1-title" data-genotype-copy="title"></h2>
          <p data-genotype-copy="example"></p>
        </header>
        <p data-genotype-readiness role="status"></p>
        <p data-genotype-guidance hidden></p>
        <button type="button" class="ml-nav-action" data-genotype-review data-genotype-copy="review"></button>
        <form data-genotype-form hidden>
          <h3 data-genotype-copy="inputs"></h3>
          <dl class="ml-key-values">
            ${inputKeys.map(key => `<dt data-genotype-copy="${key}"></dt><dd><code data-genotype-input="${key}"></code></dd>`).join("")}
          </dl>
          <fieldset data-genotype-fields>
            <legend data-genotype-copy="settings"></legend>
            <div class="ml-genotype-controls">
              ${parameters.map(([key, min, max, step]) => `
                <label><span data-genotype-copy="${key}"></span>
                  <input type="number" data-genotype-setting="${key}" min="${min}" max="${max}" step="${step}"
                    ${key === "restrict.tcga.geno" ? "readonly" : "required"}>
                </label>`).join("")}
            </div>
          </fieldset>
          <fieldset data-genotype-fields>
            <legend data-genotype-copy="resources"></legend>
            <div class="ml-genotype-controls">
              ${resources.map(key => `
                <label><span data-genotype-copy="${key}"></span>
                  <input type="number" data-genotype-resource="${key}" step="${key === "hours" ? "any" : "1"}" required>
                </label>`).join("")}
            </div>
          </fieldset>
          <button type="button" class="ml-nav-action ml-genotype-submit" data-genotype-submit data-genotype-copy="submit"></button>
        </form>
      </div>
      <aside class="ml-result-inspector ml-genotype-progress" data-live-language>
        <header class="ml-result-inspector-heading">
          <i data-lucide="activity" aria-hidden="true"></i>
          <h3 data-genotype-copy="progress"></h3>
        </header>
        <p class="ml-genotype-status" data-genotype-status role="status"></p>
        <dl class="ml-key-values" data-genotype-identifiers hidden>
          <dt data-genotype-copy="runID"></dt><dd data-genotype-run-id></dd>
          <dt data-genotype-copy="jobID"></dt><dd data-genotype-job-id></dd>
        </dl>
        <ol class="ml-genotype-events" data-genotype-events hidden></ol>
        <p class="ml-genotype-notice" data-genotype-notice role="status" hidden></p>
        <div class="ml-genotype-actions">
          <button type="button" class="ml-nav-action" data-genotype-refresh data-genotype-copy="refresh" hidden></button>
          <button type="button" class="ml-nav-action" data-genotype-history data-genotype-copy="history" hidden></button>
          <button type="button" class="ml-nav-action" data-genotype-new data-genotype-copy="newRun" hidden></button>
        </div>
      </aside>`;

    const part = (name) => panel.querySelector(`[data-genotype-${name}]`);
    const form = part("form");
    const reviewButton = part("review");
    const submitButton = part("submit");
    const statusButton = part("refresh");
    const historyButton = part("history");
    const newButton = part("new");
    const statusLine = part("status");
    const readiness = part("readiness");
    const guidance = part("guidance");
    const notice = part("notice");
    const events = part("events");
    const identifiers = part("identifiers");
    const runLabel = part("run-id");
    const jobLabel = part("job-id");
    const inputs = new Map(inputKeys.map(key => [key, panel.querySelector(`[data-genotype-input="${key}"]`)]));
    const settingsInputs = new Map(parameters.map(([key]) => [key, panel.querySelector(`[data-genotype-setting="${key}"]`)]));
    const resourceInputs = new Map(resources.map(key => [key, panel.querySelector(`[data-genotype-resource="${key}"]`)]));
    const fields = [...panel.querySelectorAll("[data-genotype-fields]")];

    let context = {visible: false, datasetId: "", language: "zh-Hant"};
    let review;
    let reviewing = false;
    let reviewAttempted = false;
    let runId = "";
    let record;
    let submitting = false;
    let polling = false;
    let pollTimer;
    let reviewError = "";
    let connectToReview = false;
    let runError = "";
    let submissionUnconfirmed = false;

    const localized = (key) => labels[key]?.[context.language === "en" ? 1 : 0] ?? key;
    const authToken = () => typeof token === "function" ? token() : token;

    async function request(path, body) {
      const headers = {"X-Chat-Token": authToken()};
      const options = {headers};
      if (body) {
        headers["Content-Type"] = "application/json";
        Object.assign(options, {method: "POST", body: JSON.stringify(body)});
      }
      const response = await fetch(path, options);
      const value = await response.json().catch(() => null);
      if (!response.ok || !value) {
        throw Object.assign(new Error(value?.error || localized("serviceError")), {
          status: response.status, code: value?.code,
        });
      }
      return value;
    }

    function fillReview({inputs: paths, settings, resources: available, limits}, keepDraft) {
      for (const [key, element] of inputs) {
        const suffix = key === "ref" ? "1.gen" : key === "gmap" ? "1.map" : "";
        element.textContent = paths[key] ? paths[key] + suffix : "—";
      }
      for (const [key, input] of settingsInputs) {
        if (!keepDraft) input.value = settings?.[key] ?? "";
      }
      for (const [key, input] of resourceInputs) {
        if (limits?.[key]) {
          [input.min, input.max] = limits[key];
        }
        if (!keepDraft) input.value = available?.[key] ?? "";
      }
    }

    function render() {
      for (const element of panel.querySelectorAll("[data-genotype-copy]")) {
        element.textContent = localized(element.dataset.genotypeCopy);
      }
      const state = record?.state || (submitting ? "submitting" : runId ? "unknown" : "idle");
      panel.dataset.genotypeState = state;
      if (runId) panel.dataset.genotypeRunId = runId;
      else delete panel.dataset.genotypeRunId;

      const eligible = context.datasetId === exampleDataset;
      const terminal = terminalStates.has(state);
      statusLine.textContent = localized(state);
      reviewButton.hidden = !eligible || Boolean(runId);
      reviewButton.disabled = reviewing;
      readiness.hidden = !eligible || Boolean(runId);
      readiness.textContent = localized(reviewing ? "checking" : review ? "ready" : reviewAttempted ? "unavailable" : "review");
      guidance.hidden = !eligible || Boolean(runId);
      guidance.textContent = review ? localized("readyPrompt") : connectToReview && !reviewing ? localized("connect") : "";

      const hasFiles = Boolean(review || record?.inputs);
      form.hidden = !eligible || !hasFiles;
      for (const field of fields) field.disabled = Boolean(runId);
      submitButton.hidden = Boolean(runId);
      submitButton.disabled = !eligible || !review || reviewing || submitting || Boolean(runId);
      statusButton.hidden = !runId || terminal;
      statusButton.disabled = submitting || polling;
      historyButton.hidden = !record;
      newButton.hidden = !terminal;

      identifiers.hidden = !runId;
      runLabel.textContent = runId;
      jobLabel.textContent = record?.job_id ?? "—";
      notice.textContent = [submissionUnconfirmed ? localized("uncertain") : "", runError || reviewError]
        .filter(Boolean).join(" ");
      notice.hidden = !notice.textContent;

      events.replaceChildren(...(record?.history ?? []).map(({state: eventState, at}) => {
        const item = document.createElement("li");
        item.dataset.state = eventState;
        item.textContent = localized(eventState);
        if (at) {
          const time = document.createElement("time");
          time.dateTime = at;
          const date = new Date(at);
          time.textContent = Number.isNaN(date.valueOf()) ? at : date.toLocaleString(context.language);
          item.append(time);
        }
        return item;
      }));
      events.hidden = !events.children.length;
    }

    async function checkExample() {
      if (reviewing || runId || context.datasetId !== exampleDataset) return;
      reviewing = true;
      reviewAttempted = true;
      reviewError = "";
      connectToReview = false;
      const previous = review;
      render();
      try {
        const next = await request(examplePath);
        if (!runId) {
          review = next;
          fillReview(review, Boolean(previous) && inputKeys.every(key => previous.inputs[key] === review.inputs[key]));
        }
      } catch (error) {
        if (!runId) {
          review = null;
          reviewError = error.message;
          connectToReview = error.status === 412 || error.code === "remote_failed";
        }
      } finally {
        reviewing = false;
        render();
      }
    }

    function schedulePoll(delay = pollInterval) {
      clearTimeout(pollTimer);
      if (runId && !submitting && !terminalStates.has(record?.state)) {
        pollTimer = setTimeout(() => void refresh(), delay);
      }
    }

    function receiveRecord(next, id) {
      if (next.run_id !== id || !Object.hasOwn(labels, next.state)) {
        throw new Error(localized("serviceError"));
      }
      const changed = !record || next.state !== record.state || next.job_id !== record.job_id;
      record = next;
      submissionUnconfirmed = false;
      if (next.inputs) fillReview(next, false);
      runError = next.connection === "interrupted" ? localized("interrupted")
        : ["unknown", "validating", "failed"].includes(next.state) ? next.reason || "" : "";
      if (changed) onHistoryChanged?.(id);
    }

    async function refresh(force = false) {
      if (!runId || submitting || polling) return;
      const id = runId;
      polling = true;
      clearTimeout(pollTimer);
      render();
      try {
        const path = `/signet/runs/${encodeURIComponent(id)}/steps/genotype`;
        const next = await request(path + (force ? "?refresh=1" : ""));
        if (runId === id) receiveRecord(next, id);
      } catch (error) {
        if (runId === id) runError = error.message;
      } finally {
        polling = false;
        render();
        schedulePoll();
      }
    }

    function restore(id, saved) {
      if (runId || !id) return;
      runId = id;
      if (saved?.run_id === id) {
        record = saved;
        if (record.inputs) fillReview(record, false);
      }
      render();
      if (!terminalStates.has(record?.state)) void refresh();
    }

    function reset() {
      if (!terminalStates.has(record?.state)) return;
      clearTimeout(pollTimer);
      runId = "";
      record = null;
      runError = "";
      submissionUnconfirmed = false;
      void checkExample();
    }

    function readNumbers(elements) {
      return Object.fromEntries([...elements].map(([key, input]) => [key, input.valueAsNumber]));
    }

    async function submit() {
      if (submitButton.disabled || !form.reportValidity()) return;
      const id = `chr1-${crypto.randomUUID()}`;
      const body = {run_id: id, inputs: review.inputs, settings: readNumbers(settingsInputs), resources: readNumbers(resourceInputs)};
      runId = id;
      submitting = true;
      runError = "";
      render();
      try {
        receiveRecord(await request(examplePath, body), id);
      } catch (error) {
        runError = error.message;
        const needsReview = error.status === 400 || error.status === 412;
        const refused = error.status === 502 && error.code === "remote_failed";
        if (needsReview || refused) {
          runId = "";
          onHistoryChanged?.(id);
          if (needsReview) {
            review = null;
            reviewError = runError;
            connectToReview = error.status === 412;
            runError = "";
          }
        } else {
          submissionUnconfirmed = true;
        }
      } finally {
        submitting = false;
        render();
        schedulePoll(1_000);
      }
    }

    form.addEventListener("submit", (event) => event.preventDefault());
    reviewButton.addEventListener("click", () => void checkExample());
    submitButton.addEventListener("click", () => void submit());
    statusButton.addEventListener("click", () => void refresh(true));
    historyButton.addEventListener("click", () => onOpenHistory?.(runId));
    newButton.addEventListener("click", reset);
    render();

    return {
      setContext(next) {
        context = next;
        render();
        if (context.visible && context.datasetId === exampleDataset && !reviewAttempted && !runId) {
          void checkExample();
        }
      },
      restore,
    };
  };

  const expressionCopy = {
    title: ["基因表現量準備", "Expression preparation"],
    stage: ["第 2 階段", "Stage 2"],
    run: ["接續執行", "Continue run"],
    empty: ["先選擇已完成第 1 階段的執行。", "Choose a run with completed Stage 1."],
    prerequisite: ["這筆執行的第 1 階段完成後，即可核對第 2 階段。", "Review Stage 2 after Stage 1 completes in this run."],
    readyPrompt: ["核對檔案與設定後，按「送出第 2 階段」。", "Review the files and settings, then select Submit Stage 2."],
    submit: ["送出第 2 階段", "Submit Stage 2"],
    retry: ["重新核對並準備送出", "Review a new attempt"],
    back: ["回到執行時間線", "Back to run timeline"],
    chromosome: ["染色體", "Chromosome"],
    "gexp.file": ["基因表現量檔案", "Expression file"],
    "pmap.file": ["基因註解檔案", "Gene annotation file"],
  };

  const adjustmentCopy = {
    title: ["樣本配對與校正", "Sample matching and adjustment"],
    stage: ["第 3 階段", "Stage 3"],
    run: ["接續執行", "Continue run"],
    empty: ["先選擇第 1、2 階段已完成的執行。", "Choose a run with completed Stages 1 and 2."],
    prerequisite: ["這筆執行的第 1、2 階段完成後，即可送出第 3 階段。", "Submit Stage 3 after Stages 1 and 2 complete in this run."],
    readyPrompt: ["核對臨床資料、主成分數與運算資源後，按「送出第 3 階段」。", "Review the clinical file, principal components and resources, then select Submit Stage 3."],
    submit: ["送出第 3 階段", "Submit Stage 3"],
    review: ["檢查臨床資料", "Check clinical file"],
    checking: ["正在核對臨床資料…", "Checking clinical data…"],
    inputs: ["臨床資料", "Clinical data"],
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    npc: ["校正使用的主成分數（0–10）", "Principal components for adjustment (0–10)"],
    "cli.file": ["臨床資料檔案", "Clinical data file"],
  };

  const cisCopy = {
    title: ["基因與變異關聯分析", "Gene–variant associations"],
    stage: ["第 4 階段", "Stage 4"],
    run: expressionCopy.run,
    empty: ["先選擇前 3 階段已完成的執行。", "Choose a run with completed Stages 1–3."],
    prerequisite: ["這筆執行的前 3 階段完成後，即可送出第 4 階段。", "Submit Stage 4 after Stages 1–3 complete in this run."],
    readyPrompt: ["核對顯著門檻、分析範圍與置換次數後，按「送出第 4 階段」。", "Review the significance threshold, analysis range and permutations, then select Submit Stage 4."],
    submit: ["送出第 4 階段", "Submit Stage 4"],
    review: ["檢查前階段結果", "Check prior results"],
    checking: ["正在核對前階段結果…", "Checking prior results…"],
    inputs: ["沿用這筆執行的檔案", "Files from this run"],
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    "alpha.cis": ["顯著門檻", "Significance threshold"],
    upstream: ["基因終點後的範圍（鹼基對）", "After gene end (base pairs)"],
    downstream: ["基因起點前的範圍（鹼基對）", "Before gene start (base pairs)"],
    nperms: ["置換次數", "Permutations"],
    positiveAlpha: ["顯著門檻必須大於 0。", "The significance threshold must be above 0."],
  };

  function mountContinuationRun({panel, token, onHistoryChanged, onOpenHistory, onBack}, step = "expression") {
    const adjustment = step === "adjust";
    const cis = step === "cis";
    const alwaysVisible = adjustment || cis;
    const prefix = step;
    const stage = cis ? 4 : adjustment ? 3 : 2;
    const copy = cis ? cisCopy : adjustment ? adjustmentCopy : expressionCopy;
    const parameterGroup = adjustment ? "options" : "settings";
    const parameterAttribute = adjustment ? "option" : "setting";
    const parameterDefinitions = cis ? [
      {key: "alpha.cis", label: "alpha.cis", min: 0, max: 1, value: 0.05, step: "any"},
      {key: "downstream", label: "downstream", min: 0, max: 10_000_000, value: 1000, step: 1},
      {key: "upstream", label: "upstream", min: 0, max: 10_000_000, value: 1000, step: 1},
      {key: "nperms", label: "nperms", min: 1, max: 100_000, value: 100, step: 1},
    ] : [{key: adjustment ? "npc" : "restrict.tcga", label: adjustment ? "npc" : "chromosome",
      min: adjustment ? 0 : 1, max: adjustment ? 10 : 1, value: adjustment ? 3 : 1, step: 1}];
    const initialResources = cis ? {cpus: 8, mem_gb: 32, hours: 4} : {cpus: 4, mem_gb: 16, hours: 2};
    const fileKeys = cis ? [] : adjustment ? ["cli.file"] : ["gexp.file", "pmap.file"];
    panel.classList.add("ml-expression-panel");
    if (adjustment) panel.classList.add("ml-adjust-panel");
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main" data-live-language>
        <header><p class="ml-genotype-eyebrow" data-${prefix}-copy="stage"></p>
          <h2 id="lens-stage${stage}-title" data-${prefix}-copy="title"></h2></header>
        <label class="ml-expression-run-label"><span data-${prefix}-copy="run"></span>
          <select data-${prefix}-run></select>
        </label>
        <p data-${prefix}-readiness role="status"></p>
        <p data-${prefix}-guidance></p>
        <button type="button" class="ml-nav-action" data-${prefix}-review data-${prefix}-copy="review"></button>
        <form data-${prefix}-form hidden>
          ${cis ? '' : `<h3 data-${prefix}-copy="inputs"></h3>`}
          <dl class="ml-key-values" ${cis ? 'hidden' : ''}>${fileKeys.map(key => `<dt data-${prefix}-copy="${key}"></dt>
            <dd>${adjustment
              ? `<input class="ml-clinical-input" type="text" data-${prefix}-input="${key}" maxlength="2048" required>`
              : `<code data-${prefix}-input="${key}"></code>`}</dd>`).join("")}</dl>
          ${adjustment ? '<p class="ml-settings-note" data-adjust-clinical-summary role="status"></p>' : ''}
          <fieldset data-${prefix}-fields><legend data-${prefix}-copy="settings"></legend>
            <div class="ml-genotype-controls">${parameterDefinitions.map(({key, label, min, max, value, step: increment}) => `<label>
              <span data-${prefix}-copy="${label}"></span>
              <input type="number" data-${prefix}-${parameterAttribute}="${key}" min="${min}" max="${max}" step="${increment}" value="${value}" ${alwaysVisible ? 'required' : 'readonly'}>
            </label>`).join("")}</div>
          </fieldset>
          <fieldset data-${prefix}-fields><legend data-${prefix}-copy="resources"></legend>
            <div class="ml-genotype-controls">${resources.map(key => `<label><span data-${prefix}-copy="${key}"></span>
              <input type="number" data-${prefix}-resource="${key}" step="${key === "hours" ? "any" : "1"}" value="${alwaysVisible ? initialResources[key] : ''}" required>
            </label>`).join("")}</div>
          </fieldset>
          ${cis ? '<details class="ml-cis-inputs"><summary data-cis-copy="inputs"></summary><dl class="ml-key-values" data-cis-input-sources></dl></details>' : ''}
          <button type="button" class="ml-nav-action ml-genotype-submit" data-${prefix}-submit data-${prefix}-copy="submit"></button>
        </form>
      </div>
      <aside class="ml-result-inspector ml-genotype-progress" data-live-language>
        <header class="ml-result-inspector-heading"><h3 data-${prefix}-copy="progress"></h3></header>
        <p class="ml-genotype-status" data-${prefix}-status role="status"></p>
        <dl class="ml-key-values" data-${prefix}-identifiers hidden>
          <dt data-${prefix}-copy="runID"></dt><dd data-${prefix}-run-id></dd>
          <dt data-${prefix}-copy="jobID"></dt><dd data-${prefix}-job-id></dd>
        </dl>
        <ol class="ml-genotype-events" data-${prefix}-events hidden></ol>
        <p class="ml-genotype-notice" data-${prefix}-notice role="status" hidden></p>
        <div class="ml-genotype-actions">
          <button type="button" class="ml-nav-action" data-${prefix}-refresh data-${prefix}-copy="refresh" hidden></button>
          <button type="button" class="ml-nav-action" data-${prefix}-history data-${prefix}-copy="history" hidden></button>
          <button type="button" class="ml-nav-action" data-${prefix}-retry data-${prefix}-copy="retry" hidden></button>
          <button type="button" class="ml-nav-action" data-${prefix}-back data-${prefix}-copy="back" hidden></button>
        </div>
      </aside>`;

    const part = name => panel.querySelector(`[data-${prefix}-${name}]`);
    const form = part("form");
    const picker = part("run");
    const resourceInputs = new Map(resources.map(key => [key, panel.querySelector(`[data-${prefix}-resource="${key}"]`)]));
    const parameterInputs = new Map(parameterDefinitions.map(({key}) => [key, panel.querySelector(`[data-${prefix}-${parameterAttribute}="${key}"]`)]));
    const fields = [...panel.querySelectorAll(`[data-${prefix}-fields]`)];
    const runStates = new Map();
    let context = {datasetId: "", language: "zh-Hant", visible: false, runs: [], runId: null};
    let selectedRun = "";
    let pollTimer;
    const local = key => (copy[key] ?? labels[key])?.[context.language === "en" ? 1 : 0] ?? key;
    const current = () => runStates.get(selectedRun);
    const source = () => context.runs.find(run => run.run_id === selectedRun);

    function stateFor(id) {
      if (!runStates.has(id)) runStates.set(id, {record: null, review: null, attempted: false, checking: false,
        submitting: false, polling: false, uncertain: false, retry: false, error: ""});
      return runStates.get(id);
    }

    async function request(path, body) {
      const headers = {"X-Chat-Token": typeof token === "function" ? token() : token};
      const options = {headers};
      if (body) {
        Object.assign(options, {method: "POST", body: JSON.stringify(body)});
        headers["Content-Type"] = "application/json";
      }
      const reply = await fetch(path, options);
      const result = await reply.json().catch(() => null);
      if (!reply.ok || !result) throw Object.assign(new Error(result?.error || local("serviceError")), {status: reply.status, code: result?.code});
      return result;
    }

    function fillReview(value, keepDraft = false) {
      for (const key of fileKeys) {
        const element = panel.querySelector(`[data-${prefix}-input="${key}"]`);
        if (adjustment) element.value = value.inputs?.[key] ?? "";
        else element.textContent = value.inputs?.[key] ?? "—";
      }
      for (const [key, element] of parameterInputs) if (!keepDraft) element.value = value[parameterGroup]?.[key] ?? "";
      for (const [key, element] of resourceInputs) {
        if (value.limits?.[key]) [element.min, element.max] = value.limits[key];
        if (!keepDraft) element.value = value.resources?.[key] ?? "";
      }
    }

    function saveDraft() {
      const item = current();
      if (!alwaysVisible || !item || item.record && !item.retry) return;
      item.draft = {
        clinical: adjustment ? panel.querySelector('[data-adjust-input="cli.file"]').value : "",
        parameters: Object.fromEntries([...parameterInputs].map(([key, input]) => [key, input.value])),
        resources: Object.fromEntries([...resourceInputs].map(([key, input]) => [key, input.value])),
      };
    }

    function render() {
      for (const element of panel.querySelectorAll(`[data-${prefix}-copy]`)) element.textContent = local(element.getAttribute(`data-${prefix}-copy`));
      const item = current();
      const saved = item?.record;
      const state = item?.submitting ? "submitting" : item?.uncertain ? "unknown" : saved?.state ?? "idle";
      const hasAttempt = Boolean(saved) && !item?.retry || Boolean(item?.submitting || item?.uncertain);
      const allowed = source()?.jobs.genotype?.state === "completed" &&
        (step === "expression" || source()?.jobs.expression?.state === "completed") &&
        (!cis || source()?.jobs.adjust?.state === "completed");
      const terminal = terminalStates.has(state);
      panel.dataset[`${prefix}State`] = state;
      panel.dataset[`${prefix}RunId`] = selectedRun;
      const selection = selectedRun;
      picker.replaceChildren(...context.runs.map(run => {
        const option = document.createElement("option");
        option.value = run.run_id;
        option.textContent = run.run_id;
        return option;
      }));
      picker.value = selection;
      picker.disabled = Boolean(context.runId) || !context.runs.length || Boolean(item?.submitting);
      part("readiness").textContent = !selectedRun ? local("empty") : !allowed ? local("prerequisite")
        : item.checking ? local("checking") : item.review && !hasAttempt ? local(item.review.ready === false ? "unavailable" : "ready") : "";
      part("guidance").textContent = allowed && item?.review && !hasAttempt && item.review.ready !== false ? local("readyPrompt") : "";
      part("review").hidden = !(alwaysVisible ? selectedRun : allowed) || hasAttempt;
      part("review").disabled = Boolean(item?.checking);
      form.hidden = !alwaysVisible && (!allowed || !(hasAttempt ? saved?.inputs : item?.review));
      for (const field of fields) field.disabled = hasAttempt || !selectedRun;
      if (adjustment) {
        panel.querySelector('[data-adjust-input="cli.file"]').disabled = hasAttempt || Boolean(item?.checking) || !selectedRun;
        const clinical = item?.review?.clinical;
        part("clinical-summary").textContent = clinical
          ? (context.language === "en" ? `${clinical.rows ?? 0} clinical rows · ${(clinical.columns ?? []).join(", ")}`
            : `${clinical.rows ?? 0} 筆臨床資料 · ${(clinical.columns ?? []).join("、")}`) : "";
      }
      if (cis) {
        const inputSources = saved?.input_sources ?? item?.review?.input_sources ?? source()?.jobs.cis?.input_sources ?? {};
        const entries = Object.entries(inputSources);
        const inputs = part("input-sources");
        inputs.replaceChildren();
        for (const [key, path] of entries) {
          const label = document.createElement("dt");
          const value = document.createElement("dd");
          const code = document.createElement("code");
          label.textContent = key;
          code.textContent = path;
          value.append(code);
          inputs.append(label, value);
        }
        inputs.hidden = !entries.length;
      }
      part("submit").hidden = hasAttempt;
      part("submit").disabled = !allowed || !item?.review || item.review.ready === false || item.checking || item.submitting || hasAttempt;
      part("status").textContent = local(state);
      part("identifiers").hidden = !selectedRun;
      part("run-id").textContent = selectedRun;
      part("job-id").textContent = saved?.job_id ?? "—";
      part("refresh").hidden = !hasAttempt || terminal;
      part("refresh").disabled = Boolean(item?.polling || item?.submitting);
      part("history").hidden = !saved;
      part("retry").hidden = !saved || !["failed", "cancelled"].includes(state) || Boolean(item?.retry || item?.uncertain);
      part("back").hidden = !context.runId;
      const message = [item?.uncertain ? local("uncertain") : "", item?.error].filter(Boolean).join(" ");
      part("notice").textContent = message;
      part("notice").hidden = !message;
      part("events").replaceChildren(...(saved?.history ?? []).map(event => {
        const row = document.createElement("li");
        row.dataset.state = event.state;
        row.textContent = local(event.state);
        if (event.at) {
          const time = document.createElement("time");
          time.dateTime = event.at;
          const date = new Date(event.at);
          time.textContent = Number.isNaN(date.valueOf()) ? event.at : date.toLocaleString(context.language);
          row.append(time);
        }
        return row;
      }));
      part("events").hidden = !saved?.history?.length;
    }

    function accept(item, value, id) {
      if (value.run_id !== id || value.step !== step || !Object.hasOwn(labels, value.state)) throw Error(local("serviceError"));
      const changed = !item.record || value.state !== item.record.state || value.job_id !== item.record.job_id;
      item.record = value;
      item.uncertain = false;
      item.retry = false;
      item.error = value.connection === "interrupted" ? local("interrupted") : value.reason ?? "";
      if (id === selectedRun && value.inputs) fillReview(value);
      if (changed) onHistoryChanged?.(id);
    }

    function schedule() {
      clearTimeout(pollTimer);
      const item = current();
      if (item && !item.submitting && (item.uncertain || item.record && !terminalStates.has(item.record.state))) {
        pollTimer = setTimeout(() => void refresh(), pollInterval);
      }
    }

    async function refresh(force = false) {
      const id = selectedRun;
      const item = current();
      if (!id || !item || item.polling || item.submitting) return;
      item.polling = true;
      render();
      try {
        accept(item, await request(`/signet/runs/${encodeURIComponent(id)}/steps/${step}${force ? "?refresh=1" : ""}`), id);
      } catch (error) {
        item.error = error.message;
      } finally {
        item.polling = false;
        render();
        schedule();
      }
    }

    async function review() {
      const id = selectedRun;
      const item = current();
      if (!id || !item || !source() || item.checking || item.submitting || item.uncertain || item.record && !item.retry || !alwaysVisible && source()?.jobs.genotype?.state !== "completed") return;
      item.checking = item.attempted = true;
      item.error = "";
      render();
      try {
        const clinicalPath = adjustment ? panel.querySelector('[data-adjust-input="cli.file"]').value.trim() : "";
        const query = clinicalPath ? `?clinical=${encodeURIComponent(clinicalPath)}` : "";
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/${step}/example${query}`);
        const preserve = adjustment || (cis ? Boolean(item.draft) : item.review && fileKeys.every(key => item.review.inputs[key] === next.inputs[key]));
        item.review = next;
        item.error = next.issues?.join(" ") || next.reason || "";
        if (id === selectedRun) {
          fillReview(next, Boolean(preserve));
          saveDraft();
        }
      } catch (error) {
        item.review = null;
        item.error = error.message;
      } finally {
        item.checking = false;
        render();
      }
    }

    function selectRun(id) {
      const changed = selectedRun !== id;
      if (changed) saveDraft();
      selectedRun = id;
      clearTimeout(pollTimer);
      const item = id ? stateFor(id) : null;
      const saved = source()?.jobs[step];
      const received = saved && saved.state !== "not_submitted" && !item.submitting && !item.uncertain &&
        (!item.record || Date.parse(saved.updated_at ?? saved.submitted_at) > Date.parse(item.record.updated_at ?? item.record.submitted_at));
      if (received) item.record = saved;
      if ((changed || received) && item?.record?.inputs && !item.retry) fillReview(item.record);
      else if (changed && item?.review) fillReview(item.review);
      else if (changed && alwaysVisible) fillReview({[parameterGroup]: Object.fromEntries(parameterDefinitions.map(({key, value}) => [key, value])), resources: initialResources});
      if (changed && alwaysVisible && item?.draft && (!item.record || item.retry)) {
        if (adjustment) panel.querySelector('[data-adjust-input="cli.file"]').value = item.draft.clinical;
        for (const [key, input] of parameterInputs) input.value = item.draft.parameters[key];
        for (const [key, input] of resourceInputs) input.value = item.draft.resources[key];
      }
      render();
      if (context.visible && item && !item.attempted && !item.record) void review();
      if (item?.record && !terminalStates.has(item.record.state)) void refresh();
      schedule();
    }

    async function submit() {
      const id = selectedRun;
      const item = current();
      if (!item || part("submit").disabled) return;
      if (cis) {
        const alpha = parameterInputs.get("alpha.cis");
        alpha.setCustomValidity(alpha.valueAsNumber > 0 ? "" : local("positiveAlpha"));
      }
      if (!form.reportValidity()) return;
      const values = inputs => Object.fromEntries([...inputs].map(([key, element]) => [key, element.valueAsNumber]));
      const body = {inputs: item.review.inputs, [parameterGroup]: values(parameterInputs), resources: values(resourceInputs)};
      item.submitting = true;
      item.retry = false;
      item.error = "";
      render();
      try {
        accept(item, await request(`/signet/runs/${encodeURIComponent(id)}/${step}/example`, body), id);
      } catch (error) {
        item.error = error.message;
        if (error.status === 400 || error.status === 412 || error.status === 502 && error.code === "remote_failed") {
          item.review = null;
          item.attempted = false;
          item.retry = Boolean(item.record);
          onHistoryChanged?.(id);
        } else {
          item.uncertain = true;
          void onHistoryChanged?.(id);
        }
      } finally {
        item.submitting = false;
        render();
        schedule();
      }
    }

    form.addEventListener("submit", event => event.preventDefault());
    if (adjustment) {
      panel.querySelector('[data-adjust-input="cli.file"]').addEventListener("input", () => {
        const item = current();
        if (!item) return;
        item.review = null;
        item.attempted = true;
        item.error = "";
        saveDraft();
        render();
      });
    }
    if (alwaysVisible) for (const input of [...parameterInputs.values(), ...resourceInputs.values()]) {
      input.addEventListener("input", () => { input.setCustomValidity(""); saveDraft(); });
    }
    picker.addEventListener("change", () => selectRun(picker.value));
    part("review").addEventListener("click", () => void review());
    part("submit").addEventListener("click", () => void submit());
    part("refresh").addEventListener("click", () => void refresh(true));
    part("history").addEventListener("click", () => onOpenHistory?.(selectedRun));
    part("back").addEventListener("click", () => onBack?.());
    part("retry").addEventListener("click", () => {
      const item = current();
      if (!item || item.uncertain || item.submitting || !["failed", "cancelled"].includes(item.record?.state)) return;
      item.retry = true;
      item.review = null;
      void review();
    });
    return {
      setContext(next) {
        context = next;
        const id = context.runId ?? (context.runs.some(run => run.run_id === selectedRun) ? selectedRun : context.runs[0]?.run_id ?? "");
        selectRun(id);
      },
    }
  }

  window.mountExpressionRun = options => mountContinuationRun(options);
  window.mountAdjustmentRun = options => mountContinuationRun(options, "adjust");
  window.mountCisRun = options => mountContinuationRun(options, "cis");

})();
