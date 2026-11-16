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
})();
