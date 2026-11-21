(() => {
  "use strict";

  const cache = new Map();
  const views = new Set();
  let remote = {connected: false, identity: "", environmentKey: ""};
  const copy = {
    title: "Execution logs and error details",
    errors: "Recorded error details",
    reason: "Recorded reason", exit_code: "Exit code",
    slurm_state: "Scheduler state", missing_outputs: "Missing outputs at the time",
    failure_hints: "Recorded failure hints",
    out: "Output", err: "Errors", submission: "Submission errors", refresh: "Refresh log",
    idle: "Select Refresh log to read this attempt’s log.",
    loading: "Reading log…",
    empty: "This log is currently empty.",
    missing: "This attempt’s log is missing or was not saved.",
    disconnected: "The remote server is disconnected; the log has not been read.",
    changed: "The record changed. Refresh run history before opening its log.",
    failed: "Could not read this log; it has not been confirmed empty.",
    unavailable: "A verifiable log source is not available.",
    prepared: "This is a prepared plan, without execution logs.",
    notRecorded: "Not recorded", noneListed: "None listed in the record",
    local: "Locally saved log", remote: "Remote log",
    retrieved: "Retrieved", truncated: "Only the final part is shown; the log is truncated.",
  };
  const scope = () => JSON.stringify(remote);
  window.addEventListener("workspace-remote-context", event => {
    const next = {connected: event.detail?.connected === true, identity: event.detail?.identity ?? "", environmentKey: event.detail?.environmentKey ?? ""};
    if (JSON.stringify(next) === scope()) return;
    remote = next;
    for (const view of views) view.remoteChanged();
  });

  function mount({host, token, inline = false}) {
    host.innerHTML = `<details class="ml-job-logs" data-job-logs${inline ? " open" : ""}>
      <summary data-job-log-title${inline ? " hidden" : ""}></summary>
      <div class="ml-job-log-content">
        <h4 data-job-log-errors-title></h4><dl class="ml-key-values" data-job-error-details></dl>
        <div class="ml-job-log-actions">
          <button type="button" class="ml-nav-action" data-job-log-stream="out" aria-pressed="true"></button>
          <button type="button" class="ml-nav-action" data-job-log-stream="err" aria-pressed="false"></button>
          <button type="button" class="ml-nav-action" data-job-log-stream="submission" aria-pressed="false"></button>
          <button type="button" class="ml-nav-action" data-job-log-refresh></button>
        </div>
        <p data-job-log-status role="status"></p><p class="ml-job-log-source" data-job-log-source hidden></p>
        <pre data-job-log-text hidden></pre>
      </div></details>`;
    const details = host.querySelector("[data-job-logs]");
    const status = host.querySelector("[data-job-log-status]");
    const text = host.querySelector("[data-job-log-text]");
    const source = host.querySelector("[data-job-log-source]");
    const streams = [...host.querySelectorAll("[data-job-log-stream]")];
    const refresh = host.querySelector("[data-job-log-refresh]");
    let context = {}, key = "", entry = {open: false, stream: "out", buffers: {}}, request, generation = 0, destroyed = false;
    const identity = value => JSON.stringify([value.historyId, value.runId, value.source, value.datasetId, value.step,
      value.number ?? null, value.current === true, value.recordFile, value.recordIdentity, value.record?.job_id ?? null,
      value.operation, value.recordRevision, scope()]);
    const canRead = () => Boolean(context.historyId && context.runId && (context.step || context.operation && context.recordRevision) &&
      context.recordIdentity && context.record && !context.prepared);
    function visible() {
      if (context.visible === false || !host.isConnected) return false;
      for (let parent = host; parent; parent = parent.parentElement) {
        if (parent.hidden || parent.tagName === "DETAILS" && parent !== details && !parent.open) return false;
      }
      return true;
    }
    function abort() {
      generation++;
      request?.abort(); request = null;
      for (const buffer of Object.values(entry.buffers)) if (buffer.state === "loading") buffer.state = buffer.value ? "ready" : "idle";
    }
    function remember() {
      if (!key) return;
      cache.delete(key); cache.set(key, entry);
      if (cache.size > 64) cache.delete(cache.keys().next().value);
    }
    function render() {
      host.hidden = !context.record;
      host.querySelector("[data-job-log-title]").textContent = copy.title;
      host.querySelector("[data-job-log-errors-title]").textContent = copy.errors;
      const errors = host.querySelector("[data-job-error-details]"); errors.replaceChildren();
      for (const field of ["reason", "slurm_state", "exit_code", "missing_outputs", "failure_hints"]) {
        const term = document.createElement("dt"), value = document.createElement("dd");
        term.textContent = copy[field];
        const saved = field === "exit_code" ? context.record?.exit_code ?? context.record?.returncode : context.record?.[field];
        value.textContent = Array.isArray(saved) ? saved.length ? saved.join("\n") : copy.noneListed
          : saved == null ? copy.notRecorded : String(saved);
        errors.append(term, value);
      }
      for (const button of streams) {
        button.textContent = copy[button.dataset.jobLogStream];
        button.setAttribute("aria-pressed", String(entry.stream === button.dataset.jobLogStream));
        button.hidden = Boolean(context.operation) && button.dataset.jobLogStream === "submission";
        button.disabled = !canRead();
      }
      refresh.textContent = copy.refresh;
      const buffer = entry.buffers[entry.stream] ?? {state: "idle"};
      refresh.disabled = !canRead() || buffer.state === "loading";
      const value = buffer.value;
      status.textContent = context.prepared ? copy.prepared : !canRead() ? copy.unavailable : buffer.state === "error"
        ? `${copy[buffer.errorKind]}${buffer.error ? " " + buffer.error : ""}`
        : buffer.state === "ready" ? value.status === "empty" ? copy.empty : value.truncated ? copy.truncated : ""
          : copy[buffer.state === "loading" ? "loading" : "idle"];
      text.hidden = buffer.state !== "ready" || value.status === "empty";
      text.textContent = text.hidden ? "" : value.lines.join("\n");
      source.hidden = buffer.state !== "ready";
      source.textContent = source.hidden ? "" : `${copy[value.origin]} · ${copy.retrieved}: ${buffer.at}`;
      details.dataset.logState = buffer.state;
    }
    async function load(force = false) {
      if (!details.open || !visible() || !canRead()) return;
      const stream = entry.stream, prior = entry.buffers[stream];
      if (prior?.state === "loading" || !force && ["ready", "error"].includes(prior?.state)) return;
      abort();
      const controller = new AbortController(); request = controller;
      const captured = {...context}, capturedKey = key, epoch = generation;
      const buffer = {state: "loading", value: prior?.value, at: prior?.at}; entry.buffers[stream] = buffer; remember(); render();
      const params = new URLSearchParams({identity: captured.recordIdentity, stream, lines: "50"});
      if (captured.operation) params.set("record_revision", captured.recordRevision);
      else {params.set("attempt", captured.number == null ? "unknown" : String(captured.number));
        params.set("job_id", captured.record.job_id == null ? "none" : String(captured.record.job_id));}
      const path = captured.operation ? `operations/${encodeURIComponent(captured.operation)}` : `steps/${encodeURIComponent(captured.step)}`;
      try {
        const response = await fetch(`/signet/history/${encodeURIComponent(captured.historyId)}/${path}/log?${params}`,
          {headers: {"X-Chat-Token": typeof token === "function" ? token() : token}, signal: controller.signal});
        const value = await response.json().catch(() => null);
        if (controller.signal.aborted || destroyed || epoch !== generation || capturedKey !== key || entry.stream !== stream || !visible() || !details.open) return;
        if (!response.ok || !value) throw Object.assign(new Error(value?.error ?? ""), {status: response.status});
        const targetMatches = captured.operation ? value.operation === captured.operation && value.record_revision === captured.recordRevision
          : value.step === captured.step && value.attempt === (captured.number ?? null) && String(value.job_id ?? "none") === String(captured.record.job_id ?? "none");
        if (value.history_id !== captured.historyId || value.run_id !== captured.runId || value.source !== captured.source || value.identity !== captured.recordIdentity || !targetMatches ||
            value.stream !== stream || !["ready", "empty"].includes(value.status) || !["local", "remote"].includes(value.origin) ||
            !Array.isArray(value.lines) || value.lines.some(line => typeof line !== "string")) throw Error("");
        buffer.state = "ready"; buffer.value = value;
        buffer.at = new Date().toLocaleTimeString("en");
      } catch (error) {
        if (controller.signal.aborted || destroyed || epoch !== generation || capturedKey !== key) return;
        buffer.state = "error"; buffer.value = null; buffer.error = error.message;
        buffer.errorKind = ({404: "missing", 409: "changed", 412: "disconnected"})[error.status] ?? "failed";
      } finally {
        if (!destroyed && epoch === generation && capturedKey === key) {request = null; render();}
      }
    }
    function toggle(event) {
      if (event.target !== details && !event.target.contains?.(details)) return;
      if (event.target === details) {entry.open = details.open; remember();}
      if (!details.open || !visible()) {abort(); render();} else void load();
    }
    host.ownerDocument.addEventListener("toggle", toggle, true);
    for (const button of streams) button.addEventListener("click", () => {
      if (entry.stream === button.dataset.jobLogStream) return;
      abort(); entry.stream = button.dataset.jobLogStream; remember(); render(); void load();
    });
    refresh.addEventListener("click", () => void load(true));
    const view = {
      setContext(next) {
        const nextKey = identity(next);
        if (nextKey !== key) {
          abort(); context = next; key = nextKey;
          entry = cache.get(key) ?? {open: false, stream: "out", buffers: {}};
          details.open = inline || entry.open;
        } else context = next;
        if (!visible()) abort();
        render();
        if (inline) void load();
      },
      remoteChanged() {
        abort(); key = ""; details.open = inline;
        view.setContext(context);
        entry.open = false; details.open = inline;
      },
      destroy() {
        abort(); destroyed = true; views.delete(view);
        host.ownerDocument.removeEventListener("toggle", toggle, true);
      },
    };
    views.add(view);
    render(); window.dispatchEvent(new Event("workspace-request-remote-context"));
    return view;
  }
  window.SignetJobLogs = {mount};
})();
