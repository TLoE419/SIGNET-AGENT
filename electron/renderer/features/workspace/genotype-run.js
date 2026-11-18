(() => {
  "use strict";

  const exampleDataset = "example-chr1";
  const examplePath = "/signet/genotype/example";
  const sourceKinds = ["genotype", "expression", "clinical"];
  const exampleInputs = {genotype: ["study.ped", "study.map"], expression: ["example_gexp"], clinical: ["official-demo-chr1-restart-clinical.tsv"]};
  const sourceKey = inputs => JSON.stringify(sourceKinds.map(kind => inputs?.[kind] ?? []));
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
    sourceInputs: ["這筆執行會保存的資料組檔案", "Dataset files saved with this run"],
    genotype: ["基因型資料", "Genotype data"], expression: ["基因表現量資料", "Expression data"], clinical: ["臨床資料", "Clinical data"],
    warnings: ["執行前需要確認", "Review before running"],
    acknowledge: ["我已核對以上檔案與警示，並確認表現量尺度及最後五列的處理方式。", "I reviewed these files and warnings, including the expression scale and treatment of its final five rows."],
    customReview: ["核對資料組檔案", "Review dataset files"],
    customChecking: ["正在核對資料組檔案…", "Reviewing dataset files…"],
    customUnavailable: ["資料組尚未就緒", "The dataset is not ready"],
    customInputs: ["第 1 階段輸入檔案", "Stage 1 input files"],
    stale: ["檔案或遠端環境已變更，請重新核對後再送出。", "The files or remote context changed. Review again before submitting."],
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
    cancel: ["取消工作", "Cancel job"],
    cancelConfirm: ["確認取消這個工作", "Confirm cancellation"],
    cancelDismiss: ["保留工作", "Keep job"],
    cancelSending: ["正在送出取消要求…", "Requesting cancellation…"],
    cancelWaiting: ["等待遠端確認本階段與相關子工作都已停止。", "Waiting for the remote scheduler to confirm this stage and its child jobs have stopped."],
    cancelUnconfirmed: ["取消結果待確認。請重新查詢狀態，不代表工作已停止。", "Cancellation outcome is unconfirmed. Refresh status; the job has not been confirmed stopped."],
    cancelDisconnected: ["請先連線，才能取消這個工作。", "Connect before cancelling this job."],
    cancelChanged: ["工作或遠端連線已變更，請重新查詢後再核對取消對象。", "The job or remote connection changed. Refresh status and review the cancellation target again."],
    cancelAttempt: ["嘗試次數", "Attempt"],
    retry: ["核對新的嘗試", "Review a new attempt"],
    retryReview: ["重新核對重試檔案", "Recheck retry files"],
    retryChecking: ["正在核對這筆執行的原始檔案…", "Checking this run’s original files…"],
    retrySubmit: ["送出第 1 階段重試", "Submit Stage 1 again"],
    retryDismiss: ["保留目前嘗試", "Keep current attempt"],
    retryInputs: ["本次重試的輸入檔案", "Inputs for this retry"],
    retryReady: ["核對原檔案、設定與警示後，手動送出同一筆執行的新嘗試。", "Review the original files, settings and warnings, then manually submit a new attempt in this same run."],
    retryAcknowledge: ["我已核對原始檔案、本次設定與重試警示。", "I reviewed the original files, these settings and the retry warnings."],
    retryStale: ["重試核對已失效，請重新核對這筆執行。", "The retry review is no longer valid. Review this run again."],
  };

  const cancellationBusy = item => Boolean(item?.cancellation?.sending || item?.cancellation?.awaiting || item?.record?.state === "cancelling");
  const cancellationMarkup = prefix => `<button type="button" class="ml-nav-action" data-${prefix}-cancel hidden></button>
    <div class="ml-job-cancel-confirmation" data-${prefix}-cancel-confirmation hidden>
      <p data-${prefix}-cancel-target></p>
      <button type="button" class="ml-nav-action" data-${prefix}-cancel-confirm></button>
      <button type="button" class="ml-nav-action" data-${prefix}-cancel-dismiss></button>
    </div><p class="ml-genotype-notice" data-${prefix}-cancel-notice role="status" hidden></p>`;

  function mountCancellation({panel, prefix, stage, local, target, request, receive, render, schedule}) {
    const part = name => panel.querySelector(`[data-${prefix}-${name}]`);
    let remote = {connected: false, identity: "", environmentKey: ""};
    let previousItem;
    const scope = () => JSON.stringify(remote);
    const snapshot = value => ({runId: value.runId, datasetId: value.datasetId, jobId: String(value.item.record.job_id), attempt: value.item.record.attempt ?? 1, scope: scope()});
    const matches = (value, saved) => value?.runId === saved.runId && value.datasetId === saved.datasetId && String(value.item?.record?.job_id) === saved.jobId &&
      (value.item?.record?.attempt ?? 1) === saved.attempt;
    const eligible = value => Boolean(value?.item && value.visible && value.run?.source === "live" && value.run.origin === "workspace" &&
      value.run.capabilities?.continue_analysis === true && !value.item.submitting && !value.item.uncertain && !value.item.retry &&
      /^\d+$/.test(String(value.item.record?.job_id ?? "")) && ["submitted", "pending", "running", "validating", "unknown", "cancelling"].includes(value.item.record?.state));
    function sync() {
      const value = target(), item = value?.item;
      if (previousItem && previousItem !== item && previousItem.cancellation) previousItem.cancellation.confirmation = null;
      previousItem = item;
      const state = item?.cancellation;
      if (state?.confirmation && (!eligible(value) || !matches(value, state.confirmation) || state.confirmation.scope !== scope())) state.confirmation = null;
      part("cancel").textContent = local("cancel");
      part("cancel").hidden = !eligible(value);
      part("cancel").disabled = !remote.connected || cancellationBusy(item) || Boolean(state?.confirmation);
      part("cancel-confirmation").hidden = !state?.confirmation;
      part("cancel-confirm").textContent = local("cancelConfirm");
      part("cancel-confirm").disabled = !remote.connected || Boolean(state?.sending);
      part("cancel-dismiss").textContent = local("cancelDismiss");
      const confirmed = state?.confirmation;
      part("cancel-target").textContent = confirmed ? `${local("runID")}: ${confirmed.runId} · ${local("stage") || stage} · ${local("jobID")}: ${confirmed.jobId} · ${local("cancelAttempt")}: ${confirmed.attempt}` : "";
      const message = state?.sending ? local("cancelSending") : state?.uncertain ? local("cancelUnconfirmed")
        : item?.record?.state === "cancelling" || state?.awaiting ? local("cancelWaiting") : !remote.connected && eligible(value) ? local("cancelDisconnected") : "";
      part("cancel-notice").textContent = [message, state?.error].filter(Boolean).join(" ");
      part("cancel-notice").hidden = !part("cancel-notice").textContent;
    }
    part("cancel").addEventListener("click", () => {
      const value = target();
      if (!eligible(value) || !remote.connected || cancellationBusy(value.item)) return;
      value.item.cancellation = {confirmation: snapshot(value), sending: false, awaiting: false, uncertain: false, error: ""};
      render();part("cancel-dismiss").focus();
    });
    part("cancel-dismiss").addEventListener("click", () => {
      const item = target()?.item;
      if (item?.cancellation && !item.cancellation.sending) item.cancellation.confirmation = null;
      render();part("cancel").focus();
    });
    part("cancel-confirm").addEventListener("click", async () => {
      const value = target(), item = value?.item, state = item?.cancellation, confirmed = state?.confirmation;
      if (!confirmed || state.sending) return;
      if (!eligible(value) || !remote.connected || confirmed.scope !== scope() || !matches(value, confirmed)) {
        state.confirmation = null;state.error = local("cancelChanged");render();return;
      }
      state.confirmation = null;state.sending = true;state.error = "";
      item.cancelEpoch = (item.cancelEpoch ?? 0) + 1;
      render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(confirmed.runId)}/steps/${prefix}/cancel`,
          {expected_job_id: confirmed.jobId, expected_attempt: confirmed.attempt});
        if (!matches(value, confirmed) || item.cancellation !== state || confirmed.scope !== scope()) throw Error(local("cancelChanged"));
        if (next.run_id !== confirmed.runId || next.step !== prefix || String(next.job_id) !== confirmed.jobId ||
            (next.attempt ?? 1) !== confirmed.attempt) throw Error(local("serviceError"));
        receive(value, next);
        const saved = item.record;
        state.awaiting = !terminalStates.has(saved.state) && (saved.state === "cancelling" || Boolean(saved.cancel_requested_at) || saved.connection === "interrupted");
        state.uncertain = saved.connection === "interrupted";
      } catch (error) {
        if (item.cancellation === state) {
          state.error = error.message;
          state.awaiting = state.uncertain = ![400, 409, 412].includes(error.status);
        }
      } finally {
        state.sending = false;
        render();schedule();
      }
    });
    window.addEventListener("workspace-remote-context", event => {
      const next = {connected: event.detail?.connected === true, identity: event.detail?.identity ?? "", environmentKey: event.detail?.environmentKey ?? ""};
      if (JSON.stringify(next) !== scope() && previousItem?.cancellation) previousItem.cancellation.confirmation = null;
      remote = next;render();
    });
    window.dispatchEvent(new Event("workspace-request-remote-context"));
    return {sync, observe(item, record) {
      const state = item.cancellation;
      if (!state || state.sending || record.connection === "interrupted") return;
      if (terminalStates.has(record.state) || !record.cancel_requested_at && record.state !== "cancelling") {
        state.awaiting = state.uncertain = false;state.error = "";
      }
    }};
  }

  window.mountGenotypeRun = function mountGenotypeRun({panel, token, onHistoryChanged, onOpenHistory, onBack}) {
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main" data-live-language>
        <header>
          <p class="ml-genotype-eyebrow" data-genotype-copy="stage"></p>
          <h2 id="lens-stage1-title" data-genotype-copy="title"></h2>
          <p data-genotype-dataset></p>
        </header>
        <p data-genotype-readiness role="status"></p>
        <p data-genotype-guidance hidden></p>
        <button type="button" class="ml-nav-action" data-genotype-review data-genotype-copy="review"></button>
        <p class="ml-settings-note" data-genotype-retry-context role="status" hidden></p>
        <form data-genotype-form hidden>
          <h3 data-genotype-copy="inputs"></h3>
          <dl class="ml-key-values">
            ${inputKeys.map(key => `<dt data-genotype-copy="${key}"></dt><dd><code data-genotype-input="${key}"></code></dd>`).join("")}
          </dl>
          <section data-genotype-source-section hidden>
            <h3 data-genotype-copy="sourceInputs"></h3><dl class="ml-key-values" data-genotype-source-inputs></dl>
          </section>
          <section data-genotype-warning-section hidden>
            <h3 data-genotype-copy="warnings"></h3><ul data-genotype-warnings></ul>
            <label><input type="checkbox" data-genotype-acknowledge><span data-genotype-copy="acknowledge"></span></label>
          </section>
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
          <button type="button" class="ml-nav-action" data-genotype-retry data-genotype-copy="retry" hidden></button>
          <button type="button" class="ml-nav-action" data-genotype-retry-dismiss data-genotype-copy="retryDismiss" hidden></button>
          <button type="button" class="ml-nav-action" data-genotype-new data-genotype-copy="newRun" hidden></button>
          <button type="button" class="ml-nav-action" data-genotype-back hidden></button>
          ${cancellationMarkup("genotype")}
        </div>
        <div data-genotype-logs></div>
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

    let context = {visible: false, datasetId: "", language: "zh-Hant", runs: []};
    const datasets = new Map();
    let selectedDataset = "";
    let pollTimer;
    let cancellation;
    let logs;
    let remote = {connected: false, identity: "", environmentKey: ""};
    const stateKey = (id, runId = context.runId) => runId ? `run:${id}:${runId}` : `dataset:${id}`;
    const current = () => datasets.get(stateKey(selectedDataset));
    const runFor = item => context.runs?.find(run => run.run_id === item?.runId);
    const localized = (key) => labels[key]?.[context.language === "en" ? 1 : 0] ?? key;
    const authToken = () => typeof token === "function" ? token() : token;
    const cloneInputs = value => Object.fromEntries(sourceKinds.map(kind => [kind, [...(value?.[kind] ?? [])]]));
    const isLegacy = dataset => dataset.id === exampleDataset && (
      sourceKey(dataset.inputs) === sourceKey(exampleInputs) || !dataset.persisted &&
      sourceKey(dataset.inputs) === sourceKey({genotype: exampleInputs.genotype, expression: [], clinical: []}));
    const datasetValue = () => context.dataset ?? {id: context.datasetId, name: labels.example,
      inputs: cloneInputs(exampleInputs), persisted: false, ready: true};
    const scopeFor = dataset => JSON.stringify([dataset.id, sourceKey(dataset.inputs), remote.connected, remote.identity, remote.environmentKey]);
    const retryScopeFor = (item, datasetId = selectedDataset) => JSON.stringify([datasetId, item.runId, item.record?.job_id ?? null, item.record?.attempt ?? 1, remote]);
    function retryable(item) {
      const run = runFor(item);
      return Boolean(item?.runId && context.visible && run?.source === "live" && run.origin === "workspace" && run.capabilities?.continue_analysis === true &&
        ["failed", "cancelled"].includes(item.record?.state) && !item.submitting && !item.uncertain && !cancellationBusy(item) &&
        Number.isInteger(item.record?.attempt ?? 1) && (item.record?.attempt ?? 1) > 0);
    }
    function clearRetry(item) {
      if (!item?.retry || item.submitting) return;
      invalidate(item, true);item.retry = false;item.retryTarget = null;item.reviewError = localized("retryStale");
    }
    function stateFor(id) {
      const key = stateKey(id);
      if (!datasets.has(key)) datasets.set(key, {review: null, reviewing: false, attempted: false, runId: "", record: null,
        submitting: false, polling: false, error: "", reviewError: "", uncertain: false, acknowledged: false,
        draft: null, preparedNew: false, reviewRequest: null, statusRequest: null, sourceInputs: null, legacy: false, scope: "", inputKey: ""});
      return datasets.get(key);
    }
    function saveDraft(item = current()) {
      if (!item || item.runId && !item.retry || item.reviewing || !item.review && !item.draft) return;
      item.draft = {settings: Object.fromEntries([...settingsInputs].map(([key, input]) => [key, input.value])),
        resources: Object.fromEntries([...resourceInputs].map(([key, input]) => [key, input.value]))};
    }
    function invalidate(item, clearDraft = false) {
      item.reviewRequest?.abort();item.reviewRequest = null;
      item.review = null;item.reviewing = false;item.attempted = false;item.acknowledged = false;
      item.reviewError = localized("stale");
      if (clearDraft) item.draft = null;
    }
    async function request(path, body, signal) {
      const headers = {"X-Chat-Token": authToken()};
      const options = {headers, signal};
      if (body) {headers["Content-Type"] = "application/json";Object.assign(options, {method: "POST", body: JSON.stringify(body)});}
      const response = await fetch(path, options);
      const value = await response.json().catch(() => null);
      if (!response.ok || !value) throw Object.assign(new Error(value?.error || value?.reason || localized("serviceError")), {status: response.status, code: value?.code});
      return value;
    }
    function fillReview(value, item, keepDraft = false) {
      const paths = value.inputs ?? {};
      const chromosome = value.settings?.["restrict.tcga.geno"] ?? "1";
      for (const [key, element] of inputs) {
        const prefix = item.runId || item.legacy;
        const suffix = prefix && key === "ref" ? `${chromosome}.gen` : prefix && key === "gmap" ? `${chromosome}.map` : "";
        element.textContent = paths[key] ? paths[key] + suffix : "—";
      }
      for (const [key, input] of settingsInputs) {
        input.value = keepDraft && key !== "restrict.tcga.geno" && item.draft ? item.draft.settings[key] : value.settings?.[key] ?? "";
        if (key === "restrict.tcga.geno" && Number.isFinite(Number(chromosome))) input.min = input.max = chromosome;
      }
      for (const [key, input] of resourceInputs) {
        if (value.limits?.[key]) [input.min, input.max] = value.limits[key];
        input.value = keepDraft && item.draft ? item.draft.resources[key] : value.resources?.[key] ?? "";
      }
    }
    function render() {
      const item = current();
      for (const element of panel.querySelectorAll("[data-genotype-copy]")) element.textContent = localized(element.dataset.genotypeCopy);
      const dataset = datasetValue();
      part("dataset").textContent = dataset.name?.[context.language === "en" ? 1 : 0] ?? selectedDataset;
      const legacy = item?.runId ? item.runLegacy : isLegacy(dataset);
      const retry = Boolean(item?.retry);
      reviewButton.textContent = localized(retry ? "retryReview" : legacy ? "review" : "customReview");
      submitButton.textContent = localized(retry ? "retrySubmit" : "submit");
      form.querySelector('h3[data-genotype-copy="inputs"]').textContent = localized(retry ? "retryInputs" : legacy ? "inputs" : "customInputs");
      panel.dataset.genotypeRetryState = retry ? item.reviewing ? "reviewing" : item.submitting ? "submitting" : item.review?.ready ? "ready" : "review" : "idle";
      const state = item?.submitting ? "submitting" : item?.uncertain ? "unknown" : item?.record?.state ?? (item?.runId ? "unknown" : "idle");
      panel.dataset.genotypeState = state;
      panel.dataset.genotypeDatasetId = selectedDataset;
      if (item?.runId) panel.dataset.genotypeRunId = item.runId;else delete panel.dataset.genotypeRunId;
      const eligible = Boolean(item?.runId) || Boolean(dataset.ready && (legacy || dataset.persisted));
      const connected = retry ? remote.connected : legacy || remote.connected;
      const terminal = terminalStates.has(state);
      const validReview = Boolean(item?.review) && item.review.ready !== false &&
        (!retry && legacy || item.review.ready === true && typeof item.review.review_token === "string" && item.review.review_token.length > 0);
      statusLine.textContent = localized(state);
      if (item?.cancellation?.sending) statusLine.textContent = localized("cancelSending");
      reviewButton.hidden = !eligible || Boolean(item?.runId && !retry);
      reviewButton.disabled = !connected || Boolean(item?.reviewing || item?.submitting);
      readiness.hidden = !eligible || Boolean(item?.runId && !retry);
      readiness.textContent = localized(item?.reviewing ? retry ? "retryChecking" : legacy ? "checking" : "customChecking" : validReview ? "ready" : item?.attempted ? legacy ? "unavailable" : "customUnavailable" : legacy ? "review" : "customReview");
      guidance.hidden = !eligible || Boolean(item?.runId && !retry);
      guidance.textContent = validReview ? localized(retry ? "retryReady" : "readyPrompt") : !connected ? localized("connect") : "";
      form.hidden = !eligible || !Boolean(item?.review || item?.record?.inputs);
      for (const field of fields) field.disabled = Boolean(item?.runId && !retry || item?.reviewing || item?.submitting || retry && !validReview);
      submitButton.hidden = Boolean(item?.runId && !retry);
      submitButton.disabled = !eligible || !connected || !validReview || Boolean(item?.reviewing || item?.submitting || item?.uncertain || item?.runId && !retry) || (!legacy || retry) && !item?.acknowledged;
      statusButton.hidden = !item?.runId || terminal && !retry;statusButton.disabled = Boolean(item?.submitting || item?.polling || item?.cancellation?.sending);
      historyButton.hidden = !item?.record;newButton.hidden = !terminal || Boolean(context.runId);
      newButton.disabled = cancellationBusy(item);
      part("retry").hidden = !retryable(item) || retry;
      part("retry").disabled = !remote.connected;
      part("retry-dismiss").hidden = !retry;
      part("retry-dismiss").disabled = Boolean(item?.submitting);
      part("retry-context").hidden = !retry;
      const nextAttempt = item?.review?.next_attempt ?? (item?.record?.attempt ?? 1) + 1;
      part("retry-context").textContent = !retry ? "" : context.language === "en"
        ? `Same run: ${item.runId} · Previous attempt: ${item.record?.attempt ?? 1} · Next attempt: ${nextAttempt}. Original files and chromosome stay fixed.`
        : `沿用執行：${item.runId} · 前次嘗試：${item.record?.attempt ?? 1} · 下次嘗試：${nextAttempt}。原檔案與染色體固定。`;
      part("back").hidden = !context.runId;
      part("back").textContent = context.language === "en" ? "Back to run timeline" : "回到執行時間線";
      identifiers.hidden = !item?.runId;runLabel.textContent = item?.runId ?? "";jobLabel.textContent = item?.record?.job_id ?? "—";
      notice.textContent = [item?.uncertain ? localized("uncertain") : "", item?.error || item?.reviewError].filter(Boolean).join(" ");notice.hidden = !notice.textContent;
      const sourceInputs = item?.sourceInputs ?? item?.review?.source_inputs;
      part("source-section").hidden = !sourceInputs;
      const sourceList = part("source-inputs");sourceList.replaceChildren();
      if (sourceInputs) for (const kind of sourceKinds) {
        const title = document.createElement("dt"), paths = document.createElement("dd");
        title.textContent = localized(kind);paths.dataset.genotypeSourceInput = kind;
        for (const path of sourceInputs[kind] ?? []) {const code = document.createElement("code");code.textContent = path;paths.append(code, document.createElement("br"));}
        if (!paths.childElementCount) paths.textContent = "—";
        sourceList.append(title, paths);
      }
      const warningList = part("warnings");warningList.replaceChildren();
      for (const message of item?.review?.warnings ?? []) {
        const row = document.createElement("li");row.dataset.genotypeWarning = "";row.textContent = message;warningList.append(row);
      }
      part("warning-section").hidden = !item?.review || !retry && (legacy || Boolean(item?.runId));
      form.querySelector('[data-genotype-copy="acknowledge"]').textContent = localized(retry ? "retryAcknowledge" : "acknowledge");
      const acknowledge = part("acknowledge");acknowledge.checked = Boolean(item?.acknowledged);acknowledge.disabled = Boolean(item?.runId && !retry || item?.reviewing || item?.submitting || retry && !validReview);
      events.replaceChildren(...(item?.record?.history ?? []).map(({state: eventState, at}) => {
        const row = document.createElement("li");row.dataset.state = eventState;row.textContent = localized(eventState);
        if (at) {const time = document.createElement("time");time.dateTime = at;const date = new Date(at);time.textContent = Number.isNaN(date.valueOf()) ? at : date.toLocaleString(context.language);row.append(time);}
        return row;
      }));events.hidden = !events.children.length;
      cancellation?.sync();
      const run = context.runs?.find(run => run.run_id === item?.runId);
      logs?.setContext({historyId: run?.history_id, runId: item?.runId, source: run?.source, datasetId: selectedDataset,
        step: "genotype", number: item?.record?.attempt ?? 1, current: true, recordFile: "steps/genotype.json",
        recordIdentity: run?.record_identity, record: item?.record, language: context.language, visible: context.visible});
    }
    function matchesRetryRecord(record, target) {
      return record.run_id === target.runId && String(record.job_id ?? "none") === target.jobId && (record.attempt ?? 1) === target.attempt &&
        ["failed", "cancelled"].includes(record.state);
    }
    async function reviewRetry() {
      const item = current(), datasetId = selectedDataset;
      if (!item?.retry || !retryable(item) || !remote.connected || item.reviewing) return;
      saveDraft(item);
      const target = {runId: item.runId, datasetId, jobId: String(item.record.job_id ?? "none"), attempt: item.record.attempt ?? 1,
        scope: retryScopeFor(item)};
      const controller = new AbortController();item.reviewRequest = controller;item.retryTarget = target;
      item.reviewing = item.attempted = true;item.review = null;item.acknowledged = false;item.reviewError = "";item.error = "";render();
      const query = new URLSearchParams({expected_job_id: target.jobId, expected_attempt: String(target.attempt)});
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(target.runId)}/genotype/retry?${query}`, undefined, controller.signal);
        if (controller.signal.aborted || item.reviewRequest !== controller || !item.retry || target.scope !== retryScopeFor(item, datasetId)) return;
        if (next.run_id !== target.runId || next.dataset_id !== datasetId || next.expected_attempt !== target.attempt ||
            String(next.expected_job_id ?? "none") !== target.jobId || next.next_attempt !== target.attempt + 1) throw Error(localized("serviceError"));
        item.review = next;item.sourceInputs = next.source_inputs ?? item.sourceInputs;
        item.reviewError = next.issues?.join(" ") || next.reason || "";
        if (item === current()) fillReview(next, item, Boolean(item.draft));
      } catch (error) {
        if (!controller.signal.aborted && item.reviewRequest === controller) {item.review = null;item.reviewError = error.message;}
      } finally {
        if (item.reviewRequest === controller) {item.reviewRequest = null;item.reviewing = false;if (item === current()) render();}
      }
    }
    async function review() {
      const dataset = datasetValue(), item = current(), id = selectedDataset;
      if (item?.retry) return reviewRetry();
      const legacy = isLegacy(dataset);
      if (!item || item.reviewing || item.runId || !dataset.ready || !(legacy || dataset.persisted && remote.connected)) return;
      saveDraft(item);
      const captured = {id, inputs: cloneInputs(dataset.inputs), scope: scopeFor(dataset)};
      const controller = new AbortController();item.reviewRequest = controller;
      item.reviewing = item.attempted = true;item.reviewError = "";item.review = null;item.acknowledged = false;render();
      try {
        const next = legacy ? await request(examplePath, undefined, controller.signal)
          : await request(`/signet/datasets/${encodeURIComponent(id)}/genotype/review`, {inputs: captured.inputs}, controller.signal);
        if (controller.signal.aborted || item.reviewRequest !== controller || item.scope !== captured.scope || item.runId) return;
        if (!legacy && (next.dataset_id !== id || sourceKey(next.source_inputs) !== sourceKey(captured.inputs))) throw Error(localized("stale"));
        item.review = next;item.legacy = legacy;item.sourceInputs = next.source_inputs ?? (legacy ? null : captured.inputs);
        item.reviewError = next.issues?.join(" ") || next.reason || "";
        if (item === current()) fillReview(next, item, Boolean(item.draft));
      } catch (error) {
        if (!controller.signal.aborted && item.reviewRequest === controller) {item.review = null;item.reviewError = error.message;}
      } finally {
        if (item.reviewRequest === controller) {item.reviewRequest = null;item.reviewing = false;if (item === current()) render();}
      }
    }
    function schedulePoll(item = current(), delay = pollInterval) {
      if (item !== current()) return;
      clearTimeout(pollTimer);
      if (item?.runId && !item.submitting && !item.cancellation?.sending && (!terminalStates.has(item.record?.state) || item.cancellation?.awaiting)) pollTimer = setTimeout(() => void refresh(), delay);
    }
    const recordTime = record => Date.parse(record?.updated_at ?? record?.finished_at ?? record?.submitted_at);
    function olderRecord(next, previous) {
      if (!previous) return false;
      if ((next.attempt ?? 1) !== (previous.attempt ?? 1)) return (next.attempt ?? 1) < (previous.attempt ?? 1);
      return recordTime(next) < recordTime(previous) ||
        previous.state === "cancelling" && !terminalStates.has(next.state) && next.state !== "cancelling" && next.job_id === previous.job_id ||
        terminalStates.has(previous.state) && !terminalStates.has(next.state) && next.job_id === previous.job_id;
    }
    function receiveRecord(item, next, id, datasetId) {
      if (next.run_id !== id || next.step && next.step !== "genotype" || next.dataset_id && next.dataset_id !== datasetId || !Object.hasOwn(labels, next.state)) throw Error(localized("serviceError"));
      if (olderRecord(next, item.record)) return;
      if (item.retry && item.retryTarget && !matchesRetryRecord(next, item.retryTarget)) clearRetry(item);
      const changed = !item.record || next.state !== item.record.state || next.job_id !== item.record.job_id;
      item.record = next;item.uncertain = false;
      cancellation?.observe(item, next);
      item.error = next.connection === "interrupted" ? localized("interrupted") : ["unknown", "validating", "failed"].includes(next.state) ? next.reason || "" : "";
      if (next.source_inputs) item.sourceInputs = next.source_inputs;
      if (item === current() && next.inputs && !item.retry) fillReview(next, item);
      if (changed) onHistoryChanged?.(id, datasetId);
    }
    async function refresh(force = false) {
      const item = current(), datasetId = selectedDataset;
      if (!item?.runId || item.submitting || item.polling || item.cancellation?.sending) return;
      const id = item.runId, statusRequest = {};item.statusRequest = statusRequest;
      const epoch = item.cancelEpoch;
      item.polling = true;clearTimeout(pollTimer);render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/steps/genotype${force ? "?refresh=1" : ""}`);
        if (item.runId === id && epoch === item.cancelEpoch) receiveRecord(item, next, id, datasetId);
      } catch (error) {if (item.runId === id && epoch === item.cancelEpoch) item.error = error.message;}
      finally {
        if (item.statusRequest === statusRequest) {
          item.statusRequest = null;item.polling = false;
          if (item === current()) {render();schedulePoll(item);}
        }
      }
    }
    function restore(id, saved, datasetId = selectedDataset, run) {
      const item = stateFor(datasetId);
      if (item.runId || !id || saved?.dataset_id && saved.dataset_id !== datasetId) return;
      item.reviewError = "";item.error = "";
      item.runId = id;item.runLegacy = run?.input_mode !== "dataset" && datasetId === exampleDataset;
      item.sourceInputs = run?.source_inputs ?? (run?.input_mode === "dataset" ? run.inputs : null) ?? saved?.source_inputs ?? null;
      if (saved?.run_id === id) item.record = saved;
      if (item === current()) {if (item.record?.inputs) fillReview(item.record, item);render();if (!terminalStates.has(item.record?.state)) void refresh();}
    }
    function reset() {
      const item = current();
      if (!item || cancellationBusy(item) || !terminalStates.has(item.record?.state)) return;
      clearTimeout(pollTimer);invalidate(item, true);
      Object.assign(item, {runId: "", record: null, error: "", reviewError: "", uncertain: false,
        preparedNew: true, sourceInputs: null, polling: false, statusRequest: null, cancellation: null, retry: false, retryTarget: null});
      render();if (isLegacy(datasetValue())) void review();
    }
    const readNumbers = elements => Object.fromEntries([...elements].map(([key, input]) => [key, input.valueAsNumber]));
    async function submitRetry() {
      const item = current(), datasetId = selectedDataset, target = item?.retryTarget;
      if (!item?.retry || !retryable(item) || submitButton.disabled || !form.reportValidity()) return;
      if (!target || target.scope !== retryScopeFor(item) || !matchesRetryRecord(item.record, target)) {
        invalidate(item);item.reviewError = localized("retryStale");render();return;
      }
      const body = {inputs: item.review.inputs, settings: {...readNumbers(settingsInputs), "restrict.tcga.geno": Number(item.review.settings["restrict.tcga.geno"])}, resources: readNumbers(resourceInputs),
        review_token: item.review.review_token, expected_job_id: target.jobId, expected_attempt: target.attempt,
        acknowledge_warnings: item.acknowledged};
      item.submitting = true;item.error = "";item.cancelEpoch = (item.cancelEpoch ?? 0) + 1;render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(target.runId)}/genotype/retry`, body);
        if (target.scope !== retryScopeFor(item, datasetId)) throw Error(localized("retryStale"));
        if (next.run_id !== target.runId || next.step !== "genotype" || next.attempt !== target.attempt + 1) throw Error(localized("serviceError"));
        item.retry = false;item.retryTarget = null;item.review = null;item.draft = null;item.acknowledged = false;item.reviewError = "";
        receiveRecord(item, next, target.runId, datasetId);
      } catch (error) {
        item.error = error.message;item.review = null;item.acknowledged = false;
        if (![400, 409, 412].includes(error.status)) {item.retry = false;item.retryTarget = null;item.uncertain = true;}
        onHistoryChanged?.(target.runId, datasetId);
      } finally {item.submitting = false;if (item === current()) {render();schedulePoll(item, 1000);}}
    }
    async function submit() {
      const item = current(), datasetId = selectedDataset;
      if (item?.retry) return submitRetry();
      if (!item || !datasetValue().ready || submitButton.disabled || !form.reportValidity()) return;
      if (item.scope !== scopeFor(datasetValue())) {invalidate(item);render();return;}
      const legacy = item.legacy;
      const id = `${legacy ? "chr1" : "analysis"}-${crypto.randomUUID()}`;
      const body = {run_id: id, inputs: item.review.inputs, settings: readNumbers(settingsInputs), resources: readNumbers(resourceInputs)};
      if (!legacy) Object.assign(body, {review_token: item.review.review_token, acknowledge_warnings: item.acknowledged});
      item.runId = id;item.runLegacy = legacy;item.submitting = true;item.error = "";item.preparedNew = false;render();
      try {
        const next = await request(legacy ? examplePath : `/signet/datasets/${encodeURIComponent(datasetId)}/genotype`, body);
        receiveRecord(item, next, id, datasetId);
      } catch (error) {
        item.error = error.message;
        const refused = [400, 409, 412].includes(error.status) || error.status === 502 && error.code === "remote_failed";
        if (refused) {item.runId = "";item.review = null;item.acknowledged = false;item.reviewError = error.message;onHistoryChanged?.(id, datasetId);}
        else item.uncertain = true;
      } finally {item.submitting = false;if (item === current()) {render();schedulePoll(item, 1000);}}
    }
    form.addEventListener("submit", event => event.preventDefault());
    reviewButton.addEventListener("click", () => void review());
    submitButton.addEventListener("click", () => void submit());
    statusButton.addEventListener("click", () => void refresh(true));
    historyButton.addEventListener("click", () => onOpenHistory?.(current()?.runId));
    newButton.addEventListener("click", reset);
    part("retry").addEventListener("click", () => {
      const item = current();
      if (!retryable(item) || !remote.connected) return;
      item.retry = true;item.review = null;item.draft = null;item.reviewError = "";item.acknowledged = false;
      void reviewRetry();
    });
    part("retry-dismiss").addEventListener("click", () => {
      const item = current();clearRetry(item);
      if (item && !item.submitting) {item.reviewError = "";if (item.record?.inputs) fillReview(item.record, item);}
      render();
    });
    part("back").addEventListener("click", () => onBack?.());
    part("acknowledge").addEventListener("change", () => {if (current()) current().acknowledged = part("acknowledge").checked;render();});
    for (const input of [...settingsInputs.values(), ...resourceInputs.values()]) input.addEventListener("input", () => {input.setCustomValidity("");saveDraft();});
    cancellation = mountCancellation({panel, prefix: "genotype", stage: 1, local: localized, request, render,
      target: () => ({item: current(), runId: current()?.runId, datasetId: selectedDataset, visible: context.visible,
        run: context.runs?.find(run => run.run_id === current()?.runId)}),
      receive: (value, next) => receiveRecord(value.item, next, value.runId, value.datasetId), schedule: () => schedulePoll()});
    logs = window.SignetJobLogs?.mount({host: part("logs"), token});
    function setContext(next) {
      const previous = current();
      const id = next.dataset?.id ?? next.datasetId ?? "";
      if (id !== selectedDataset || next.runId !== context.runId || previous?.retry && context.visible && !next.visible) {
        saveDraft(previous);clearTimeout(pollTimer);
        clearRetry(previous);
        if (previous?.reviewing) {previous.reviewRequest?.abort();previous.reviewRequest = null;previous.reviewing = false;}
      }
      context = next;selectedDataset = id;
      const item = stateFor(id), dataset = datasetValue();
      const inputKey = sourceKey(dataset.inputs), scope = scopeFor(dataset);
      if (!item.runId && item.scope && item.scope !== scope) invalidate(item, item.inputKey !== inputKey);
      item.scope = scope;item.inputKey = inputKey;
      if (!item.runId && !item.preparedNew) {
        const runs = (context.runs ?? []).filter(run => (!run.dataset_id || run.dataset_id === id) && run.jobs?.genotype?.state !== "not_submitted");
        const candidate = context.runId ? runs.find(run => run.run_id === context.runId)
          : runs.find(run => run.jobs?.genotype && !terminalStates.has(run.jobs.genotype.state)) ?? runs.find(run => run.jobs?.genotype);
        if (candidate) restore(candidate.run_id, candidate.jobs.genotype, id, candidate);
      }
      if (item.runId) {
        const saved = (context.runs ?? []).find(run => run.run_id === item.runId)?.jobs?.genotype;
        if (saved && !item.submitting && !item.uncertain && !olderRecord(saved, item.record) &&
          (!item.record || (saved.attempt ?? 1) > (item.record.attempt ?? 1) || recordTime(saved) > recordTime(item.record))) {
          if (item.retry && item.retryTarget && !matchesRetryRecord(saved, item.retryTarget)) clearRetry(item);
          item.record = saved;cancellation?.observe(item, saved);
        }
        if (item.retry && item.review) fillReview(item.review, item, Boolean(item.draft));
        else if (item.record?.inputs && !item.retry) fillReview(item.record, item);
      } else if (item.review) fillReview(item.review, item, Boolean(item.draft));
      render();
      if (context.visible && dataset.ready && isLegacy(dataset) && !item.attempted && !item.runId) void review();
      if (item.runId && !terminalStates.has(item.record?.state)) schedulePoll(item);
    }
    window.addEventListener("workspace-remote-context", event => {
      const value = event.detail ?? {};
      const next = {connected: value.connected === true, identity: value.identity ?? "", environmentKey: value.environmentKey ?? ""};
      const changed = JSON.stringify(next) !== JSON.stringify(remote);
      remote = next;
      if (changed) for (const item of datasets.values()) {
        if (item.retry) clearRetry(item);
        else if (!item.runId && item.scope) invalidate(item);
      }
      if (selectedDataset) setContext(context);
    });
    window.dispatchEvent(new Event("workspace-request-remote-context"));
    render();
    return {setContext, restore};
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

  const networkCopy = {
    title: ["候選網路推論", "Candidate network inference"],
    stage: ["第 5 階段", "Stage 5"],
    run: expressionCopy.run,
    empty: ["先選擇前 4 階段已完成的執行。", "Choose a run with completed Stages 1–4."],
    prerequisite: ["這筆執行的前 4 階段完成後，即可送出第 5 階段。", "Submit Stage 5 after Stages 1–4 complete in this run."],
    readyPrompt: ["核對重抽樣次數、相關性門檻及運算資源後，按「送出第 5 階段」。", "Review bootstrap runs, the correlation threshold and resources, then select Submit Stage 5."],
    submit: ["送出第 5 階段", "Submit Stage 5"],
    review: cisCopy.review,
    checking: cisCopy.checking,
    inputs: cisCopy.inputs,
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    nboots: ["重抽樣次數", "Bootstrap runs"],
    cor: ["工具變異相關性上限", "Instrument correlation limit"],
    correlationNote: ["相關性門檻用於挑選各基因的工具變異。", "The correlation limit selects each gene’s instrumental variants."],
    childResources: ["每個計算工作", "Each compute job"],
    resources: ["流程監控工作", "Workflow controller"],
    jobID: ["監控工作編號", "Controller job ID"],
    controllerNote: ["監控工作會持續等待遠端計算工作完成，請保留足夠的執行時間。", "The controller waits for the compute jobs to finish, so allow enough time for the full workflow."],
    ncores: ["核心數", "CPU cores"],
    memory: ["記憶體（GB）", "Memory (GB)"],
    walltime: ["時間上限（時:分:秒）", "Time limit (H:MM:SS)"],
    positiveCorrelation: ["相關性門檻必須大於 0。", "The correlation threshold must be above 0."],
    defaultsApplied: ["部分既有資源預設值超出支援範圍，請核對目前預填的資源後送出。", "Some saved resource defaults exceed supported ranges. Review the replacement values before submission."],
    phase1: ["第一批模型工作", "First batch of model work items"],
    phase2: ["第二批模型工作", "Second batch of model work items"],
  };

  const visualizationCopy = {
    title: ["網路圖與連線匯出", "Network visualization and export"],
    stage: ["第 6 階段", "Stage 6"],
    run: expressionCopy.run,
    empty: ["先選擇前 5 階段已完成的執行。", "Choose a run with completed Stages 1–5."],
    prerequisite: ["這筆執行的前 5 階段完成後，即可送出第 6 階段。", "Submit Stage 6 after Stages 1–5 complete in this run."],
    readyPrompt: ["核對出現頻率門檻與子網路數後，按「送出第 6 階段」。", "Review the frequency threshold and subnetwork count, then select Submit Stage 6."],
    submit: ["送出第 6 階段", "Submit Stage 6"],
    review: ["檢查網路與門檻", "Check network and thresholds"],
    checking: ["正在核對網路與門檻…", "Checking network and thresholds…"],
    inputs: cisCopy.inputs,
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    freq: ["連線出現頻率門檻", "Edge frequency threshold"],
    ntop: ["顯示的子網路數", "Subnetworks to display"],
    savedResults: ["已儲存網路圖", "Saved networks"],
  };

  function mountContinuationRun({panel, token, onHistoryChanged, onOpenHistory, onBack, onShowResults}, step = "expression") {
    const adjustment = step === "adjust";
    const cis = step === "cis";
    const network = step === "network";
    const visualization = step === "visualize";
    const linkedInputs = cis || network || visualization;
    const alwaysVisible = adjustment || linkedInputs;
    const prefix = step;
    const stage = visualization ? 6 : network ? 5 : cis ? 4 : adjustment ? 3 : 2;
    const copy = visualization ? visualizationCopy : network ? networkCopy : cis ? cisCopy : adjustment ? adjustmentCopy : expressionCopy;
    const parameterGroup = adjustment ? "options" : "settings";
    const parameterAttribute = adjustment ? "option" : "setting";
    const parameterDefinitions = visualization ? [
      {key: "freq", label: "freq", min: 0, max: 1, value: 0.45, step: "any"},
      {key: "ntop", label: "ntop", min: 1, max: 100, value: 1, step: 1},
    ] : network ? [
      {key: "nboots", label: "nboots", min: 1, max: 1000, value: 100, step: 1},
      {key: "cor", label: "cor", min: 0, max: 1, value: 0.3, step: "any"},
      {key: "ncis", label: "ncis", min: 1, max: 10, value: 3, step: 1},
      {key: "ncores", label: "ncores", min: 1, max: 64, value: 16, step: 1},
      {key: "memory", label: "memory", min: 1, max: 128, value: 32, step: 1},
      {key: "walltime", label: "walltime", value: "4:00:00", type: "text"},
    ] : cis ? [
      {key: "alpha.cis", label: "alpha.cis", min: 0, max: 1, value: 0.05, step: "any"},
      {key: "downstream", label: "downstream", min: 0, max: 10_000_000, value: 1000, step: 1},
      {key: "upstream", label: "upstream", min: 0, max: 10_000_000, value: 1000, step: 1},
      {key: "nperms", label: "nperms", min: 1, max: 100_000, value: 100, step: 1},
    ] : [{key: adjustment ? "npc" : "restrict.tcga", label: adjustment ? "npc" : "chromosome",
      min: adjustment ? 0 : 1, max: adjustment ? 10 : 1, value: adjustment ? 3 : 1, step: 1}];
    const initialResources = visualization ? {cpus: 2, mem_gb: 16, hours: 1}
      : network ? {cpus: 2, mem_gb: 16, hours: 24}
      : cis ? {cpus: 8, mem_gb: 32, hours: 4} : {cpus: 4, mem_gb: 16, hours: 2};
    const fileKeys = linkedInputs ? [] : adjustment ? ["cli.file"] : ["gexp.file", "pmap.file"];
    const parameterMarkup = definitions => definitions.map(({key, label, min, max, value, step: increment, type = "number"}) => `<label>
      <span data-${prefix}-copy="${label}"></span>
      <input type="${type}" data-${prefix}-${parameterAttribute}="${key}" ${type === "number" ? `min="${min}" max="${max}" step="${increment}"` : 'pattern="[0-9]{1,2}:[0-5][0-9]:[0-5][0-9]" placeholder="4:00:00"'} value="${value}" ${alwaysVisible ? 'required' : 'readonly'}>
    </label>`).join("");
    panel.classList.add("ml-expression-panel");
    if (adjustment) panel.classList.add("ml-adjust-panel");
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main" data-live-language>
        <header><p class="ml-genotype-eyebrow" data-${prefix}-copy="stage"></p>
          <h2 id="${visualization ? 'lens-stage6-run-title' : `lens-stage${stage}-title`}" data-${prefix}-copy="title"></h2></header>
        <label class="ml-expression-run-label"><span data-${prefix}-copy="run"></span>
          <select data-${prefix}-run></select>
        </label>
        <p data-${prefix}-readiness role="status"></p>
        <p data-${prefix}-guidance></p>
        <button type="button" class="ml-nav-action" data-${prefix}-review data-${prefix}-copy="review"></button>
        <form data-${prefix}-form hidden>
          ${linkedInputs ? '' : `<h3 data-${prefix}-copy="inputs"></h3>`}
          <dl class="ml-key-values" ${linkedInputs ? 'hidden' : ''}>${fileKeys.map(key => `<dt data-${prefix}-copy="${key}"></dt>
            <dd>${adjustment
              ? `<input class="ml-clinical-input" type="text" data-${prefix}-input="${key}" maxlength="2048" required>`
              : `<code data-${prefix}-input="${key}"></code>`}</dd>`).join("")}</dl>
          ${adjustment ? '<p class="ml-settings-note" data-adjust-clinical-summary role="status"></p>' : ''}
          <fieldset data-${prefix}-fields><legend data-${prefix}-copy="settings"></legend>
            <div class="ml-genotype-controls">${parameterMarkup(network ? parameterDefinitions.slice(0, 2) : parameterDefinitions)}</div>
            ${network ? '<input type="number" data-network-setting="ncis" value="3" readonly hidden><p class="ml-settings-note" data-network-copy="correlationNote"></p>' : ''}
          </fieldset>
          ${network ? `<fieldset data-network-fields><legend data-network-copy="childResources"></legend>
            <div class="ml-genotype-controls">${parameterMarkup(parameterDefinitions.slice(3))}</div>
          </fieldset><p class="ml-settings-note" data-network-defaults hidden></p>` : ''}
          <fieldset data-${prefix}-fields><legend data-${prefix}-copy="resources"></legend>
            ${network ? '<p class="ml-settings-note" data-network-copy="controllerNote"></p>' : ''}
            <div class="ml-genotype-controls">${resources.map(key => `<label><span data-${prefix}-copy="${key}"></span>
              <input type="number" data-${prefix}-resource="${key}" step="${key === "hours" ? "any" : "1"}" value="${alwaysVisible ? initialResources[key] : ''}" required>
            </label>`).join("")}</div>
          </fieldset>
          ${linkedInputs ? `<details class="ml-cis-inputs"><summary data-${prefix}-copy="inputs"></summary><dl class="ml-key-values" data-${prefix}-input-sources></dl></details>` : ''}
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
        ${network ? '<dl class="ml-key-values" data-network-work-progress hidden></dl>' : ''}
        <p class="ml-genotype-notice" data-${prefix}-notice role="status" hidden></p>
        <div class="ml-genotype-actions">
          <button type="button" class="ml-nav-action" data-${prefix}-refresh data-${prefix}-copy="refresh" hidden></button>
          <button type="button" class="ml-nav-action" data-${prefix}-history data-${prefix}-copy="history" hidden></button>
          <button type="button" class="ml-nav-action" data-${prefix}-retry data-${prefix}-copy="retry" hidden></button>
          ${cancellationMarkup(prefix)}
          ${visualization ? '<button type="button" class="ml-nav-action" data-visualize-results data-visualize-copy="savedResults"></button>' : ''}
          <button type="button" class="ml-nav-action" data-${prefix}-back data-${prefix}-copy="back" hidden></button>
        </div>
        <div data-${prefix}-logs></div>
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
    let cancellation;
    let logs;
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
      for (const [key, element] of parameterInputs) {
        if (!keepDraft) element.value = value[parameterGroup]?.[key] ?? "";
        if (key === "restrict.tcga" && value.settings?.[key] != null && Number.isFinite(Number(value.settings[key]))) {
          element.value = element.min = element.max = String(value.settings[key]);
        }
      }
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
        (!linkedInputs || source()?.jobs.adjust?.state === "completed") &&
        (!(network || visualization) || source()?.jobs.cis?.state === "completed") &&
        (!visualization || source()?.jobs.network?.state === "completed");
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
      for (const field of fields) field.disabled = hasAttempt || cancellationBusy(item) || !selectedRun || visualization && Boolean(item?.checking);
      if (adjustment) {
        const clinicalInput = panel.querySelector('[data-adjust-input="cli.file"]');
        clinicalInput.disabled = hasAttempt || Boolean(item?.checking) || !selectedRun;
        clinicalInput.readOnly = Boolean(item?.review?.frozen || item?.review?.frozen_inputs || source()?.input_mode === "dataset" || source()?.frozen_inputs);
        const clinical = item?.review?.clinical;
        part("clinical-summary").textContent = clinical
          ? (context.language === "en" ? `${clinical.rows ?? 0} clinical rows · ${(clinical.columns ?? []).join(", ")}`
            : `${clinical.rows ?? 0} 筆臨床資料 · ${(clinical.columns ?? []).join("、")}`) : "";
      }
      if (linkedInputs) {
        const inputSources = saved?.input_sources ?? item?.review?.input_sources ?? source()?.jobs[step]?.input_sources ?? {};
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
      if (network) {
        const defaults = item?.review?.defaults_applied ?? [];
        part("defaults").hidden = !defaults.length || hasAttempt;
        part("defaults").textContent = defaults.length ? local("defaultsApplied") : "";
        part("defaults").title = defaults.join("\n");
        const progress = part("work-progress");
        progress.replaceChildren();
        for (const [key, label] of [["stage1", "phase1"], ["stage2", "phase2"]]) {
          const value = saved?.progress?.[key];
          const match = typeof value === "string" ? value.match(/^(\d+)\s+(\d+)$/) : null;
          if (!match || Number(match[1]) > Number(match[2])) continue;
          const term = document.createElement("dt");
          const count = document.createElement("dd");
          term.textContent = local(label);
          count.textContent = `${match[1]} / ${match[2]}`;
          progress.append(term, count);
        }
        progress.hidden = !progress.childElementCount;
      }
      part("submit").hidden = hasAttempt;
      part("submit").disabled = !allowed || !item?.review || item.review.ready === false || item.checking || item.submitting || hasAttempt || cancellationBusy(item);
      part("status").textContent = local(state);
      if (item?.cancellation?.sending) part("status").textContent = local("cancelSending");
      part("identifiers").hidden = !selectedRun;
      part("run-id").textContent = selectedRun;
      part("job-id").textContent = saved?.job_id ?? "—";
      part("refresh").hidden = !hasAttempt || terminal;
      part("refresh").disabled = Boolean(item?.polling || item?.submitting || item?.cancellation?.sending);
      part("history").hidden = !saved;
      part("retry").hidden = !saved || !["failed", "cancelled"].includes(state) || Boolean(item?.retry || item?.uncertain || cancellationBusy(item));
      part("back").hidden = !context.runId;
      if (visualization) part("results").disabled = !context.resultsAvailable;
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
      cancellation?.sync();
      const run = source();
      logs?.setContext({historyId: run?.history_id, runId: selectedRun, source: run?.source, datasetId: context.datasetId,
        step, number: saved?.attempt ?? 1, current: true, recordFile: `steps/${step}.json`, recordIdentity: run?.record_identity,
        record: saved, language: context.language, visible: context.visible});
    }

    function accept(item, value, id) {
      if (value.run_id !== id || value.step !== step || !Object.hasOwn(labels, value.state)) throw Error(local("serviceError"));
      if (item.record && ((value.attempt ?? 1) < (item.record.attempt ?? 1) ||
          item.record.job_id === value.job_id && (terminalStates.has(item.record.state) && !terminalStates.has(value.state) ||
            item.record.state === "cancelling" && !terminalStates.has(value.state) && value.state !== "cancelling"))) return;
      const changed = !item.record || value.state !== item.record.state || value.job_id !== item.record.job_id;
      item.record = value;
      cancellation?.observe(item, value);
      item.uncertain = false;
      item.retry = false;
      item.error = value.connection === "interrupted" ? local("interrupted") : value.reason ?? "";
      if (id === selectedRun && value.inputs) fillReview(value);
      if (changed) onHistoryChanged?.(id);
    }

    function schedule() {
      clearTimeout(pollTimer);
      const item = current();
      if (item && !item.submitting && !item.cancellation?.sending && (item.uncertain || item.cancellation?.awaiting || item.record && !terminalStates.has(item.record.state))) {
        pollTimer = setTimeout(() => void refresh(), pollInterval);
      }
    }

    async function refresh(force = false) {
      const id = selectedRun;
      const item = current();
      if (!id || !item || item.polling || item.submitting || item.cancellation?.sending) return;
      const epoch = item.cancelEpoch;
      item.polling = true;
      render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/steps/${step}${force ? "?refresh=1" : ""}`);
        if (epoch === item.cancelEpoch) accept(item, next, id);
      } catch (error) {
        if (epoch === item.cancelEpoch) item.error = error.message;
      } finally {
        item.polling = false;
        render();
        schedule();
      }
    }

    async function review() {
      const id = selectedRun;
      const item = current();
      if (!id || !item || !source() || item.checking || item.submitting || item.uncertain || cancellationBusy(item) || item.record && !item.retry || !alwaysVisible && source()?.jobs.genotype?.state !== "completed") return;
      item.checking = item.attempted = true;
      item.error = "";
      render();
      try {
        const frozen = adjustment && (item.review?.frozen || item.review?.frozen_inputs || source()?.input_mode === "dataset" || source()?.frozen_inputs);
        const clinicalPath = adjustment && !frozen ? panel.querySelector('[data-adjust-input="cli.file"]').value.trim() : "";
        const params = new URLSearchParams();
        if (clinicalPath) params.set("clinical", clinicalPath);
        if (visualization && item.draft) {
          for (const [key, input] of parameterInputs) params.set(key,
            Number.isFinite(input.valueAsNumber) ? String(input.valueAsNumber) : input.value);
        }
        const query = params.size ? `?${params}` : "";
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/${step}/example${query}`);
        const preserve = adjustment || (linkedInputs ? Boolean(item.draft) : item.review && fileKeys.every(key => item.review.inputs[key] === next.inputs[key]));
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
      if (received) {item.record = saved;cancellation?.observe(item, saved);}
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
      if (network) {
        const correlation = parameterInputs.get("cor");
        correlation.setCustomValidity(correlation.valueAsNumber > 0 ? "" : local("positiveCorrelation"));
      }
      if (!form.reportValidity()) return;
      const values = inputs => Object.fromEntries([...inputs].map(([key, element]) =>
        [key, element.type === "number" ? element.valueAsNumber : element.value.trim()]));
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
      input.addEventListener("input", () => {
        input.setCustomValidity("");
        if (visualization && [...parameterInputs.values()].includes(input)) {
          const item = current();
          if (item && (!item.record || item.retry)) {
            item.review = null;
            item.attempted = true;
            item.error = "";
          }
        }
        saveDraft();
        if (visualization) render();
      });
    }
    picker.addEventListener("change", () => selectRun(picker.value));
    cancellation = mountCancellation({panel, prefix, stage, local, request, render, schedule,
      target: () => ({item: current(), runId: selectedRun, datasetId: context.datasetId, visible: context.visible, run: source()}),
      receive: (value, next) => accept(value.item, next, value.runId)});
    logs = window.SignetJobLogs?.mount({host: part("logs"), token});
    part("review").addEventListener("click", () => void review());
    part("submit").addEventListener("click", () => void submit());
    part("refresh").addEventListener("click", () => void refresh(true));
    part("history").addEventListener("click", () => onOpenHistory?.(selectedRun));
    part("back").addEventListener("click", () => onBack?.());
    if (visualization) part("results").addEventListener("click", () => onShowResults?.());
    part("retry").addEventListener("click", () => {
      const item = current();
      if (!item || item.uncertain || item.submitting || cancellationBusy(item) || !["failed", "cancelled"].includes(item.record?.state)) return;
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
  window.mountNetworkRun = options => mountContinuationRun(options, "network");
  window.mountVisualizationRun = options => mountContinuationRun(options, "visualize");

})();
