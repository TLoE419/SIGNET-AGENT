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

  window.mountExpressionRun = function mountExpressionRun({panel, token, onHistoryChanged, onOpenHistory, onBack}) {
    const expressionInputs = ["gexp.file", "pmap.file"];
    panel.classList.add("ml-expression-panel");
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main" data-live-language>
        <header><p class="ml-genotype-eyebrow" data-expression-copy="stage"></p>
          <h2 id="lens-stage2-title" data-expression-copy="title"></h2></header>
        <label class="ml-expression-run-label"><span data-expression-copy="run"></span>
          <select data-expression-run></select>
        </label>
        <p data-expression-readiness role="status"></p>
        <p data-expression-guidance></p>
        <button type="button" class="ml-nav-action" data-expression-review data-expression-copy="review"></button>
        <form data-expression-form hidden>
          <h3 data-expression-copy="inputs"></h3>
          <dl class="ml-key-values">${expressionInputs.map(key => `<dt data-expression-copy="${key}"></dt>
            <dd><code data-expression-input="${key}"></code></dd>`).join("")}</dl>
          <fieldset data-expression-fields><legend data-expression-copy="settings"></legend>
            <div class="ml-genotype-controls"><label><span data-expression-copy="chromosome"></span>
              <input type="number" data-expression-setting="restrict.tcga" min="1" max="1" value="1" readonly>
            </label></div>
          </fieldset>
          <fieldset data-expression-fields><legend data-expression-copy="resources"></legend>
            <div class="ml-genotype-controls">${resources.map(key => `<label><span data-expression-copy="${key}"></span>
              <input type="number" data-expression-resource="${key}" step="${key === "hours" ? "any" : "1"}" required>
            </label>`).join("")}</div>
          </fieldset>
          <button type="button" class="ml-nav-action ml-genotype-submit" data-expression-submit data-expression-copy="submit"></button>
        </form>
      </div>
      <aside class="ml-result-inspector ml-genotype-progress" data-live-language>
        <header class="ml-result-inspector-heading"><h3 data-expression-copy="progress"></h3></header>
        <p class="ml-genotype-status" data-expression-status role="status"></p>
        <dl class="ml-key-values" data-expression-identifiers hidden>
          <dt data-expression-copy="runID"></dt><dd data-expression-run-id></dd>
          <dt data-expression-copy="jobID"></dt><dd data-expression-job-id></dd>
        </dl>
        <ol class="ml-genotype-events" data-expression-events hidden></ol>
        <p class="ml-genotype-notice" data-expression-notice role="status" hidden></p>
        <div class="ml-genotype-actions">
          <button type="button" class="ml-nav-action" data-expression-refresh data-expression-copy="refresh" hidden></button>
          <button type="button" class="ml-nav-action" data-expression-history data-expression-copy="history" hidden></button>
          <button type="button" class="ml-nav-action" data-expression-retry data-expression-copy="retry" hidden></button>
          <button type="button" class="ml-nav-action" data-expression-back data-expression-copy="back" hidden></button>
        </div>
      </aside>`;

    const part = name => panel.querySelector(`[data-expression-${name}]`);
    const form = part("form");
    const picker = part("run");
    const resourceInputs = new Map(resources.map(key => [key, panel.querySelector(`[data-expression-resource="${key}"]`)]));
    const settingsInputs = new Map([["restrict.tcga", panel.querySelector('[data-expression-setting="restrict.tcga"]')]]);
    const fields = [...panel.querySelectorAll("[data-expression-fields]")];
    const runStates = new Map();
    let context = {datasetId: "", language: "zh-Hant", visible: false, runs: [], runId: null};
    let selectedRun = "";
    let pollTimer;
    const local = key => (expressionCopy[key] ?? labels[key])?.[context.language === "en" ? 1 : 0] ?? key;
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
      for (const key of expressionInputs) panel.querySelector(`[data-expression-input="${key}"]`).textContent = value.inputs?.[key] ?? "—";
      for (const [key, element] of settingsInputs) if (!keepDraft) element.value = value.settings?.[key] ?? "";
      for (const [key, element] of resourceInputs) {
        if (value.limits?.[key]) [element.min, element.max] = value.limits[key];
        if (!keepDraft) element.value = value.resources?.[key] ?? "";
      }
    }

    function render() {
      for (const element of panel.querySelectorAll("[data-expression-copy]")) element.textContent = local(element.dataset.expressionCopy);
      const item = current();
      const saved = item?.record;
      const state = item?.submitting ? "submitting" : item?.uncertain ? "unknown" : saved?.state ?? "idle";
      const hasAttempt = Boolean(saved) && !item?.retry || Boolean(item?.submitting || item?.uncertain);
      const allowed = source()?.jobs.genotype?.state === "completed";
      const terminal = terminalStates.has(state);
      panel.dataset.expressionState = state;
      panel.dataset.expressionRunId = selectedRun;
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
        : item.checking ? local("checking") : item.review && !hasAttempt ? local("ready") : "";
      part("guidance").textContent = allowed && item?.review && !hasAttempt ? local("readyPrompt") : "";
      part("review").hidden = !allowed || hasAttempt;
      part("review").disabled = Boolean(item?.checking);
      form.hidden = !allowed || !(hasAttempt ? saved?.inputs : item?.review);
      for (const field of fields) field.disabled = hasAttempt;
      part("submit").hidden = hasAttempt;
      part("submit").disabled = !allowed || !item?.review || item.checking || item.submitting || hasAttempt;
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
      if (value.run_id !== id || value.step !== "expression" || !Object.hasOwn(labels, value.state)) throw Error(local("serviceError"));
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
        accept(item, await request(`/signet/runs/${encodeURIComponent(id)}/steps/expression${force ? "?refresh=1" : ""}`), id);
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
      if (!id || !item || item.checking || item.submitting || item.uncertain || item.record && !item.retry || source()?.jobs.genotype?.state !== "completed") return;
      item.checking = item.attempted = true;
      item.error = "";
      render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/expression/example`);
        const preserve = item.review && expressionInputs.every(key => item.review.inputs[key] === next.inputs[key]);
        item.review = next;
        if (id === selectedRun) fillReview(next, Boolean(preserve));
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
      selectedRun = id;
      clearTimeout(pollTimer);
      const item = id ? stateFor(id) : null;
      const saved = source()?.jobs.expression;
      const received = saved && saved.state !== "not_submitted" && !item.submitting && !item.uncertain &&
        (!item.record || Date.parse(saved.updated_at ?? saved.submitted_at) > Date.parse(item.record.updated_at ?? item.record.submitted_at));
      if (received) item.record = saved;
      if ((changed || received) && item?.record?.inputs && !item.retry) fillReview(item.record);
      else if (changed && item?.review) fillReview(item.review);
      render();
      if (context.visible && item && !item.attempted && !item.record) void review();
      if (item?.record && !terminalStates.has(item.record.state)) void refresh();
      schedule();
    }

    async function submit() {
      const id = selectedRun;
      const item = current();
      if (!item || part("submit").disabled || !form.reportValidity()) return;
      const values = inputs => Object.fromEntries([...inputs].map(([key, element]) => [key, element.valueAsNumber]));
      const body = {inputs: item.review.inputs, settings: values(settingsInputs), resources: values(resourceInputs)};
      item.submitting = true;
      item.retry = false;
      item.error = "";
      render();
      try {
        accept(item, await request(`/signet/runs/${encodeURIComponent(id)}/expression/example`, body), id);
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
    };
  };
})();
