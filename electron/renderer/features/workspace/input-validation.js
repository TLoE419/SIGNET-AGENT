(() => {
  "use strict";
  const fileTypes = {
    genotype: {
      title: "Genotype file validation", action: "Validate genotype files",
      description: "Check the PED and MAP formats and confirm the files match.",
    },
    expression: {
      title: "Expression file validation", action: "Validate expression file",
      description: "Check the format of the selected gene expression file.",
    },
    clinical: {
      title: "Clinical file validation", action: "Validate clinical file",
      description: "Check the clinical file format and required columns.",
    },
  };
  const kinds = Object.keys(fileTypes);
  const exampleAliases = {
    genotype: ["study.ped", "study.map"], expression: ["example_gexp"],
    clinical: ["official-demo-chr1-restart-clinical.tsv"],
  };
  const names = {
    genotype: "Genotype data", expression: "Expression data",
    clinical: "Clinical data",
  };
  const statusNames = {
    passed: "Structure passed", warning: "Warning",
    failed: "Failed", incomplete: "Incomplete", unchecked: "Unchecked",
  };
  const reportStatuses = {
    idle: "Not checked", checking: "Checking",
    passed: "Passed", warning: "Warnings",
    failed: "Action needed", incomplete: "Incomplete",
    stale: "Recheck required", unavailable: "Unavailable",
  };
  const metricNames = {
    samples: "Samples", patients: "Patients", variants: "Variants",
    genes: "Genes", rows: "Rows", columns: "Columns",
    sample_count: "Samples", patient_count: "Patients", variant_count: "Variants",
    gene_count: "Genes", format: "Detected format",
    markers: "Markers", ped_markers: "Markers in genotype file",
    duplicate_sample_ids: "Duplicate sample IDs", duplicate_patients: "Duplicate patient IDs",
    fid_iid_mismatches: "Family/individual ID mismatches",
    data_rows: "Expression data rows", trailing_rows: "Trailing rows removed by the workflow",
    missing_race: "Rows with missing, unknown or unreported race", missing_gender: "Rows missing gender",
  };
  window.SignetInputValidation = {
    create({root, getDataset, renderFilePath}) {
      const panel = root.querySelector("[data-input-validation]");
      let remote = {connected: false, identity: "", environmentKey: ""};
      let selection;
      let selectedKind = "genotype";
      const records = new Map();
      const element = (tag, text, attributes = {}) => {
        const node = document.createElement(tag);
        if (text !== undefined && text !== null) node.textContent = String(text);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
      };
      const badge = (text, status) => element("span", text, {class: "ml-validation-status", "data-status": status});
      const title = element("h2", "", {id: "ml-input-validation-title"});
      const meta = element("p", null, {class: "ml-validation-meta"});
      const titleBlock = element("div", null, {class: "ml-validation-title"});
      titleBlock.append(title, meta);
      const action = element("button", "", {
        type: "button", class: "ml-input-button ml-input-primary", "data-validation-action": "",
      });
      const header = element("header", null, {class: "ml-validation-header"});
      header.append(titleBlock, action);
      const overview = element("div", null, {class: "ml-validation-overview"});
      const overviewBadge = badge("", "idle");
      const summary = element("p", "", {"data-validation-summary": "", role: "status"});
      overview.append(overviewBadge, summary);
      const results = element("div", null, {class: "ml-validation-results"});
      results.hidden = true;
      panel.replaceChildren(header, overview, results);
      let renderedReport = null;
      let renderedDatasetName;
      const samePaths = (left, right) => Array.isArray(left) && left.length === right.length &&
        left.every((path, index) => path === right[index]);
      function sync() {
        const dataset = getDataset() ?? {};
        const inputs = Object.fromEntries(kinds.map(kind => [kind, [...(dataset.inputs?.[kind] ?? [])]]));
        if (selection?.id !== dataset.id) {
          for (const record of records.values()) record.pending?.abort();
          records.clear();
        }
        for (const kind of kinds) {
          const key = JSON.stringify([inputs[kind], dataset.persisted, dataset.ready, remote.connected, remote.identity, remote.environmentKey]);
          const previous = records.get(kind);
          if (previous?.key === key) continue;
          previous?.pending?.abort();
          records.set(kind, {
            key, state: previous && previous.state !== "idle" ? "stale" : "idle",
            report: null, error: "", pending: null,
          });
        }
        selection = {...dataset, inputs};
        render();
      }
      function addIssues(parent, issues) {
        if (!Array.isArray(issues) || !issues.length) return;
        const list = element("ul", null, {class: "ml-validation-issues"});
        for (const issue of issues) {
          if (!issue || typeof issue.message !== "string") continue;
          const line = Number.isInteger(issue.line) ? `Line ${issue.line}: ` : "";
          list.append(element("li", line + issue.message, {
            "data-validation-issue": issue.code ?? "", "data-severity": issue.severity ?? "",
          }));
        }
        if (list.childElementCount) parent.append(list);
      }
      function addValues(parent, values) {
        const list = element("dl", null, {class: "ml-key-values"});
        for (const [key, value] of Object.entries(values ?? {})) {
          if (value === null || !["string", "number", "boolean"].includes(typeof value)) continue;
          const title = metricNames[key] ?? key.replaceAll("_", " ");
          list.append(element("dt", title), element("dd", typeof value === "boolean" ?
            (value ? "Yes" : "No") : value));
        }
        if (list.childElementCount) parent.append(list);
      }
      function renderReport(report) {
        const group = element("section", null, {class: "ml-validation-details"});
        group.append(element("h3", "Check details"));
        function detail(key, heading, attributes, status, open) {
          const details = element("details", null, {class: "ml-validation-check", "data-validation-section": key, ...attributes});
          details.open = open;
          const summary = element("summary", null, {class: "ml-validation-heading"});
          summary.append(element("span", heading, {class: "ml-validation-name"}));
          if (status) {
            details.dataset.status = status;
            summary.append(badge(statusNames[status], status));
          }
          const body = element("div", null, {class: "ml-validation-body"});
          details.append(summary, body);
          group.append(details);
          return body;
        }
        for (const check of report.checks) {
          const body = detail(check.id, names[check.kind] ?? check.label, {"data-validation-check": check.id}, check.status, check.status !== "passed");
          const issues = Array.isArray(check.issues) ? check.issues : [];
          if (check.message) {
            const duplicatesIssue = issues.some(issue => issue?.message === check.message);
            if (!duplicatesIssue) body.append(element("p", check.message, {"data-validation-message": ""}));
          }
          addIssues(body, issues);
          addValues(body, check.metrics);
          const paths = element("ul", null, {class: "ml-validation-paths"});
          for (const path of check.paths ?? []) {
            const item = element("li");
            item.append(renderFilePath(path, {includeFilename: true}));
            paths.append(item);
          }
          if (paths.childElementCount) body.append(paths);
        }
        const scannedFiles = Array.isArray(report.files) ? report.files.filter(file => typeof file?.path === "string") : [];
        if (scannedFiles.length || report.status === "incomplete") {
          const body = detail("coverage", "File check coverage", {}, null,
            report.status === "incomplete" || scannedFiles.some(file => file.complete !== true));
          if (scannedFiles.length) {
            const table = element("table", null, {class: "ml-validation-files"});
            const head = element("tr");
            for (const heading of ["File", "Size (bytes)", "Scan coverage"]) {
              head.append(element("th", heading, {scope: "col"}));
            }
            const thead = element("thead");
            thead.append(head);
            table.append(thead);
            const rows = element("tbody");
            for (const file of scannedFiles) {
              const row = element("tr", null, {"data-validation-file": file.path});
              const path = element("td");
              path.append(renderFilePath(file.path, {includeFilename: true}));
              row.append(path, element("td", file.size ?? "—"), element("td", file.complete ? "Complete" : "Incomplete scan"));
              rows.append(row);
            }
            table.append(rows);
            body.append(table);
          } else {
            body.append(element("p", "No per-file scan records were returned for this check."));
          }
          if (report.limits?.max_seconds) body.append(element("p", `Check time limit: ${report.limits.max_seconds} seconds. Files outside the scan limits remain incomplete.`,
            {"data-validation-limits": "", class: "ml-validation-note"}));
        }
        results.append(group);
      }
      function render() {
        const {state, report, error, pending} = records.get(selectedKind);
        const type = fileTypes[selectedKind];
        const paths = selection.inputs[selectedKind];
        const saved = selection.id && selection.persisted && selection.ready;
        const enabled = Boolean(saved && remote.connected && paths.length);
        const effectiveState = !enabled ? "unavailable" : state;
        panel.dataset.validationState = effectiveState;
        panel.dataset.validationKind = selectedKind;
        panel.dataset.datasetId = selection.id ?? "";
        if (title.textContent !== type.title) title.textContent = type.title;
        action.disabled = !enabled;
        if (pending) action.setAttribute("aria-disabled", "true");
        else action.removeAttribute("aria-disabled");
        const actionLabel = pending ? "Checking…" : state !== "idle" && enabled ? "Validate again" : type.action;
        if (action.textContent !== actionLabel) action.textContent = actionLabel;
        overview.dataset.status = effectiveState;
        overviewBadge.dataset.status = effectiveState;
        const statusLabel = reportStatuses[effectiveState];
        if (overviewBadge.textContent !== statusLabel) overviewBadge.textContent = statusLabel;
        let message = type.description;
        if (!remote.connected) message = "Connect to the remote server in Settings to check the selected files.";
        else if (!saved) message = "Select a saved, available dataset first.";
        else if (!paths.length) message = "Choose files in this section before validating.";
        else if (state === "checking") message = "Checking the files in this section.";
        else if (state === "stale") message = error || "The files or remote context changed. Validate again.";
        else if (state === "unavailable") message = error || "The check could not complete. Review the remote connection and files, then retry.";
        else if (report) message = {
          passed: "The selected files passed the format check.",
          warning: "Review the warnings below.",
          failed: "Correct the file issues below.",
          incomplete: "The file check is incomplete. Review the details and scan coverage.",
        }[report.status];
        if (summary.textContent !== message) summary.textContent = message;

        const visibleReport = enabled ? report : null;
        const name = selection.name;
        const datasetName = Array.isArray(name) ? name[1] ?? name[0] ?? "" : name ?? "";
        const sameReport = visibleReport === renderedReport;
        if (!sameReport || datasetName !== renderedDatasetName) {
          meta.replaceChildren();
          if (datasetName) meta.append(element("span", datasetName));
          if (visibleReport) {
            const timestamp = new Date(visibleReport.checked_at);
            const formatted = Number.isNaN(timestamp.getTime()) ? visibleReport.checked_at
              : new Intl.DateTimeFormat("en", {dateStyle: "medium", timeStyle: "short"}).format(timestamp);
            meta.append(element("time", "Checked " + formatted,
              {datetime: visibleReport.checked_at, "data-validation-time": ""}));
          }
          renderedDatasetName = datasetName;
        }
        if (sameReport) return;
        results.replaceChildren();
        results.hidden = !visibleReport;
        if (visibleReport) renderReport(visibleReport);
        renderedReport = visibleReport;
      }

      function isReport(value, captured, kind) {
        if (!value || value.kind !== kind || value.dataset_id !== captured.id ||
            !samePaths(value.inputs?.[kind], captured.inputs[kind]) || typeof value.checked_at !== "string" ||
            !["passed", "warning", "failed", "incomplete"].includes(value.status) ||
            value.read_only !== true || value.executed !== false ||
            !Array.isArray(value.checks) || value.checks.length !== 1 || !Array.isArray(value.files)) return false;
        const check = value.checks[0];
        const selected = captured.inputs[kind];
        const resolved = value.resolved_inputs?.[kind];
        if (!Array.isArray(resolved) || Object.keys(value.resolved_inputs).length !== 1 ||
            resolved.length !== selected.length || !resolved.every((path, index) =>
              path === selected[index] || captured.id === "example-chr1" && exampleAliases[kind].includes(selected[index]) &&
              typeof path === "string" && path.startsWith("/"))) return false;
        if (!check || check.kind !== kind || check.id !== kind + "_format" || !samePaths(check.paths, resolved) ||
            !Object.hasOwn(statusNames, check.status)) return false;
        if (value.files.some(file => !file || typeof file.path !== "string" ||
            !resolved.includes(file.selected_path ?? file.path))) return false;
        if (value.status === "passed" || value.status === "warning") {
          return check.status === value.status && resolved.length === (kind === "genotype" ? 2 : 1) &&
            value.files.length === resolved.length && resolved.every(path => value.files.filter(file =>
              (file.selected_path ?? file.path) === path && file.complete === true && /^[a-f0-9]{64}$/.test(file.sha256)).length === 1);
        }
        return true;
      }

      async function validate() {
        sync();
        const kind = selectedKind;
        const record = records.get(kind);
        if (action.disabled || record.pending) return;
        const captured = selection;
        const controller = new AbortController();
        Object.assign(record, {pending: controller, state: "checking", report: null, error: ""});
        render();
        try {
          const token = document.querySelector('meta[name="chat-token"]')?.content ?? "";
          const response = await fetch(`/signet/datasets/${encodeURIComponent(captured.id)}/validate`, {
            method: "POST", headers: {"Content-Type": "application/json", "X-Chat-Token": token},
            body: JSON.stringify({inputs: captured.inputs, kind}), signal: controller.signal,
          });
          const value = await response.json().catch(() => null);
          if (controller.signal.aborted) return;
          if (!response.ok || !isReport(value, captured, kind)) {
            record.state = response.status === 409 ? "stale" : "unavailable";
            record.error = value?.error || value?.reason || "The service did not return a matching report for these files.";
          } else {
            record.report = value;
            record.state = value.status;
          }
        } catch (cause) {
          if (!controller.signal.aborted) {
            record.state = "unavailable";
            record.error = cause.message || "Could not reach the validation service.";
          }
        } finally {
          if (!controller.signal.aborted) {
            record.pending = null;
            sync();
          }
        }
      }
      action.addEventListener("click", () => void validate());
      window.addEventListener("workspace-remote-context", event => {
        const detail = event.detail ?? {};
        remote = {connected: detail.connected === true, identity: typeof detail.identity === "string" ? detail.identity : "",
          environmentKey: typeof detail.environmentKey === "string" ? detail.environmentKey : ""};
        sync();
      });
      sync();
      window.dispatchEvent(new Event("workspace-request-remote-context"));
      return {sync, select(kind) {
        if (!Object.hasOwn(fileTypes, kind)) return;
        selectedKind = kind;
        sync();
      }};
    },
  };
})();
