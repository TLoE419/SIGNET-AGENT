(() => {
  "use strict";

  const exampleDataset = "example-chr1";
  const examplePath = "/signet/genotype/example";
  const sourceKinds = ["genotype", "expression", "clinical"];
  const exampleInputs = {genotype: ["study.ped", "study.map"], expression: ["example_gexp"], clinical: ["official-demo-chr1-restart-clinical.tsv"]};
  const sourceKey = inputs => JSON.stringify(sourceKinds.map(kind => inputs?.[kind] ?? []));
  const terminalStates = new Set(["completed", "failed", "cancelled"]);
  const pollInterval = 15_000;
  const workLabels = {
    imputation: "Imputation chunks", expression_outputs: "Expression preparation",
    variant_filter: "Variant filtering", low_frequency: "Low-frequency jobs",
    rare_variants: "Rare-variant jobs", stage1: "Network phase 1",
    stage2: "Network phase 2", subnetworks: "Subnetwork exports",
  };
  const activityHints = {
    submitted: "Waiting for the scheduler to confirm the job.",
    pending: "Waiting for the scheduler to start the job.",
    running: "Measured progress will appear when work counts are available.",
    validating: "Waiting for output verification.",
  };
  function renderWorkProgress(container, record, state, error, disconnected) {
    container.replaceChildren();
    const progress = record?.progress;
    for (const [key, label] of Object.entries(workLabels)) {
      const match = typeof progress?.[key] === "string" ? progress[key].match(/^(\d+)\s+(\d+)$/) : null;
      if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 0 || Number(match[1]) > Number(match[2])) continue;
      const term = document.createElement("dt"), count = document.createElement("dd"), bar = document.createElement("progress");
      term.textContent = label;count.textContent = `${match[1]} / ${match[2]} `;
      bar.max = Number(match[2]);bar.value = Number(match[1]);bar.setAttribute("aria-label", term.textContent);
      count.append(bar);container.append(term, count);
    }
    const hint = Object.hasOwn(activityHints, state) ? activityHints[state] : "";
    const confirmedStatus = !disconnected && record?.connection !== "interrupted" && !record?.status_check_issue &&
      (!error || error === record?.reason);
    if (!container.childElementCount && hint && confirmedStatus) {
      const term = document.createElement("dt"), detail = document.createElement("dd");
      const bar = document.createElement("progress"), note = document.createElement("small");
      term.textContent = "Job activity";
      bar.setAttribute("aria-label", hint);
      note.className = "ml-progress-hint";
      note.textContent = hint;
      detail.append(bar, note);container.append(term, detail);
    }
    container.hidden = !container.childElementCount;
  }
  const inputKeys = ["ped.file", "map.file", "ref", "gmap"];
  const parameters = [
    ["restrict.tcga.geno", 1, 1, 1], ["mind", 0, 1, "any"], ["geno", 0, 1, "any"],
    ["hwe", 0, 1, "any"], ["int", 1, 100_000_000, 1],
  ];
  const resources = ["cpus", "mem_gb", "hours"];
  const labels = {
    title: "Genotype preparation",
    stage: "Stage 1",
    example: "Chromosome 1 example",
    review: "Check example files",
    checking: "Checking example files…",
    reviewAgain: "Recheck files",
    reviewTimeout: "Checking the remote files timed out. Select Recheck files to try again.",
    ready: "Ready to review and submit",
    reviewReady: "Ready for review",
    loadInputs: "Check the input files",
    loadInputsPrompt: "Check that the selected files are available before reviewing the settings.",
    chooseDataset: "Open Data to select or create a dataset for Stage 1.",
    saveDataset: "Save this dataset in Data before preparing Stage 1.",
    catalogLoading: "Loading the dataset catalog…",
    catalogUnavailable: "Could not load the dataset catalog. Retry in Run history.",
    unavailable: "The example is not ready",
    readyPrompt: "Review the files and settings, then select Submit Stage 1.",
    genotypeReadyPrompt: "Confirm the files, settings, and any warnings before submitting.",
    connect: "Connect and verify the environment in Settings → Remote compute, then review the input files again.",
    inputs: "Example inputs",
    sourceInputs: "Dataset files retained with the run",
    pendingSourceInputs: "Dataset files to retain with this run",
    genotype: "Genotype data", expression: "Expression data", clinical: "Clinical data",
    reference: "Imputation reference panel", genetic_map: "Genetic map",
    annotation: "Gene annotation",
    warnings: "Review before running",
    acknowledge: "I reviewed these files and warnings, including the expression scale and treatment of its final five rows.",
    customReview: "Review dataset files",
    customChecking: "Reviewing dataset files…",
    customUnavailable: "The dataset is not ready",
    customInputs: "Stage 1 input files",
    stale: "The files or remote context changed. Review again before submitting.",
    settings: "Settings",
    resources: "Resources",
    genotypeSettings: "Genotype settings",
    genotypeResources: "Compute resources",
    submit: "Submit Stage 1",
    refresh: "Refresh status",
    history: "View run history",
    newRun: "Prepare a new run",
    runID: "Run ID",
    jobID: "Scheduler job ID",
    progress: "Run progress",
    "ped.file": "Genotype file",
    "map.file": "Variant map",
    ref: "Imputation reference",
    gmap: "Genetic map",
    "restrict.tcga.geno": "Chromosome",
    mind: "Max. sample missingness",
    geno: "Max. variant missingness",
    hwe: "HWE cutoff",
    int: "Imputation chunk length (bp)",
    cpus: "CPU cores",
    mem_gb: "Memory (GB)",
    hours: "Time limit (hours)",
    idle: "Not submitted",
    submitting: "Submitting",
    submitted: "Submitted, waiting for scheduler status",
    pending: "Queued",
    running: "Running",
    validating: "Checking and collecting results",
    completed: "Completed",
    cancelling: "Cancelling",
    cancelled: "Cancelled",
    failed: "Failed",
    unknown: "Status unconfirmed",
    interrupted: "Connection interrupted. Showing the last confirmed status.",
    output_source_mismatch: "The remote job folder or files do not match the saved run. Showing the last confirmed status.",
    output_check_timeout: "Reading remote job files timed out. Showing the last confirmed analysis status.",
    schedulerState: "Scheduler state",
    uncertain: "Submission outcome is unconfirmed. Check this run’s status.",
    serviceError: "Could not read the local service.",
    cancel: "Cancel job",
    cancelConfirm: "Confirm cancellation",
    cancelDismiss: "Keep job",
    cancelSending: "Requesting cancellation…",
    cancelWaiting: "Waiting for the remote scheduler to confirm this stage and its child jobs have stopped.",
    cancelUnconfirmed: "Cancellation outcome is unconfirmed. Refresh status; the job has not been confirmed stopped.",
    cancelDisconnected: "Connect before cancelling this job.",
    cancelChanged: "The job or remote connection changed. Refresh status and review the cancellation target again.",
    cancelAttempt: "Attempt",
    retry: "Review a new attempt",
    retryReview: "Recheck retry files",
    retryChecking: "Checking this run’s original files…",
    retrySubmit: "Submit Stage 1 again",
    retryDismiss: "Keep current attempt",
    retryInputs: "Inputs for this retry",
    retryReady: "Review the original files, settings and warnings, then manually submit a new attempt in this same run.",
    retryAcknowledge: "I reviewed the original files, these settings and the retry warnings.",
    retryStale: "The retry review is no longer valid. Review this run again.",
    revalidate: "Recheck outputs",
    revalidating: "Checking existing outputs…",
    revalidatePrompt: "Checks this attempt’s existing outputs without submitting another analysis.",
    revalidateConnect: "Connect before rechecking this attempt’s outputs.",
    revalidateFailed: "Could not complete the output check. Showing the last confirmed state.",
    revalidateCompleted: "Existing outputs passed the technical checks; no analysis was rerun.",
    revalidateWaiting: "Checking or collecting outputs; completion is not yet confirmed.",
    revalidateMissing: "Outputs were rechecked and still did not pass the checks.",
  };

  function connectionNotice(disconnected, state, error) {
    return disconnected && Object.hasOwn(activityHints, state) && error !== labels.interrupted
      ? labels.interrupted : "";
  }

  function statusIssue(record, labelFor) {
    const message = labelFor(record.status_check_issue);
    return record.status_check_issue === "output_check_timeout" && record.slurm_state
      ? `${message} ${labelFor("schedulerState")}: ${record.slurm_state}.` : message;
  }

  const cancellationBusy = item => Boolean(item?.cancellation?.sending || item?.cancellation?.awaiting || item?.record?.state === "cancelling");
  const revalidationBusy = item => Boolean(item?.revalidation?.pending || item?.outputRevalidationActive);
  const outputRevalidationInfo = value => value?.item?.record?.output_revalidation ?? value?.run?.output_revalidation?.[value.step];
  function recordedOutputTransition(previous, next, info) {
    if (previous?.state !== "failed" || !next || next.job_id !== previous.job_id || (next.attempt ?? 1) !== (previous.attempt ?? 1)) return false;
    return next.state === "validating" && info?.active === true || next.state === "completed" && next.original_failure?.state === "failed" &&
      next.output_checks?.at?.(-1)?.outcome === "completed";
  }
  function dropStaleRevalidation(item) {
    const target = item?.revalidation?.target;
    if (target && (String(item.record?.job_id) !== target.jobId || (item.record?.attempt ?? 1) !== target.attempt)) item.revalidation = null;
  }
  const renderedReviewPaths = new WeakMap();
  function showReviewPaths(element, paths, renderFilePath) {
    const key = JSON.stringify(paths);
    if (renderedReviewPaths.get(element) === key) return;
    renderedReviewPaths.set(element, key);
    element.replaceChildren();
    if (!paths.length) element.textContent = "—";
    for (const path of paths) {
      const row = document.createElement("div");
      row.className = "ml-stage-review-path";
      const name = document.createElement("strong");
      name.textContent = renderFilePath ? path.split("/").at(-1) || path : path;
      row.append(name);
      if (renderFilePath && name.textContent !== path) row.append(renderFilePath(path));
      element.append(row);
    }
  }

  const revalidationMarkup = prefix => `<button type="button" class="ml-nav-action" data-${prefix}-revalidate hidden></button>
    <p class="ml-genotype-notice" data-${prefix}-revalidate-notice role="status" hidden></p>`;

  function mountOutputRevalidation({panel, prefix, labelFor, target, request, receive, before, render, schedule, onChanged}) {
    const part = name => panel.querySelector(`[data-${prefix}-${name}]`);
    let remote = {connected: false, identity: "", environmentKey: ""};
    const scope = () => JSON.stringify(remote);
    const workspace = value => value?.run?.source === "live" && value.run.origin === "workspace" && value.run.capabilities?.continue_analysis === true;
    const eligible = value => Boolean(value?.visible && workspace(value) && value.item?.record?.state === "failed" &&
      !value.item.submitting && !value.item.uncertain && !cancellationBusy(value.item) && outputRevalidationInfo(value)?.eligible === true &&
      /^\d+$/.test(String(value.item.record.job_id ?? "")) && Number.isInteger(value.item.record.attempt ?? 1) && (value.item.record.attempt ?? 1) > 0);
    function sync() {
      const value = target(), state = value?.item?.revalidation, info = outputRevalidationInfo(value);
      part("revalidate").hidden = !eligible(value);
      part("revalidate").disabled = !remote.connected || revalidationBusy(value?.item);
      part("revalidate").textContent = labelFor(state?.pending ? "revalidating" : "revalidate");
      const message = state?.pending ? labelFor("revalidating") : state?.error ? `${labelFor("revalidateFailed")} ${state.error}`
        : state?.outcome === "completed" ? labelFor("revalidateCompleted") : info?.active ? labelFor("revalidateWaiting")
          : state?.outcome === "failed" ? `${labelFor("revalidateMissing")} ${value.item.record.reason ?? ""}`
            : eligible(value) ? labelFor(remote.connected ? "revalidatePrompt" : "revalidateConnect")
              : workspace(value) && value.item?.record?.state === "failed" ? info?.reason ?? "" : "";
      part("revalidate-notice").textContent = message;part("revalidate-notice").hidden = !message;
      panel.dataset[`${prefix}RevalidationState`] = state?.pending ? "checking" : state?.error ? "error" : info?.active ? "validating" : state?.outcome ? "checked" : "idle";
    }
    part("revalidate").addEventListener("click", async () => {
      const value = target(), item = value?.item;
      if (!eligible(value) || !remote.connected || revalidationBusy(item)) return;
      const captured = {runId: value.runId, datasetId: value.datasetId, jobId: String(item.record.job_id), attempt: item.record.attempt ?? 1, scope: scope()};
      before(item);
      const state = {pending: true, error: "", outcome: null, target: captured};item.revalidation = state;
      const epoch = item.cancelEpoch = (item.cancelEpoch ?? 0) + 1;item.statusRequest = null;item.polling = false;render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(captured.runId)}/steps/${prefix}/revalidate`,
          {expected_job_id: captured.jobId, expected_attempt: captured.attempt});
        if (scope() !== captured.scope || item.cancelEpoch !== epoch || item.revalidation !== state ||
            item.runId && item.runId !== captured.runId || String(item.record?.job_id) !== captured.jobId ||
            (item.record?.attempt ?? 1) !== captured.attempt) throw Error(labelFor("cancelChanged"));
        if (next.run_id !== captured.runId || next.step !== prefix || String(next.job_id) !== captured.jobId ||
            (next.attempt ?? 1) !== captured.attempt || !["failed", "validating", "completed"].includes(next.state) ||
            next.dataset_id != null && next.dataset_id !== captured.datasetId ||
            typeof next.output_revalidation?.eligible !== "boolean" || typeof next.output_revalidation?.active !== "boolean") throw Error(labelFor("serviceError"));
        if (next.status_check_issue) throw Error(statusIssue(next, labelFor));
        if (next.connection === "interrupted") throw Error(next.reason || labelFor("interrupted"));
        receive(value, next);state.outcome = item.record.state;
      } catch (error) {
        if (item.revalidation === state) {state.error = error.message;onChanged?.(value);}
      } finally {
        state.pending = false;render();schedule();
        if (item.record?.state === "completed" && target()?.item === item && target()?.visible) part("history").focus();
      }
    });
    window.addEventListener("workspace-remote-context", event => {
      remote = {connected: event.detail?.connected === true, identity: event.detail?.identity ?? "", environmentKey: event.detail?.environmentKey ?? ""};
      render();
    });
    window.dispatchEvent(new Event("workspace-request-remote-context"));
    return {sync};
  }
  const cancellationMarkup = prefix => `<button type="button" class="ml-nav-action" data-${prefix}-cancel hidden></button>
    <div class="ml-job-cancel-confirmation" data-${prefix}-cancel-confirmation hidden>
      <p data-${prefix}-cancel-target></p>
      <button type="button" class="ml-nav-action" data-${prefix}-cancel-confirm></button>
      <button type="button" class="ml-nav-action" data-${prefix}-cancel-dismiss></button>
    </div><p class="ml-genotype-notice" data-${prefix}-cancel-notice role="status" hidden></p>`;

  function mountCancellation({panel, prefix, stage, labelFor, target, request, receive, render, schedule}) {
    const part = name => panel.querySelector(`[data-${prefix}-${name}]`);
    let remote = {connected: false, identity: "", environmentKey: ""};
    let previousItem;
    const scope = () => JSON.stringify(remote);
    const snapshot = value => ({runId: value.runId, datasetId: value.datasetId, jobId: String(value.item.record.job_id), attempt: value.item.record.attempt ?? 1, scope: scope()});
    const matches = (value, saved) => value?.runId === saved.runId && value.datasetId === saved.datasetId && String(value.item?.record?.job_id) === saved.jobId &&
      (value.item?.record?.attempt ?? 1) === saved.attempt;
    const eligible = value => Boolean(value?.item && value.visible && value.run?.source === "live" && value.run.origin === "workspace" &&
      value.run.capabilities?.continue_analysis === true && !value.item.submitting && !value.item.uncertain && !value.item.retry && !revalidationBusy(value.item) &&
      /^\d+$/.test(String(value.item.record?.job_id ?? "")) && ["submitted", "pending", "running", "validating", "unknown", "cancelling"].includes(value.item.record?.state));
    function sync() {
      const value = target(), item = value?.item;
      if (previousItem && previousItem !== item && previousItem.cancellation) previousItem.cancellation.confirmation = null;
      previousItem = item;
      const state = item?.cancellation;
      if (state?.confirmation && (!eligible(value) || !matches(value, state.confirmation) || state.confirmation.scope !== scope())) state.confirmation = null;
      part("cancel").textContent = labelFor("cancel");
      part("cancel").hidden = !eligible(value);
      part("cancel").disabled = !remote.connected || cancellationBusy(item) || Boolean(state?.confirmation);
      part("cancel-confirmation").hidden = !state?.confirmation;
      part("cancel-confirm").textContent = labelFor("cancelConfirm");
      part("cancel-confirm").disabled = !remote.connected || Boolean(state?.sending);
      part("cancel-dismiss").textContent = labelFor("cancelDismiss");
      const confirmed = state?.confirmation;
      part("cancel-target").textContent = confirmed ? `${labelFor("runID")}: ${confirmed.runId} · ${labelFor("stage") || stage} · ${labelFor("jobID")}: ${confirmed.jobId} · ${labelFor("cancelAttempt")}: ${confirmed.attempt}` : "";
      const message = state?.sending ? labelFor("cancelSending") : state?.uncertain ? labelFor("cancelUnconfirmed")
        : item?.record?.state === "cancelling" || state?.awaiting ? labelFor("cancelWaiting") : !remote.connected && eligible(value) ? labelFor("cancelDisconnected") : "";
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
        state.confirmation = null;state.error = labelFor("cancelChanged");render();return;
      }
      state.confirmation = null;state.sending = true;state.error = "";
      item.cancelEpoch = (item.cancelEpoch ?? 0) + 1;
      render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(confirmed.runId)}/steps/${prefix}/cancel`,
          {expected_job_id: confirmed.jobId, expected_attempt: confirmed.attempt});
        if (!matches(value, confirmed) || item.cancellation !== state || confirmed.scope !== scope()) throw Error(labelFor("cancelChanged"));
        if (next.run_id !== confirmed.runId || next.step !== prefix || String(next.job_id) !== confirmed.jobId ||
            (next.attempt ?? 1) !== confirmed.attempt) throw Error(labelFor("serviceError"));
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
      if (!state || state.sending || record.connection === "interrupted" || record.status_check_issue) return;
      if (terminalStates.has(record.state) || !record.cancel_requested_at && record.state !== "cancelling") {
        state.awaiting = state.uncertain = false;state.error = "";
      }
    }};
  }

  window.mountGenotypeRun = function mountGenotypeRun({panel, token, renderFilePath, onHistoryChanged, onOpenHistory, onBack}) {
    panel.classList.add("ml-stage-review");
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main">
        <header class="ml-stage-review-header">
          <span class="ml-stage-review-icon" aria-hidden="true"><i data-lucide="dna"></i></span>
          <div>
            <p class="ml-genotype-eyebrow" data-genotype-copy="stage"></p>
            <h2 id="lens-stage1-title" data-genotype-copy="title"></h2>
            <p data-genotype-dataset></p>
          </div>
        </header>
        <div class="ml-stage-review-readiness" data-genotype-review-panel>
          <div>
            <p class="ml-stage-review-status" data-genotype-readiness role="status"></p>
            <p class="ml-stage-review-guidance" data-genotype-guidance hidden></p>
          </div>
          <button type="button" class="ml-nav-action" data-genotype-review data-genotype-copy="review"></button>
          <p class="ml-genotype-notice" data-genotype-notice role="status" hidden></p>
        </div>
        <p class="ml-settings-note" data-genotype-retry-context role="status" hidden></p>
        <form data-genotype-form data-stage-review-form aria-labelledby="lens-stage1-title" hidden>
          <section class="ml-stage-review-files" aria-labelledby="ml-stage-review-files-heading">
            <h3 id="ml-stage-review-files-heading" data-genotype-copy="inputs"></h3>
            <dl class="ml-stage-review-file-list">
              ${inputKeys.map(key => `<div><dt data-genotype-copy="${key}"></dt><dd data-genotype-input="${key}"></dd></div>`).join("")}
            </dl>
          </section>
          <details class="ml-stage-review-source-section" data-genotype-source-section hidden>
            <summary data-genotype-source-label></summary>
            <dl class="ml-stage-review-file-list" data-genotype-source-inputs></dl>
          </details>
          <div class="ml-stage-review-settings">
            <fieldset data-genotype-fields>
              <legend data-genotype-copy="genotypeSettings"></legend>
              <div class="ml-genotype-controls">
                ${parameters.map(([key, min, max, step]) => `
                  <label><span data-genotype-copy="${key}"></span>
                    <input type="number" data-genotype-setting="${key}" min="${min}" max="${max}" step="${step}"
                      ${key === "restrict.tcga.geno" ? "readonly" : "required"}>
                  </label>`).join("")}
              </div>
            </fieldset>
            <fieldset data-genotype-fields>
              <legend data-genotype-copy="genotypeResources"></legend>
              <div class="ml-genotype-controls">
                ${resources.map(key => `
                  <label><span data-genotype-copy="${key}"></span>
                    <input type="number" data-genotype-resource="${key}" step="${key === "hours" ? "any" : "1"}" required>
                  </label>`).join("")}
              </div>
            </fieldset>
          </div>
          <section class="ml-stage-review-warnings" data-genotype-warning-section hidden>
            <h3 data-genotype-copy="warnings"></h3>
            <ul data-genotype-warnings></ul>
            <label><input type="checkbox" data-genotype-acknowledge><span data-genotype-copy="acknowledge"></span></label>
          </section>
          <footer class="ml-stage-review-actions" data-genotype-submit-actions>
            <button type="button" class="ml-nav-action ml-genotype-submit" data-genotype-submit data-genotype-copy="submit"></button>
          </footer>
        </form>
      </div>
      <aside class="ml-result-inspector ml-genotype-progress" data-genotype-progress hidden>
        <div class="ml-stage-review-progress-card">
          <header class="ml-result-inspector-heading">
            <i data-lucide="activity" aria-hidden="true"></i>
            <h3 data-genotype-copy="progress"></h3>
          </header>
          <p class="ml-genotype-status" data-genotype-status role="status"></p>
          <dl class="ml-key-values" data-genotype-work-progress hidden></dl>
          <dl class="ml-key-values" data-genotype-identifiers hidden>
            <dt data-genotype-copy="runID"></dt><dd data-genotype-run-id></dd>
            <dt data-genotype-copy="jobID"></dt><dd data-genotype-job-id></dd>
          </dl>
          <ol class="ml-genotype-events" data-genotype-events hidden></ol>
          <div class="ml-genotype-actions">
            <button type="button" class="ml-nav-action" data-genotype-refresh data-genotype-copy="refresh" hidden></button>
            <button type="button" class="ml-nav-action" data-genotype-history data-genotype-copy="history" hidden></button>
            <button type="button" class="ml-nav-action" data-genotype-retry data-genotype-copy="retry" hidden></button>
            <button type="button" class="ml-nav-action" data-genotype-retry-dismiss data-genotype-copy="retryDismiss" hidden></button>
            <button type="button" class="ml-nav-action" data-genotype-new data-genotype-copy="newRun" hidden></button>
            <button type="button" class="ml-nav-action" data-genotype-back hidden></button>
            ${cancellationMarkup("genotype")}
            ${revalidationMarkup("genotype")}
          </div>
          <div data-genotype-logs></div>
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
    let renderedSources;
    const inputs = new Map(inputKeys.map(key => [key, panel.querySelector(`[data-genotype-input="${key}"]`)]));
    const settingsInputs = new Map(parameters.map(([key]) => [key, panel.querySelector(`[data-genotype-setting="${key}"]`)]));
    const resourceInputs = new Map(resources.map(key => [key, panel.querySelector(`[data-genotype-resource="${key}"]`)]));
    const fields = [...panel.querySelectorAll("[data-genotype-fields]")];

    let context = {visible: false, datasetId: "", runs: []};
    const datasets = new Map();
    let selectedDataset = "";
    let pollTimer;
    let cancellation;
    let logs;
    let revalidation;
    let disconnected = false;
    let remote = {connected: false, identity: "", environmentKey: ""};
    const stateKey = (id, runId = context.runId) => runId ? `run:${id}:${runId}` : `dataset:${id}`;
    const current = () => datasets.get(stateKey(selectedDataset));
    const runFor = item => context.runs?.find(run => run.run_id === item?.runId);
    const labelFor = key => Object.hasOwn(labels, key) ? labels[key] : key;
    const authToken = () => typeof token === "function" ? token() : token;
    const cloneInputs = value => Object.fromEntries(sourceKinds.map(kind => [kind, [...(value?.[kind] ?? [])]]));
    const referenceKey = dataset => ["ref", "gmap", "gtf"].map(role => dataset.references?.[role] ?? null);
    const isLegacy = dataset => dataset.id === exampleDataset && !referenceKey(dataset).some(Boolean) && (
      sourceKey(dataset.inputs) === sourceKey(exampleInputs) || !dataset.persisted &&
      sourceKey(dataset.inputs) === sourceKey({genotype: exampleInputs.genotype, expression: [], clinical: []}));
    const datasetValue = () => context.dataset ?? {id: context.datasetId, name: labels.example,
      inputs: cloneInputs(exampleInputs), persisted: false, ready: true};
    const inputsFor = dataset => JSON.stringify([sourceKey(dataset.inputs), referenceKey(dataset)]);
    const scopeFor = dataset => JSON.stringify([dataset.id, inputsFor(dataset), remote.connected, remote.identity, remote.environmentKey]);
    const retryScopeFor = (item, datasetId = selectedDataset) => JSON.stringify([datasetId, item.runId, item.record?.job_id ?? null, item.record?.attempt ?? 1, remote]);
    function retryable(item) {
      const run = runFor(item);
      return Boolean(item?.runId && context.visible && run?.source === "live" && run.origin === "workspace" && run.capabilities?.continue_analysis === true &&
        ["failed", "cancelled"].includes(item.record?.state) && !item.submitting && !item.uncertain && !cancellationBusy(item) && !revalidationBusy(item) &&
        Number.isInteger(item.record?.attempt ?? 1) && (item.record?.attempt ?? 1) > 0);
    }
    function clearRetry(item) {
      if (!item?.retry || item.submitting) return;
      invalidate(item, true);item.retry = false;item.retryTarget = null;item.reviewError = labelFor("retryStale");
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
      item.reviewError = labelFor("stale");
      item.reviewTimedOut = false;
      if (clearDraft) item.draft = null;
    }
    async function request(path, body, signal) {
      const headers = {"X-Chat-Token": authToken()};
      const options = {headers, signal};
      if (body) {headers["Content-Type"] = "application/json";Object.assign(options, {method: "POST", body: JSON.stringify(body)});}
      const response = await fetch(path, options);
      const value = await response.json().catch(() => null);
      if (!response.ok || !value) throw Object.assign(new Error(value?.error || value?.reason || labelFor("serviceError")), {status: response.status, code: value?.code});
      return value;
    }
    function fillReview(value, item, keepDraft = false) {
      const paths = value.inputs ?? {};
      const chromosome = value.settings?.["restrict.tcga.geno"] ?? "1";
      for (const [key, element] of inputs) {
        const prefix = item.runId || item.legacy;
        const suffix = prefix && key === "ref" ? `${chromosome}.gen` : prefix && key === "gmap" ? `${chromosome}.map` : "";
        showReviewPaths(element, paths[key] ? [paths[key] + suffix] : [], renderFilePath);
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
      dropStaleRevalidation(item);
      if (item) item.outputRevalidationActive = outputRevalidationInfo({item, run: runFor(item), step: "genotype"})?.active === true;
      for (const element of panel.querySelectorAll("[data-genotype-copy]")) element.textContent = labelFor(element.dataset.genotypeCopy);
      const dataset = datasetValue();
      part("dataset").textContent = (Array.isArray(dataset.name) ? dataset.name[1] : dataset.name) ?? selectedDataset;
      const legacy = item?.runId ? item.runLegacy : isLegacy(dataset);
      const retry = Boolean(item?.retry);
      reviewButton.textContent = labelFor(item?.reviewTimedOut ? "reviewAgain" : retry ? "retryReview" : legacy ? "review" : "customReview");
      submitButton.textContent = labelFor(retry ? "retrySubmit" : "submit");
      form.querySelector('h3[data-genotype-copy="inputs"]').textContent = labelFor(retry ? "retryInputs" : legacy ? "inputs" : "customInputs");
      panel.dataset.genotypeRetryState = retry ? item.reviewing ? "reviewing" : item.submitting ? "submitting" : item.review?.ready ? "ready" : "review" : "idle";
      const state = item?.submitting ? "submitting" : item?.uncertain ? "unknown" : item?.record?.state ?? (item?.runId ? "unknown" : "idle");
      panel.dataset.genotypeState = panel.dataset.runState = state;
      panel.dataset.genotypeDatasetId = selectedDataset;
      if (item?.runId) panel.dataset.genotypeRunId = item.runId;else delete panel.dataset.genotypeRunId;
      const eligible = Boolean(item?.runId) || Boolean(dataset.ready && (legacy || dataset.persisted));
      const connected = retry ? remote.connected : legacy || remote.connected;
      const terminal = terminalStates.has(state);
      const validReview = Boolean(item?.review) && item.review.ready !== false &&
        (!retry && legacy || item.review.ready === true && typeof item.review.review_token === "string" && item.review.review_token.length > 0);
      statusLine.textContent = labelFor(state);
      if (item?.cancellation?.sending) statusLine.textContent = labelFor("cancelSending");
      const reviewingInputs = !item?.runId || retry;
      const reviewPanel = part("review-panel");
      reviewButton.hidden = !eligible || !reviewingInputs;
      reviewButton.disabled = !connected || Boolean(item?.reviewing || item?.submitting);
      readiness.hidden = !reviewingInputs;
      const blocked = !dataset.ready ? dataset.catalogUnavailable ? "catalogUnavailable" : "catalogLoading"
        : dataset.id ? "saveDataset" : "chooseDataset";
      readiness.textContent = labelFor(!eligible ? blocked : item?.reviewing ? retry ? "retryChecking" : legacy ? "checking" : "customChecking"
        : validReview ? "reviewReady" : item?.attempted ? legacy ? "unavailable" : "customUnavailable" : "loadInputs");
      if (item?.reviewTimedOut) readiness.textContent = labelFor("reviewTimeout");
      guidance.textContent = validReview ? labelFor(retry ? "retryReady" : "genotypeReadyPrompt") : eligible && !connected ? labelFor("connect")
        : eligible && !item?.attempted ? labelFor("loadInputsPrompt") : "";
      guidance.hidden = !reviewingInputs || !guidance.textContent;
      reviewPanel.dataset.reviewState = item?.reviewing ? "checking" : item?.reviewTimedOut || item?.reviewError && !validReview ? "error" : validReview ? "ready" : "idle";
      part("progress").hidden = !item?.runId && state === "idle";
      form.hidden = !eligible || !Boolean(item?.review || item?.record?.inputs);
      for (const field of fields) field.disabled = Boolean(item?.runId && !retry || item?.reviewing || item?.submitting || revalidationBusy(item) || retry && !validReview);
      submitButton.hidden = Boolean(item?.runId && !retry);
      part("submit-actions").hidden = submitButton.hidden;
      submitButton.disabled = !eligible || !connected || !validReview || Boolean(item?.reviewing || item?.submitting || item?.uncertain || revalidationBusy(item) || item?.runId && !retry) || (!legacy || retry) && !item?.acknowledged;
      statusButton.hidden = !item?.runId || terminal && !retry;statusButton.disabled = Boolean(item?.submitting || item?.polling || item?.cancellation?.sending || item?.revalidation?.pending);
      historyButton.hidden = !item?.record;newButton.hidden = !terminal || Boolean(context.runId);
      newButton.disabled = cancellationBusy(item) || revalidationBusy(item);
      part("retry").hidden = !retryable(item) || retry;
      part("retry").disabled = !remote.connected;
      part("retry-dismiss").hidden = !retry;
      part("retry-dismiss").disabled = Boolean(item?.submitting);
      part("retry-context").hidden = !retry;
      const nextAttempt = item?.review?.next_attempt ?? (item?.record?.attempt ?? 1) + 1;
      part("retry-context").textContent = !retry ? "" : `Same run: ${item.runId} · Previous attempt: ${item.record?.attempt ?? 1} · Next attempt: ${nextAttempt}. Original files and chromosome stay fixed.`;
      part("back").hidden = !context.runId;
      part("back").textContent = "Back to run timeline";
      identifiers.hidden = !item?.runId;runLabel.textContent = item?.runId ?? "";jobLabel.textContent = item?.record?.job_id ?? "—";
      notice.textContent = [item?.uncertain ? labelFor("uncertain") : "",
        connectionNotice(disconnected, state, item?.error), item?.error || item?.reviewError].filter(Boolean).join(" ");
      notice.hidden = !notice.textContent;
      reviewPanel.hidden = !reviewingInputs && notice.hidden;
      const sourceInputs = item?.sourceInputs ?? item?.review?.source_inputs;
      const referenceSources = item?.review?.reference_sources ?? runFor(item)?.reference_sources;
      const sourceRows = sourceInputs ? sourceKinds.map(kind => [kind, sourceInputs[kind] ?? []]) : [];
      for (const role of ["reference", "genetic_map", "annotation"]) {
        if (typeof referenceSources?.[role] === "string" && referenceSources[role]) sourceRows.push([role, [referenceSources[role]]]);
      }
      part("source-section").hidden = !sourceRows.length;
      part("source-label").textContent = labelFor(item?.runId ? "sourceInputs" : "pendingSourceInputs");
      const sources = JSON.stringify(sourceRows);
      if (renderedSources !== sources) {
        const sourceList = part("source-inputs");sourceList.replaceChildren();
        for (const [kind, files] of sourceRows) {
          const row = document.createElement("div");
          const title = document.createElement("dt"), paths = document.createElement("dd");
          title.textContent = labelFor(kind);paths.dataset.genotypeSourceInput = kind;
          showReviewPaths(paths, files, renderFilePath);
          row.append(title, paths);sourceList.append(row);
        }
        renderedSources = sources;
      }
      const warningList = part("warnings");warningList.replaceChildren();
      for (const message of item?.review?.warnings ?? []) {
        const row = document.createElement("li");row.dataset.genotypeWarning = "";row.textContent = message;warningList.append(row);
      }
      part("warning-section").hidden = !item?.review || !retry && (legacy || Boolean(item?.runId));
      form.querySelector('[data-genotype-copy="acknowledge"]').textContent = labelFor(retry ? "retryAcknowledge" : "acknowledge");
      const acknowledge = part("acknowledge");acknowledge.checked = Boolean(item?.acknowledged);acknowledge.disabled = Boolean(item?.runId && !retry || item?.reviewing || item?.submitting || retry && !validReview);
      events.replaceChildren(...(item?.record?.history ?? []).map(({state: eventState, at}) => {
        const row = document.createElement("li");row.dataset.state = eventState;row.textContent = labelFor(eventState);
        if (at) {const time = document.createElement("time");time.dateTime = at;const date = new Date(at);time.textContent = Number.isNaN(date.valueOf()) ? at : date.toLocaleString("en");row.append(time);}
        return row;
      }));events.hidden = !events.children.length;
      renderWorkProgress(part("work-progress"), item?.record, state, item?.error, disconnected);
      cancellation?.sync();
      revalidation?.sync();
      const run = context.runs?.find(run => run.run_id === item?.runId);
      logs?.setContext({historyId: run?.history_id, runId: item?.runId, source: run?.source, datasetId: selectedDataset,
        step: "genotype", number: item?.record?.attempt ?? 1, current: true, recordFile: "steps/genotype.json",
        recordIdentity: run?.record_identity, record: item?.record, visible: context.visible});
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
      item.reviewTimedOut = false;item.reviewing = item.attempted = true;item.review = null;item.acknowledged = false;item.reviewError = "";item.error = "";render();
      const query = new URLSearchParams({expected_job_id: target.jobId, expected_attempt: String(target.attempt)});
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(target.runId)}/genotype/retry?${query}`, undefined, controller.signal);
        if (controller.signal.aborted || item.reviewRequest !== controller || !item.retry || target.scope !== retryScopeFor(item, datasetId)) return;
        if (next.run_id !== target.runId || next.dataset_id !== datasetId || next.expected_attempt !== target.attempt ||
            String(next.expected_job_id ?? "none") !== target.jobId || next.next_attempt !== target.attempt + 1) throw Error(labelFor("serviceError"));
        item.review = next;item.sourceInputs = next.source_inputs ?? item.sourceInputs;
        item.reviewError = next.issues?.join(" ") || next.reason || "";
        if (item === current()) fillReview(next, item, Boolean(item.draft));
      } catch (error) {
        if (!controller.signal.aborted && item.reviewRequest === controller) {
          item.review = null;item.reviewTimedOut = error.code === "read_timeout";
          item.reviewError = item.reviewTimedOut ? "" : error.message;
        }
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
      item.reviewTimedOut = false;item.reviewing = item.attempted = true;item.reviewError = "";item.review = null;item.acknowledged = false;render();
      try {
        const next = legacy ? await request(examplePath, undefined, controller.signal)
          : await request(`/signet/datasets/${encodeURIComponent(id)}/genotype/review`, {inputs: captured.inputs}, controller.signal);
        if (controller.signal.aborted || item.reviewRequest !== controller || item.scope !== captured.scope || item.runId) return;
        if (!legacy && (next.dataset_id !== id || sourceKey(next.source_inputs) !== sourceKey(captured.inputs) ||
            JSON.stringify(referenceKey({references: next.reference_choices})) !== JSON.stringify(referenceKey(dataset)))) throw Error(labelFor("stale"));
        item.review = next;item.legacy = legacy;item.sourceInputs = next.resolved_inputs ?? next.source_inputs ?? (legacy ? null : captured.inputs);
        item.reviewError = next.issues?.join(" ") || next.reason || "";
        if (item === current()) fillReview(next, item, Boolean(item.draft));
      } catch (error) {
        if (!controller.signal.aborted && item.reviewRequest === controller) {
          item.review = null;item.reviewTimedOut = error.code === "read_timeout";
          item.reviewError = item.reviewTimedOut ? "" : error.message;
        }
      } finally {
        if (item.reviewRequest === controller) {item.reviewRequest = null;item.reviewing = false;if (item === current()) render();}
      }
    }
    function schedulePoll(item = current(), delay = pollInterval) {
      if (item !== current()) return;
      clearTimeout(pollTimer);
      if (item?.runId && !item.submitting && !item.cancellation?.sending && !item.revalidation?.pending && (!terminalStates.has(item.record?.state) || item.cancellation?.awaiting)) pollTimer = setTimeout(() => void refresh(), delay);
    }
    const recordTime = record => Math.max(...[record?.updated_at, record?.history?.at?.(-1)?.at, record?.finished_at, record?.submitted_at]
      .map(value => Date.parse(value)).filter(Number.isFinite));
    function olderRecord(next, previous) {
      if (!previous) return false;
      if ((next.attempt ?? 1) !== (previous.attempt ?? 1)) return (next.attempt ?? 1) < (previous.attempt ?? 1);
      return recordTime(next) < recordTime(previous) ||
        previous.state === "completed" && next.state !== "completed" && next.job_id === previous.job_id ||
        previous.state === "cancelling" && !terminalStates.has(next.state) && next.state !== "cancelling" && next.job_id === previous.job_id ||
        terminalStates.has(previous.state) && !terminalStates.has(next.state) && next.job_id === previous.job_id;
    }
    function receiveRecord(item, next, id, datasetId, revalidated = false) {
      if (next.run_id !== id || next.step && next.step !== "genotype" || next.dataset_id && next.dataset_id !== datasetId || !Object.hasOwn(labels, next.state)) throw Error(labelFor("serviceError"));
      const manualTransition = revalidated && item.record?.state === "failed" && next.job_id === item.record.job_id && (next.attempt ?? 1) === (item.record.attempt ?? 1);
      if (olderRecord(next, item.record) && !manualTransition) return;
      if (item.retry && item.retryTarget && !matchesRetryRecord(next, item.retryTarget)) clearRetry(item);
      const changed = !item.record || next.state !== item.record.state || next.job_id !== item.record.job_id ||
        JSON.stringify(next.progress) !== JSON.stringify(item.record.progress);
      item.record = next;item.uncertain = false;
      cancellation?.observe(item, next);
      item.error = next.status_check_issue ? statusIssue(next, labelFor)
        : next.connection === "interrupted" ? labelFor("interrupted") : ["unknown", "validating", "failed"].includes(next.state) ? next.reason || "" : "";
      if (next.source_inputs) item.sourceInputs = next.source_inputs;
      if (item === current() && next.inputs && !item.retry) fillReview(next, item);
      if (changed || revalidated) onHistoryChanged?.(id, datasetId);
    }
    async function refresh(force = false) {
      const item = current(), datasetId = selectedDataset;
      if (!item?.runId || item.submitting || item.polling || item.cancellation?.sending || item.revalidation?.pending) return;
      const id = item.runId, statusRequest = {};item.statusRequest = statusRequest;
      const epoch = item.cancelEpoch;
      item.polling = true;clearTimeout(pollTimer);render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/steps/genotype${force && !terminalStates.has(item.record?.state) ? "?refresh=1" : ""}`);
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
      if (!item || cancellationBusy(item) || revalidationBusy(item) || !terminalStates.has(item.record?.state)) return;
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
        invalidate(item);item.reviewError = labelFor("retryStale");render();return;
      }
      const body = {inputs: item.review.inputs, settings: {...readNumbers(settingsInputs), "restrict.tcga.geno": Number(item.review.settings["restrict.tcga.geno"])}, resources: readNumbers(resourceInputs),
        review_token: item.review.review_token, expected_job_id: target.jobId, expected_attempt: target.attempt,
        acknowledge_warnings: item.acknowledged};
      item.submitting = true;item.error = "";item.cancelEpoch = (item.cancelEpoch ?? 0) + 1;render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(target.runId)}/genotype/retry`, body);
        if (target.scope !== retryScopeFor(item, datasetId)) throw Error(labelFor("retryStale"));
        if (next.run_id !== target.runId || next.step !== "genotype" || next.attempt !== target.attempt + 1) throw Error(labelFor("serviceError"));
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
    cancellation = mountCancellation({panel, prefix: "genotype", stage: 1, labelFor, request, render,
      target: () => ({item: current(), runId: current()?.runId, datasetId: selectedDataset, visible: context.visible,
        run: context.runs?.find(run => run.run_id === current()?.runId)}),
      receive: (value, next) => receiveRecord(value.item, next, value.runId, value.datasetId), schedule: () => schedulePoll()});
    logs = window.SignetJobLogs?.mount({host: part("logs"), token});
    revalidation = mountOutputRevalidation({panel, prefix: "genotype", labelFor, request, render,
      target: () => ({item: current(), runId: current()?.runId, datasetId: selectedDataset, visible: context.visible, step: "genotype", run: runFor(current())}),
      before: item => {clearRetry(item);item.reviewError = "";},
      receive: (value, next) => receiveRecord(value.item, next, value.runId, value.datasetId, true), schedule: () => schedulePoll(),
      onChanged: value => onHistoryChanged?.(value.runId, value.datasetId)});
    function setContext(next) {
      const previous = current();
      const id = next.dataset?.id ?? next.datasetId ?? "";
      if (id !== selectedDataset || next.runId !== context.runId || previous?.retry && context.visible && !next.visible) {
        part("source-section").open = false;
        saveDraft(previous);clearTimeout(pollTimer);
        clearRetry(previous);
        if (previous?.reviewing) {previous.reviewRequest?.abort();previous.reviewRequest = null;previous.reviewing = false;}
      }
      context = next;selectedDataset = id;
      const item = stateFor(id), dataset = datasetValue();
      const inputKey = inputsFor(dataset), scope = scopeFor(dataset);
      if (!item.runId && item.scope && item.scope !== scope) invalidate(item, item.inputKey !== inputKey);
      item.scope = scope;item.inputKey = inputKey;
      if (!item.runId && !item.preparedNew) {
        const runs = (context.runs ?? []).filter(run => (!run.dataset_id || run.dataset_id === id) && run.jobs?.genotype?.state !== "not_submitted");
        const candidate = context.runId ? runs.find(run => run.run_id === context.runId)
          : runs.find(run => run.jobs?.genotype && !terminalStates.has(run.jobs.genotype.state)) ?? runs.find(run => run.jobs?.genotype);
        if (candidate) restore(candidate.run_id, candidate.jobs.genotype, id, candidate);
      }
      if (item.runId) {
        const run = runFor(item), saved = run?.jobs?.genotype;
        const recovery = recordedOutputTransition(item.record, saved, run?.output_revalidation?.genotype);
        if (saved && !item.submitting && !item.uncertain && (!olderRecord(saved, item.record) || recovery) &&
          (!item.record || recovery || (saved.attempt ?? 1) > (item.record.attempt ?? 1) || recordTime(saved) > recordTime(item.record))) {
          if (item.retry && item.retryTarget && !matchesRetryRecord(saved, item.retryTarget)) clearRetry(item);
          item.record = saved;cancellation?.observe(item, saved);
          if (recovery && item.revalidation) {item.revalidation.error = "";item.revalidation.outcome = saved.state;}
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
      disconnected = value.connected === false;
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
    return {setContext, restore, getRunId: () => current()?.preparedNew ? "" : current()?.runId || null};
  };

  const expressionCopy = {
    title: "Expression preparation",
    stage: "Stage 2",
    run: "Run",
    empty: "Choose a run with completed Stage 1.",
    prerequisite: "Review Stage 2 after Stage 1 completes in this run.",
    readyPrompt: "Review the expression file, gene annotation, and settings before submitting.",
    review: "Check input files",
    checking: "Checking input files…",
    unavailable: "The input files need attention",
    submit: "Submit Stage 2",
    retry: "Review a new attempt",
    back: "Back to run timeline",
    inputs: "Stage 2 input files",
    settings: "Expression settings",
    chromosome: "Chromosome",
    "gexp.file": "Expression file",
    "pmap.file": "Gene annotation file",
  };

  const adjustmentCopy = {
    title: "Sample matching and adjustment",
    stage: "Stage 3",
    run: expressionCopy.run,
    empty: "Choose a run with completed Stages 1 and 2.",
    prerequisite: "Submit Stage 3 after Stages 1 and 2 complete in this run.",
    readyPrompt: "Review the clinical file, principal components and resources, then select Submit Stage 3.",
    submit: "Submit Stage 3",
    review: "Check clinical file",
    checking: "Checking clinical data…",
    unavailable: "The clinical file needs review",
    inputs: "Clinical file",
    settings: "Adjustment settings",
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    npc: "Principal components for adjustment (0–10)",
    "cli.file": "Clinical data file",
  };

  const cisCopy = {
    title: "Gene–variant associations",
    stage: "Stage 4",
    run: expressionCopy.run,
    empty: "Choose a run with completed Stages 1–3.",
    prerequisite: "Submit Stage 4 after Stages 1–3 complete in this run.",
    readyPrompt: "Review the significance threshold, analysis range and permutations, then select Submit Stage 4.",
    submit: "Submit Stage 4",
    review: "Check prior results",
    checking: "Checking prior results…",
    unavailable: "The prior results need attention",
    inputs: "Files from this run",
    settings: "Association settings",
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    "alpha.cis": "Significance threshold",
    upstream: "After gene end (base pairs)",
    downstream: "Before gene start (base pairs)",
    nperms: "Permutations",
    positiveAlpha: "The significance threshold must be above 0.",
  };

  const networkCopy = {
    title: "Candidate network inference",
    stage: "Stage 5",
    run: expressionCopy.run,
    empty: "Choose a run with completed Stages 1–4.",
    prerequisite: "Submit Stage 5 after Stages 1–4 complete in this run.",
    readyPrompt: "Review bootstrap runs, the correlation threshold and resources, then select Submit Stage 5.",
    submit: "Submit Stage 5",
    review: cisCopy.review,
    checking: cisCopy.checking,
    unavailable: cisCopy.unavailable,
    inputs: cisCopy.inputs,
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    settings: "Inference settings",
    nboots: "Bootstrap runs",
    cor: "Instrument correlation limit",
    correlationNote: "The correlation limit selects each gene’s instrumental variants.",
    childResources: "Each compute job",
    resources: "Workflow controller",
    jobID: "Controller job ID",
    controllerNote: "The controller waits for the compute jobs to finish, so allow enough time for the full workflow.",
    ncores: "CPU cores",
    memory: "Memory (GB)",
    walltime: "Time limit (H:MM:SS)",
    positiveCorrelation: "The correlation threshold must be above 0.",
    defaultsApplied: "Some saved resource defaults exceed supported ranges. Review the replacement values before submission.",
    phase1: "First batch of model work items",
    phase2: "Second batch of model work items",
  };

  const visualizationCopy = {
    title: "Network visualization and export",
    stage: "Stage 6",
    run: expressionCopy.run,
    empty: "Choose a run with completed Stages 1–5.",
    prerequisite: "Submit Stage 6 after Stages 1–5 complete in this run.",
    readyPrompt: "Review the frequency threshold and subnetwork count, then select Submit Stage 6.",
    submit: "Submit Stage 6",
    review: "Check network and thresholds",
    checking: "Checking network and thresholds…",
    unavailable: "The network inputs need review",
    inputs: cisCopy.inputs,
    retry: expressionCopy.retry,
    back: expressionCopy.back,
    settings: "Network export settings",
    freq: "Edge frequency threshold",
    ntop: "Subnetworks to display",
    savedResults: "Saved networks",
  };

  const sourceLabels = {
    "snps.map": "Variant positions", "snps.maf": "Variant frequencies",
    "matched.gexp": "Matched expression", "matched.gexp.withpc": "Expression with covariates",
    "matched.geno": "Matched genotypes", "gene.pos": "Gene positions",
    "net.gexp.data": "Expression for network inference", "net.geno.data": "Genotypes for network inference",
    "sig.pair": "Significant gene–variant associations", "net.genename": "Gene names", "net.genepos": "Gene positions",
    Afreq: "Edge appearance frequencies", coef: "Edge coefficients", "vis.genepos": "Gene positions",
  };

  function mountContinuationRun({panel, token, renderFilePath, onHistoryChanged, onOpenHistory, onBack, onShowResults}, step = "expression") {
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
    const stageTitle = `lens-stage${stage}${visualization ? "-run" : ""}-title`;
    const stageIcon = ["table-2", "chart-scatter", "chart-no-axes-combined", "network", "network"][stage - 2];
    panel.classList.add("ml-expression-panel", "ml-stage-review");
    if (adjustment) panel.classList.add("ml-adjust-panel");
    panel.innerHTML = `
      <div class="ml-result-main ml-genotype-main">
        <header class="ml-stage-review-header">
          <span class="ml-stage-review-icon" aria-hidden="true"><i data-lucide="${stageIcon}"></i></span>
          <div>
            <p class="ml-genotype-eyebrow" data-${prefix}-copy="stage"></p>
            <h2 id="${stageTitle}" data-${prefix}-copy="title"></h2>
          </div>
        </header>
        <div class="ml-stage-review-context">
          <label class="ml-expression-run-label"><span data-${prefix}-copy="run"></span>
            <select data-${prefix}-run></select>
          </label>
          <div class="ml-stage-review-navigation">
            ${visualization ? '<button type="button" class="ml-nav-action" data-visualize-results data-visualize-copy="savedResults"></button>' : ''}
            <button type="button" class="ml-nav-action" data-${prefix}-back data-${prefix}-copy="back" hidden></button>
          </div>
        </div>
        <div class="ml-stage-review-readiness" data-${prefix}-review-panel>
          <div>
            <p class="ml-stage-review-status" data-${prefix}-readiness role="status"></p>
            <p class="ml-stage-review-guidance" data-${prefix}-guidance hidden></p>
          </div>
          <button type="button" class="ml-nav-action" data-${prefix}-review data-${prefix}-copy="review"></button>
          <p class="ml-genotype-notice" data-${prefix}-notice role="status" hidden></p>
        </div>
        <form data-${prefix}-form data-stage-review-form aria-labelledby="${stageTitle}" hidden>
          ${linkedInputs ? `<details class="ml-stage-review-source-section" data-${prefix}-source-section hidden>
            <summary data-${prefix}-copy="inputs"></summary>
            <dl class="ml-stage-review-file-list" data-${prefix}-input-sources></dl>
          </details>` : `<section class="ml-stage-review-files" aria-labelledby="ml-${prefix}-files-heading">
            <h3 id="ml-${prefix}-files-heading" data-${prefix}-copy="inputs"></h3>
            <dl class="ml-stage-review-file-list">${fileKeys.map(key => `<div>
              <dt data-${prefix}-copy="${key}"></dt>${adjustment
                ? `<dd class="ml-stage-review-clinical-file">
                  <input class="ml-clinical-input" type="text" data-${prefix}-input="${key}" maxlength="2048" required>
                  <div data-adjust-clinical-path hidden></div>
                </dd>`
                : `<dd data-${prefix}-input="${key}"></dd>`}
            </div>`).join("")}</dl>
            ${adjustment ? `<div class="ml-settings-note" data-adjust-clinical-replacement hidden>
              <p>Enter a corrected path and check it again. SIGNET retains the original file and reuses completed Stages 1 and 2.</p>
              <div class="ml-stage-review-clinical-file" data-adjust-original-clinical hidden>
                <span>Original frozen file</span><div data-adjust-original-path></div>
              </div>
            </div>` : ''}
          </section>`}
          ${adjustment ? `<div class="ml-stage-review-clinical" data-adjust-clinical-review hidden>
            <div data-adjust-clinical-schema hidden></div>
            <div data-adjust-clinical-summary></div>
            <div data-adjust-clinical-choices></div>
          </div>` : ''}
          <div class="ml-stage-review-settings${network ? ' ml-stage-review-network-settings' : ''}">
            <fieldset data-${prefix}-fields><legend data-${prefix}-copy="settings"></legend>
              <div class="ml-genotype-controls">${parameterMarkup(network ? parameterDefinitions.slice(0, 2) : parameterDefinitions)}</div>
              ${network ? '<input type="number" data-network-setting="ncis" value="3" readonly hidden><p class="ml-settings-note" data-network-copy="correlationNote"></p>' : ''}
            </fieldset>
            <fieldset data-${prefix}-fields><legend data-${prefix}-copy="resources"></legend>
              <div class="ml-genotype-controls">${resources.map(key => `<label><span data-${prefix}-copy="${key}"></span>
                <input type="number" data-${prefix}-resource="${key}" step="${key === "hours" ? "any" : "1"}" value="${alwaysVisible ? initialResources[key] : ''}" required>
              </label>`).join("")}</div>
              ${network ? '<p class="ml-settings-note" data-network-copy="controllerNote"></p>' : ''}
            </fieldset>
            ${network ? `<fieldset data-network-fields><legend data-network-copy="childResources"></legend>
              <div class="ml-genotype-controls">${parameterMarkup(parameterDefinitions.slice(3))}</div>
            </fieldset>` : ''}
          </div>
          ${network ? '<p class="ml-settings-note" data-network-defaults hidden></p>' : ''}
          <footer class="ml-stage-review-actions" data-${prefix}-submit-actions>
            <button type="button" class="ml-nav-action ml-genotype-submit" data-${prefix}-submit data-${prefix}-copy="submit"></button>
          </footer>
        </form>
      </div>
      <aside class="ml-result-inspector ml-genotype-progress" data-${prefix}-progress hidden>
        <div class="ml-stage-review-progress-card">
          <header class="ml-result-inspector-heading">
            <i data-lucide="activity" aria-hidden="true"></i>
            <h3 data-${prefix}-copy="progress"></h3>
          </header>
          <p class="ml-genotype-status" data-${prefix}-status role="status"></p>
          <dl class="ml-key-values" data-${prefix}-work-progress hidden></dl>
          <dl class="ml-key-values" data-${prefix}-identifiers hidden>
            <dt data-${prefix}-copy="runID"></dt><dd data-${prefix}-run-id></dd>
            <dt data-${prefix}-copy="jobID"></dt><dd data-${prefix}-job-id></dd>
          </dl>
          <ol class="ml-genotype-events" data-${prefix}-events hidden></ol>
          <div class="ml-genotype-actions">
            <button type="button" class="ml-nav-action" data-${prefix}-refresh data-${prefix}-copy="refresh" hidden></button>
            <button type="button" class="ml-nav-action" data-${prefix}-history data-${prefix}-copy="history" hidden></button>
            <button type="button" class="ml-nav-action" data-${prefix}-retry data-${prefix}-copy="retry" hidden></button>
            ${cancellationMarkup(prefix)}
            ${revalidationMarkup(prefix)}
          </div>
          <div data-${prefix}-logs></div>
        </div>
      </aside>`;

    const part = name => panel.querySelector(`[data-${prefix}-${name}]`);
    const form = part("form");
    const picker = part("run");
    const resourceInputs = new Map(resources.map(key => [key, panel.querySelector(`[data-${prefix}-resource="${key}"]`)]));
    const parameterInputs = new Map(parameterDefinitions.map(({key}) => [key, panel.querySelector(`[data-${prefix}-${parameterAttribute}="${key}"]`)]));
    const fields = [...panel.querySelectorAll(`[data-${prefix}-fields]`)];
    const runStates = new Map();
    let renderedSources;
    let context = {datasetId: "", visible: false, runs: [], runId: null};
    let selectedRun = "";
    let pollTimer;
    let cancellation;
    let logs;
    let revalidation;
    let disconnected = false;
    const labelFor = key => Object.hasOwn(copy, key) ? copy[key] : Object.hasOwn(labels, key) ? labels[key] : key;
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
      if (!reply.ok || !result) throw Object.assign(new Error(result?.error || labelFor("serviceError")), {status: reply.status, code: result?.code});
      return result;
    }

    function fillReview(value, keepDraft = false) {
      if (adjustment && !keepDraft && current()) {
        current().clinicalChoices = {...(value.clinical?.choices ?? value.choices ?? {})};
        current().genderColumn = value.clinical?.gender_column ?? "";
      }
      for (const key of fileKeys) {
        const element = panel.querySelector(`[data-${prefix}-input="${key}"]`);
        if (adjustment) element.value = value.inputs?.[key] ?? "";
        else showReviewPaths(element, value.inputs?.[key] ? [value.inputs[key]] : [], renderFilePath);
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
        choices: adjustment ? {...(item.clinicalChoices ?? {})} : {},
        genderColumn: adjustment ? item.genderColumn : undefined,
        parameters: Object.fromEntries([...parameterInputs].map(([key, input]) => [key, input.value])),
        resources: Object.fromEntries([...resourceInputs].map(([key, input]) => [key, input.value])),
      };
    }

    function invalidateClinicalReview(item) {
      item.review.ready = false;
      delete item.review.review_token;
      item.error = "Check the clinical file again to confirm these choices before submission.";
      saveDraft();
      part("submit").disabled = true;
      part("review-panel").dataset.reviewState = "error";
      part("readiness").textContent = "Clinical review changed";
      part("guidance").hidden = true;
      part("notice").textContent = item.error;
      part("notice").hidden = false;
    }

    function render() {
      for (const element of panel.querySelectorAll(`[data-${prefix}-copy]`)) element.textContent = labelFor(element.getAttribute(`data-${prefix}-copy`));
      const item = current();
      dropStaleRevalidation(item);
      const saved = item?.record;
      if (item) item.outputRevalidationActive = outputRevalidationInfo({item, run: source(), step})?.active === true;
      const state = item?.submitting ? "submitting" : item?.uncertain ? "unknown" : saved?.state ?? "idle";
      const hasAttempt = Boolean(saved) && !item?.retry || Boolean(item?.submitting || item?.uncertain);
      const allowed = source()?.jobs.genotype?.state === "completed" &&
        (step === "expression" || source()?.jobs.expression?.state === "completed") &&
        (!linkedInputs || source()?.jobs.adjust?.state === "completed") &&
        (!(network || visualization) || source()?.jobs.cis?.state === "completed") &&
        (!visualization || source()?.jobs.network?.state === "completed");
      const terminal = terminalStates.has(state);
      panel.dataset[`${prefix}State`] = panel.dataset.runState = state;
      part("progress").hidden = state === "idle" && !saved;
      panel.dataset[`${prefix}RunId`] = selectedRun;
      const selection = selectedRun;
      picker.replaceChildren(...context.runs.map(run => {
        const option = document.createElement("option");
        option.value = run.run_id;
        option.textContent = typeof run.name === "string" && run.name !== run.run_id ? `${run.name} · ${run.run_id}` : run.run_id;
        return option;
      }));
      picker.value = selection;
      picker.disabled = Boolean(context.runId) || !context.runs.length || Boolean(item?.submitting);
      const verified = allowed && !hasAttempt && item?.review && item.review.ready !== false;
      const reviewPanel = part("review-panel");
      part("readiness").hidden = hasAttempt;
      part("readiness").textContent = !selectedRun ? labelFor("empty") : !allowed ? labelFor("prerequisite")
        : item.checking ? labelFor("checking") : item.review && !hasAttempt ? labelFor(item.review.ready === false ? "unavailable" : "reviewReady")
          : labelFor("loadInputs");
      reviewPanel.dataset.reviewState = item?.checking ? "checking"
        : item?.reviewTimedOut || item?.review?.ready === false || item?.error ? "error" : verified ? "ready" : "idle";
      if (!hasAttempt && item?.reviewTimedOut) {
        part("readiness").textContent = labelFor("reviewTimeout");
        part("review").textContent = labelFor("reviewAgain");
      }
      part("guidance").textContent = verified && !item.checking ? labelFor("readyPrompt") : "";
      part("guidance").hidden = !part("guidance").textContent;
      part("review").hidden = !(alwaysVisible ? selectedRun : allowed) || hasAttempt;
      part("review").disabled = Boolean(item?.checking || revalidationBusy(item));
      form.hidden = !selectedRun || !alwaysVisible && (!allowed || !(hasAttempt ? saved?.inputs : item?.review));
      for (const field of fields) field.disabled = hasAttempt || cancellationBusy(item) || revalidationBusy(item) || !selectedRun || visualization && Boolean(item?.checking);
      if (adjustment) {
        const clinicalInput = panel.querySelector('[data-adjust-input="cli.file"]');
        clinicalInput.setAttribute("aria-label", labelFor("cli.file"));
        clinicalInput.disabled = hasAttempt || Boolean(item?.checking || revalidationBusy(item)) || !selectedRun;
        const frozenClinical = source()?.frozen_inputs?.clinical?.[0];
        const frozen = Boolean(item?.review?.frozen || item?.review?.frozen_inputs || source()?.input_mode === "dataset" || source()?.frozen_inputs);
        const replacementAllowed = item?.review?.clinical_replacement_allowed === true;
        clinicalInput.readOnly = hasAttempt || frozen && !replacementAllowed;
        const clinicalPath = part("clinical-path");
        const selectedClinical = clinicalInput.value.trim();
        clinicalInput.hidden = Boolean(renderFilePath && clinicalInput.readOnly && selectedClinical);
        clinicalPath.hidden = !renderFilePath || !selectedClinical;
        if (!clinicalPath.hidden) showReviewPaths(clinicalPath, [selectedClinical], renderFilePath);
        part("clinical-replacement").hidden = !frozen || !replacementAllowed || hasAttempt;
        part("original-clinical").hidden = !frozenClinical;
        if (frozenClinical) showReviewPaths(part("original-path"), [frozenClinical], renderFilePath);
        const clinical = hasAttempt ? saved?.clinical?.review : item?.review?.clinical;
        part("clinical-review").hidden = !clinical;
        const missingColumns = clinical?.missing_columns ?? [];
        const candidates = clinical?.gender_column_candidates ?? [];
        const schema = part("clinical-schema");
        schema.replaceChildren();
        schema.hidden = !missingColumns.includes("gender") && !candidates.length;
        if (!schema.hidden) {
          const group = document.createElement("fieldset");
          const legend = document.createElement("legend");
          legend.textContent = "Gender column";
          group.append(legend);
          if (missingColumns.includes("gender")) {
            const explanation = document.createElement("p");
            explanation.textContent = "Stage 3 needs exactly one gender column. Select the column that contains the correct values, or use a corrected clinical file.";
            group.append(explanation);
          }
          if (candidates.length) {
            const label = document.createElement("label");
            label.textContent = "Use this column as gender";
            const select = document.createElement("select");
            select.dataset.adjustGenderColumn = "";
            select.append(new Option("Choose a column", ""),
              ...candidates.map(column => new Option(column, column)));
            select.value = (hasAttempt ? clinical.gender_column : item.genderColumn) ?? "";
            select.disabled = hasAttempt || clinicalInput.disabled;
            select.addEventListener("change", () => {
              item.genderColumn = select.value;
              invalidateClinicalReview(item);
            });
            label.append(select);
            group.append(label);
          } else if (missingColumns.includes("gender")) {
            const unavailable = document.createElement("p");
            unavailable.textContent = "No matching column name was found. Provide a clinical file with one gender column.";
            group.append(unavailable);
          }
          if (!clinicalInput.readOnly && !hasAttempt) {
            const replace = document.createElement("button");
            replace.type = "button";
            replace.className = "ml-nav-action";
            replace.dataset.adjustUseCorrectedClinical = "";
            replace.textContent = "Use a corrected clinical file";
            replace.disabled = clinicalInput.disabled;
            replace.addEventListener("click", () => {
              clinicalInput.focus();
              clinicalInput.select();
            });
            group.append(replace);
          }
          schema.append(group);
        }
        const summary = part("clinical-summary");
        summary.replaceChildren();
        if (clinical && clinical.schema_valid !== false && !missingColumns.length) {
          const count = key => Number.isSafeInteger(clinical[key]) && clinical[key] >= 0 ? clinical[key] : "—";
          const totals = document.createElement("ul");
          totals.className = "ml-stage-review-clinical-totals";
          totals.setAttribute("aria-label", "Clinical review totals");
          for (const [key, label] of [["rows", "clinical rows"], ["matched", "matched"], ["retained", "retained"], ["excluded", "excluded"]]) {
            const cell = document.createElement("li"), amount = document.createElement("strong");
            amount.textContent = count(key);
            cell.append(amount, document.createTextNode(` ${label}`));
            totals.append(cell);
          }
          const scope = document.createElement("p");
          scope.textContent = "This review uses the completed Stage 1 and Stage 2 outputs. These counts can differ from the Data page’s preliminary pairing. Retained and excluded counts reflect the current clinical choices.";
          const missing = document.createElement("dl");missing.className = "ml-key-values";
          for (const [key, label] of [["clinical_matched", "Matched patients with clinical data"],
            ["missing_race", "Missing race after current choices"],
            ["missing_gender", "Missing gender after current choices"]]) {
            const title = document.createElement("dt"), value = document.createElement("dd");
            title.textContent = label;value.textContent = String(count(key));
            value.dataset.clinicalReviewCount = key;missing.append(title, value);
          }
          summary.append(totals, scope, missing);
        }
        const choices = part("clinical-choices");
        choices.replaceChildren();
        if (Object.keys(clinical?.race ?? {}).length) {
          const counts = document.createElement("p");
          counts.textContent = Object.entries(clinical.race).map(([name, count]) => `${name}: ${count}`).join(" · ");
          choices.append(counts);
        }
        for (const [value, count] of Object.entries(clinical?.unrecognized_race ?? {})) {
          const group = document.createElement("fieldset");
          const legend = document.createElement("legend");
          legend.textContent = `${value} (${count})`;
          group.append(legend);
          group.disabled = hasAttempt || Boolean(item?.checking || item?.submitting);
          for (const [answer, text] of [["not_reported", "Treat as not reported (SIGNET groups as white)"],
            ["exclude", "Exclude these samples"]]) {
            const label = document.createElement("label");
            const input = document.createElement("input");
            input.type = "radio";input.name = `clinical-${value}`;input.value = answer;input.required = true;
            input.checked = item?.clinicalChoices?.[value] === answer;
            input.addEventListener("change", () => {
              item.clinicalChoices = {...(item.clinicalChoices ?? {}), [value]: answer};
              invalidateClinicalReview(item);
            });
            label.append(input, document.createTextNode(text));group.append(label);
          }
          choices.append(group);
        }
      }
      if (linkedInputs) {
        const inputSources = saved?.input_sources ?? item?.review?.input_sources ?? source()?.jobs[step]?.input_sources ?? {};
        const entries = Object.entries(inputSources).filter(([, path]) => typeof path === "string" && path);
        part("source-section").hidden = !entries.length;
        const sources = JSON.stringify(entries);
        if (renderedSources !== sources) {
          const rows = entries.map(([key, path]) => {
            const row = document.createElement("div"), label = document.createElement("dt"), value = document.createElement("dd");
            label.textContent = Object.hasOwn(sourceLabels, key) ? sourceLabels[key] : key;
            showReviewPaths(value, [path], renderFilePath);
            row.append(label, value);
            return row;
          });
          part("input-sources").replaceChildren(...rows);
          renderedSources = sources;
        }
      }
      if (network) {
        const defaults = item?.review?.defaults_applied ?? [];
        part("defaults").hidden = !defaults.length || hasAttempt;
        part("defaults").textContent = defaults.length ? labelFor("defaultsApplied") : "";
        part("defaults").title = defaults.join("\n");
      }
      renderWorkProgress(part("work-progress"), saved, state, item?.error, disconnected);
      part("submit").hidden = part("submit-actions").hidden = hasAttempt;
      part("submit").disabled = !allowed || !item?.review || item.review.ready === false || adjustment && !item.review.review_token || item.checking || item.submitting || hasAttempt || cancellationBusy(item) || revalidationBusy(item);
      part("status").textContent = labelFor(state);
      if (item?.cancellation?.sending) part("status").textContent = labelFor("cancelSending");
      part("identifiers").hidden = !selectedRun;
      part("run-id").textContent = selectedRun;
      part("job-id").textContent = saved?.job_id ?? "—";
      part("refresh").hidden = !hasAttempt || terminal;
      part("refresh").disabled = Boolean(item?.polling || item?.submitting || item?.cancellation?.sending || item?.revalidation?.pending);
      part("history").hidden = !saved;
      part("retry").hidden = !saved || !["failed", "cancelled"].includes(state) || Boolean(item?.retry || item?.uncertain || cancellationBusy(item) || revalidationBusy(item));
      part("back").hidden = !context.runId;
      if (visualization) part("results").disabled = !context.resultsAvailable;
      const message = [item?.uncertain ? labelFor("uncertain") : "",
        connectionNotice(disconnected, state, item?.error), item?.error].filter(Boolean).join(" ");
      part("notice").textContent = message;
      part("notice").hidden = !message;
      reviewPanel.hidden = hasAttempt && !message;
      part("events").replaceChildren(...(saved?.history ?? []).map(event => {
        const row = document.createElement("li");
        row.dataset.state = event.state;
        row.textContent = labelFor(event.state);
        if (event.at) {
          const time = document.createElement("time");
          time.dateTime = event.at;
          const date = new Date(event.at);
          time.textContent = Number.isNaN(date.valueOf()) ? event.at : date.toLocaleString("en");
          row.append(time);
        }
        return row;
      }));
      part("events").hidden = !saved?.history?.length;
      cancellation?.sync();
      revalidation?.sync();
      const run = source();
      logs?.setContext({historyId: run?.history_id, runId: selectedRun, source: run?.source, datasetId: context.datasetId,
        step, number: saved?.attempt ?? 1, current: true, recordFile: `steps/${step}.json`, recordIdentity: run?.record_identity,
        record: saved, visible: context.visible});
    }

    function accept(item, value, id, revalidated = false) {
      if (value.run_id !== id || value.step !== step || !Object.hasOwn(labels, value.state)) throw Error(labelFor("serviceError"));
      const sameAttempt = (value.attempt ?? 1) === (item.record?.attempt ?? 1);
      const manualTransition = revalidated && sameAttempt && item.record?.state === "failed" && item.record.job_id === value.job_id;
      if (item.record && !manualTransition && ((value.attempt ?? 1) < (item.record.attempt ?? 1) ||
          sameAttempt && item.record.job_id === value.job_id && (item.record.state === "completed" && value.state !== "completed" || terminalStates.has(item.record.state) && !terminalStates.has(value.state) ||
            item.record.state === "cancelling" && !terminalStates.has(value.state) && value.state !== "cancelling"))) return;
      const changed = !item.record || value.state !== item.record.state || value.job_id !== item.record.job_id ||
        JSON.stringify(value.progress) !== JSON.stringify(item.record.progress);
      item.record = value;
      cancellation?.observe(item, value);
      item.uncertain = false;
      item.retry = false;
      item.error = value.status_check_issue ? statusIssue(value, labelFor)
        : value.connection === "interrupted" ? labelFor("interrupted") : value.reason ?? "";
      if (id === selectedRun && value.inputs) fillReview(value);
      if (changed || revalidated) onHistoryChanged?.(id);
    }

    function schedule() {
      clearTimeout(pollTimer);
      const item = current();
      if (item && !item.submitting && !item.cancellation?.sending && !item.revalidation?.pending && (item.uncertain || item.cancellation?.awaiting || item.record && !terminalStates.has(item.record.state))) {
        pollTimer = setTimeout(() => void refresh(), pollInterval);
      }
    }

    async function refresh(force = false) {
      const id = selectedRun;
      const item = current();
      if (!id || !item || item.polling || item.submitting || item.cancellation?.sending || item.revalidation?.pending) return;
      const epoch = item.cancelEpoch;
      const statusRequest = {};item.statusRequest = statusRequest;
      item.polling = true;
      render();
      try {
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/steps/${step}${force && !terminalStates.has(item.record?.state) ? "?refresh=1" : ""}`);
        if (epoch === item.cancelEpoch) accept(item, next, id);
      } catch (error) {
        if (epoch === item.cancelEpoch) item.error = error.message;
      } finally {
        if (item.statusRequest === statusRequest) {item.statusRequest = null;item.polling = false;render();schedule();}
      }
    }

    async function review() {
      const id = selectedRun;
      const item = current();
      if (!id || !item || !source() || item.checking || item.submitting || item.uncertain || cancellationBusy(item) || revalidationBusy(item) || item.record && !item.retry || !alwaysVisible && source()?.jobs.genotype?.state !== "completed") return;
      const epoch = item.cancelEpoch;
      item.checking = item.attempted = true;
      item.reviewTimedOut = false;
      item.error = "";
      render();
      try {
        const frozen = adjustment && (item.review?.frozen || item.review?.frozen_inputs || source()?.input_mode === "dataset" || source()?.frozen_inputs);
        const canReplace = item.review?.clinical_replacement_allowed === true;
        const clinicalPath = adjustment && (!frozen || canReplace) ? panel.querySelector('[data-adjust-input="cli.file"]').value.trim() : "";
        const params = new URLSearchParams();
        if (clinicalPath && (!frozen || clinicalPath !== source()?.frozen_inputs?.clinical?.[0])) params.set("clinical", clinicalPath);
        if (adjustment && item.clinicalChoices && Object.keys(item.clinicalChoices).length) params.set("choices", JSON.stringify(item.clinicalChoices));
        if (adjustment && item.genderColumn) params.set("gender_column", item.genderColumn);
        if (visualization && item.draft) {
          for (const [key, input] of parameterInputs) params.set(key,
            Number.isFinite(input.valueAsNumber) ? String(input.valueAsNumber) : input.value);
        }
        const query = params.size ? `?${params}` : "";
        const next = await request(`/signet/runs/${encodeURIComponent(id)}/${step}/example${query}`);
        if (epoch !== item.cancelEpoch) return;
        const preserve = adjustment || (linkedInputs ? Boolean(item.draft) : item.review && fileKeys.every(key => item.review.inputs[key] === next.inputs[key]));
        item.review = next;
        if (adjustment && next.clinical) {
          item.genderColumn = next.clinical.gender_column ?? "";
          item.clinicalChoices = Object.fromEntries(Object.entries(item.clinicalChoices ?? {})
            .filter(([key]) => Object.hasOwn(next.clinical.unrecognized_race ?? {}, key)));
        }
        item.error = next.issues?.join(" ") || next.reason || "";
        if (id === selectedRun) {
          fillReview(next, Boolean(preserve));
          saveDraft();
        }
      } catch (error) {
        if (epoch === item.cancelEpoch) {
          item.review = adjustment && item.review?.clinical_replacement_allowed === true ? {...item.review, ready: false, clinical: null} : null;
          if (item.review) delete item.review.review_token;
          item.reviewTimedOut = error.code === "read_timeout";
          item.error = item.reviewTimedOut ? "" : error.message;
        }
      } finally {
        if (epoch === item.cancelEpoch) {item.checking = false;render();}
      }
    }

    function selectRun(id) {
      const changed = selectedRun !== id;
      if (changed) {
        saveDraft();
        if (linkedInputs) part("source-section").open = false;
      }
      selectedRun = id;
      clearTimeout(pollTimer);
      const item = id ? stateFor(id) : null;
      const saved = source()?.jobs[step];
      const recovery = recordedOutputTransition(item?.record, saved, source()?.output_revalidation?.[step]);
      const received = saved && saved.state !== "not_submitted" && !item.submitting && !item.uncertain &&
        (!item.record || recovery || (saved.attempt ?? 1) > (item.record.attempt ?? 1) || Date.parse(saved.updated_at ?? saved.submitted_at) > Date.parse(item.record.updated_at ?? item.record.submitted_at));
      if (received) {
        item.record = saved;cancellation?.observe(item, saved);
        if (recovery && item.revalidation) {item.revalidation.error = "";item.revalidation.outcome = saved.state;}
      }
      if ((changed || received) && item?.record?.inputs && !item.retry) fillReview(item.record);
      else if (changed && item?.review) fillReview(item.review);
      else if (changed && alwaysVisible) fillReview({[parameterGroup]: Object.fromEntries(parameterDefinitions.map(({key, value}) => [key, value])), resources: initialResources});
      if (changed && alwaysVisible && item?.draft && (!item.record || item.retry)) {
        if (adjustment) panel.querySelector('[data-adjust-input="cli.file"]').value = item.draft.clinical;
        if (adjustment) {
          item.clinicalChoices = {...(item.draft.choices ?? {})};
          item.genderColumn = item.draft.genderColumn ?? "";
        }
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
        alpha.setCustomValidity(alpha.valueAsNumber > 0 ? "" : labelFor("positiveAlpha"));
      }
      if (network) {
        const correlation = parameterInputs.get("cor");
        correlation.setCustomValidity(correlation.valueAsNumber > 0 ? "" : labelFor("positiveCorrelation"));
      }
      if (!form.reportValidity()) return;
      const values = inputs => Object.fromEntries([...inputs].map(([key, element]) =>
        [key, element.type === "number" ? element.valueAsNumber : element.value.trim()]));
      const body = {inputs: item.review.inputs, [parameterGroup]: values(parameterInputs), resources: values(resourceInputs)};
      if (adjustment) body.choices = {...(item.clinicalChoices ?? {})};
      if (adjustment) body.review_token = item.review.review_token;
      if (adjustment && item.genderColumn) body.gender_column = item.genderColumn;
      item.submitting = true;
      item.retry = false;
      item.error = "";
      render();
      try {
        accept(item, await request(`/signet/runs/${encodeURIComponent(id)}/${step}/example`, body), id);
      } catch (error) {
        item.error = error.message;
        if (error.status === 400 || error.status === 412 || error.code === "review_required" || error.status === 502 && error.code === "remote_failed") {
          if (adjustment) {
            item.review.ready = false;
            delete item.review.review_token;
          } else {
            item.review = null;
            item.attempted = false;
          }
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
        if (!item || item.record && !item.retry) return;
        // Keep the explicit replacement permission while clearing stale clinical evidence.
        item.review = item.review?.clinical_replacement_allowed === true ? {...item.review, ready: false, clinical: null} : null;
        if (item.review) delete item.review.review_token;
        item.clinicalChoices = {};
        item.genderColumn = "";
        item.attempted = true;
        item.error = "The clinical file changed. Check it again before submission.";
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
    window.addEventListener("workspace-remote-context", event => {
      const offline = event.detail?.connected === false;
      if (disconnected === offline) return;
      disconnected = offline;
      render();
    });
    cancellation = mountCancellation({panel, prefix, stage, labelFor, request, render, schedule,
      target: () => ({item: current(), runId: selectedRun, datasetId: context.datasetId, visible: context.visible, run: source()}),
      receive: (value, next) => accept(value.item, next, value.runId)});
    logs = window.SignetJobLogs?.mount({host: part("logs"), token});
    revalidation = mountOutputRevalidation({panel, prefix, labelFor, request, render, schedule,
      target: () => ({item: current(), runId: selectedRun, datasetId: context.datasetId, visible: context.visible, step, run: source()}),
      before: item => {item.retry = false;item.review = null;item.draft = null;item.checking = false;},
      receive: (value, next) => accept(value.item, next, value.runId, true), onChanged: value => onHistoryChanged?.(value.runId)});
    part("review").addEventListener("click", () => void review());
    part("submit").addEventListener("click", () => void submit());
    part("refresh").addEventListener("click", () => void refresh(true));
    part("history").addEventListener("click", () => onOpenHistory?.(selectedRun));
    part("back").addEventListener("click", () => onBack?.());
    if (visualization) part("results").addEventListener("click", () => onShowResults?.());
    part("retry").addEventListener("click", () => {
      const item = current();
      if (!item || item.uncertain || item.submitting || cancellationBusy(item) || revalidationBusy(item) || !["failed", "cancelled"].includes(item.record?.state)) return;
      item.retry = true;
      item.review = null;
      void review();
    });
    return {
      getRunId: () => selectedRun || null,
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
