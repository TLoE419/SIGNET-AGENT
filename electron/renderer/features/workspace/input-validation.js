(() => {
  "use strict";
  const kinds = ["genotype", "expression", "clinical"];
  const checkIds = ["genotype_format", "expression_format", "clinical_format"];
  const names = {
    genotype: ["基因型資料", "Genotype data"], expression: ["基因表現量資料", "Expression data"],
    clinical: ["臨床資料", "Clinical data"],
  };
  const statusNames = {
    passed: ["結構檢查通過", "Structure passed"], warning: ["有警示", "Warning"],
    failed: ["檢查未通過", "Failed"], incomplete: ["檢查未完整完成", "Incomplete"], unchecked: ["未檢查", "Unchecked"],
  };
  const stageStatuses = {
    ready: ["輸入檢查通過", "Input checks passed"], needs_review: ["需要確認", "Needs review"],
    blocked: ["輸入問題待修正", "Input issues must be corrected"], incomplete: ["尚未完整檢查", "Not fully checked"],
  };
  const pairingNames = {
    genotype_patients: ["基因型個體", "Genotype patients"], expression_patients: ["表現量個體", "Expression patients"],
    matched_patients: ["兩者配對的個體", "Matched patients"], clinical_matched: ["具臨床資料的配對個體", "Matched with clinical data"],
    unmatched_genotype: ["未配對的基因型個體", "Unmatched genotype patients"], unmatched_expression: ["未配對的表現量個體", "Unmatched expression patients"],
    missing_race: ["配對中需核對的族群缺值", "Matched patients with missing or unknown race"], missing_gender: ["缺少性別資料的配對個體", "Matched patients missing gender"],
    race_groups: ["族群類別數", "Race groups"], gender_groups: ["性別類別數", "Gender groups"],
  };
  const metricNames = {
    samples: ["樣本數", "Samples"], patients: ["個體數", "Patients"], variants: ["變異數", "Variants"],
    genes: ["基因數", "Genes"], rows: ["資料列數", "Rows"], columns: ["欄位數", "Columns"],
    sample_count: ["樣本數", "Samples"], patient_count: ["個體數", "Patients"], variant_count: ["變異數", "Variants"],
    gene_count: ["基因數", "Genes"], format: ["辨識格式", "Detected format"],
    markers: ["變異標記數", "Markers"], ped_markers: ["基因型檔中的變異標記數", "Markers in genotype file"],
    duplicate_sample_ids: ["重複樣本編號數", "Duplicate sample IDs"], duplicate_patients: ["重複個體編號數", "Duplicate patient IDs"],
    fid_iid_mismatches: ["家族與個體編號不一致數", "Family/individual ID mismatches"],
    data_rows: ["表現量資料列數", "Expression data rows"], trailing_rows: ["流程會移除的末端資料列數", "Trailing rows removed by the workflow"],
    missing_race: ["族群缺值、未知或未回報的資料列數", "Rows with missing, unknown or unreported race"], missing_gender: ["缺少性別資料列數", "Rows missing gender"],
  };
  const expressionScale = "The pinned workflow interprets values as log2(count+1) and discards the last five rows. Numeric shape cannot prove that this scale and row removal are intended.";
  const issueTranslations = {
    clinical_choices: "有流程無法辨識的族群值，需在第 3 階段由研究者選擇處理方式；可繼續第 1 階段。",
    missing_covariates: "部分配對個體仍缺少族群或性別資料，需在第 3 階段送出前處理。",
    adjustment_groups: "目前第 3 階段流程要求其支援的三種族群與至少兩種性別組別；這是此流程的限制，不是所有臨床檔案的通用格式規則。",
    clinical_coverage: "部分配對個體沒有對應的臨床資料。",
    input_freeze: "第 1 階段保存這組資料的輸入版本前，每個選定檔案都必須可讀且完成檢查。",
    clinical_columns: "臨床資料必須各有一個樣本編號、族群與性別欄位（submitter_id、race、gender）。",
    clinical_width: "臨床資料每列的欄位數必須與以定位字元分隔的標題列一致。",
    clinical_rows: "臨床資料必須包含標題列與個體資料列。",
    sample_identifier: "部分樣本編號不包含此流程要求的 TCGA 個體編號區段。",
    no_overlap: "基因型與表現量資料沒有相同的 TCGA 個體編號區段。",
    unmatched_samples: "部分個體只出現在一種輸入中，後續配對會排除這些個體。",
    ambiguous_patient: "重複的個體編號區段可能造成配對歧義；這個預覽不會重現後續的重複樣本篩選。",
  };

  window.SignetInputValidation = {
    create({root, getDataset}) {
      const button = root.querySelector("[data-input-validate]");
      const panel = root.querySelector("[data-input-validation]");
      let remote = {connected: false, identity: "", environmentKey: ""};
      let selection;
      let state = "idle";
      let report = null;
      let error = "";
      let pending = null;
      const local = (zh, en) => root.lang === "en" ? en : zh;
      const label = (values) => values?.[root.lang === "en" ? 1 : 0];
      const messageText = (message, code) => root.lang === "en" ? message : code === "expression_scale" || message === expressionScale
        ? "目前流程會把數值解讀為 log2(count+1)，並移除最後五列。數值結構檢查無法證明原始資料確實採用這種尺度，或這五列應被移除；請確認資料來源與處理方式。"
        : issueTranslations[code] ?? message;
      const element = (tag, text, attributes = {}) => {
        const node = document.createElement(tag);
        if (text !== undefined && text !== null) node.textContent = String(text);
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
        return node;
      };
      const inputsKey = (inputs) => JSON.stringify(kinds.map(kind => inputs?.[kind]));
      function snapshot() {
        const dataset = getDataset() ?? {};
        const inputs = Object.fromEntries(kinds.map(kind => [kind, [...(dataset.inputs?.[kind] ?? [])]]));
        return {...dataset, inputs, key: JSON.stringify([dataset.id, inputsKey(inputs), remote.connected, remote.identity, remote.environmentKey])};
      }
      function invalidate() {
        pending?.controller.abort();
        pending = null;
        report = null;
        error = "";
      }
      function sync() {
        const next = snapshot();
        if (selection && next.key !== selection.key) {
          const attempted = pending || report || state !== "idle";
          const changedDataset = next.id !== selection.id;
          invalidate();
          state = attempted && !changedDataset ? "stale" : "idle";
        }
        selection = next;
        render();
      }
      function addIssues(parent, issues) {
        if (!Array.isArray(issues) || !issues.length) return;
        const list = element("ul");
        for (const issue of issues) {
          if (!issue || typeof issue.message !== "string") continue;
          const line = Number.isInteger(issue.line) ? local(`第 ${issue.line} 列：`, `Line ${issue.line}: `) : "";
          const stage = [1, 2, 3].includes(issue.stage) ? local(`第 ${issue.stage} 階段：`, `Stage ${issue.stage}: `) : "";
          list.append(element("li", stage + line + messageText(issue.message, issue.code), {"data-validation-issue": issue.code ?? ""}));
        }
        if (list.childElementCount) parent.append(list);
      }
      function addValues(parent, values, labels, attribute) {
        const list = element("dl", null, {class: "ml-key-values"});
        for (const [key, value] of Object.entries(values ?? {})) {
          if (value === null || !["string", "number", "boolean"].includes(typeof value)) continue;
          const title = label(labels[key]) ?? key.replaceAll("_", " ");
          list.append(element("dt", title), element("dd", typeof value === "boolean" ?
            (value ? local("是", "Yes") : local("否", "No")) : value, attribute ? {[attribute]: key} : {}));
        }
        if (list.childElementCount) parent.append(list);
      }
      function renderReport() {
        const checkedAt = element("p");
        checkedAt.append(element("span", local("檢查時間：", "Checked at: ")),
          element("time", report.checked_at, {datetime: report.checked_at, "data-validation-time": ""}));
        panel.append(checkedAt);
        if (report.stage_readiness) {
          const section = element("section", null, {class: "ml-validation-check", "data-validation-stage-readiness": ""});
          section.append(element("h3", local("各階段的輸入適用性", "Stage-specific input checks")));
          for (const stage of ["1", "2", "3"]) {
            const check = report.stage_readiness[stage];
            const entry = element("div", null, {"data-validation-stage": stage, "data-status": check.status});
            entry.append(element("h4", local(`第 ${stage} 階段`, `Stage ${stage}`)), element("p", label(stageStatuses[check.status])));
            addIssues(entry, check.issues);
            section.append(entry);
          }
          section.append(element("p", local("這是輸入檢查，不代表階段已可送出；各階段仍會核對當次輸出、設定與執行環境。", "These are input checks, not submission approval. Each stage still reviews its actual upstream outputs, settings and execution environment.")));
          panel.append(section);
        }
        for (const check of report.checks) {
          const section = element("section", null, {class: "ml-validation-check", "data-validation-check": check.id, "data-status": check.status});
          const heading = element("div", null, {class: "ml-validation-heading"});
          heading.append(element("h3", label(names[check.kind]) ?? check.label),
            element("span", label(statusNames[check.status]), {class: "ml-validation-status", "data-status": check.status}));
          section.append(heading);
          const paths = element("ul");
          for (const path of check.paths ?? []) {
            const entry = element("li");entry.append(element("code", path));paths.append(entry);
          }
          if (paths.childElementCount) section.append(paths);
          if (check.message) section.append(element("p", messageText(check.message, check.issues?.[0]?.code), {"data-validation-message": ""}));
          addValues(section, check.metrics, metricNames);
          addIssues(section, check.issues);
          panel.append(section);
        }
        const pairing = report.pairing;
        const match = element("section", null, {class: "ml-validation-check", "data-validation-pairing": "", "data-status": pairing.status});
        const heading = element("div", null, {class: "ml-validation-heading"});
        heading.append(element("h3", local("初步樣本配對摘要", "Preliminary sample matching")),
          element("span", label(statusNames[pairing.status]), {class: "ml-validation-status", "data-status": pairing.status}));
        match.append(heading);
        const rule = pairing.rule === "TCGA patient = third dash-separated identifier component; preliminary before QC."
          ? local("以識別碼第三個連字號分段作為 TCGA 個體編號；這是品質控制前的初步配對。", pairing.rule) : pairing.rule;
        if (rule) match.append(element("p", local("配對規則：", "Matching rule: ") + rule));
        if (pairing.status === "unchecked") match.append(element("p", local("目前尚無可用的樣本配對統計。", "Sample matching statistics are not available yet.")));
        else addValues(match, Object.fromEntries(Object.keys(pairingNames).map(key => [key, pairing[key]])), pairingNames, "data-pairing-count");
        addIssues(match, pairing.issues);
        match.append(element("p", local("此處依原始輸入預覽配對。第 3 階段會使用前處理後的實際輸出重新核對。", "This previews pairing from the original inputs. Stage 3 checks pairing again using the actual preprocessed outputs.")));
        panel.append(match);
        if (report.files?.length) {
          const details = element("details");
          details.open = true;
          details.append(element("summary", local("各檔案的檢查範圍", "File check coverage")));
          const table = element("table", null, {class: "ml-validation-files"});
          const head = element("tr");
          for (const title of [local("檔案", "File"), local("大小（位元組）", "Size (bytes)"), local("掃描範圍", "Scan coverage")]) head.append(element("th", title));
          const thead = element("thead");thead.append(head);table.append(thead);
          const body = element("tbody");
          for (const file of report.files) {
            const row = element("tr", null, {"data-validation-file": file.path});
            const path = element("td");path.append(element("code", file.path));
            row.append(path, element("td", file.size ?? "—"), element("td", file.complete ? local("完整", "Complete") : local("未完整掃描", "Incomplete scan")));
            body.append(row);
          }
          table.append(body);details.append(table);panel.append(details);
        }
        if (report.limits?.max_seconds) panel.append(element("p", local(
          `檢查時間上限：${report.limits.max_seconds} 秒。超出範圍的檔案會標為未完整檢查。`,
          `Check time limit: ${report.limits.max_seconds} seconds. Files outside the scan limits remain incomplete.`), {"data-validation-limits": ""}));
        panel.append(element("p", local("這是目前檔案的格式與配對檢查結果，尚未執行分析。", "These are format and matching checks for the current files. No analysis has been run.")));
      }
      function render() {
        const enabled = selection?.id && selection.persisted && selection.ready && remote.connected;
        const effectiveState = !enabled ? "unavailable" : state;
        panel.dataset.validationState = effectiveState;
        panel.dataset.datasetId = selection?.id ?? "";
        button.disabled = !enabled || Boolean(pending);
        button.textContent = pending ? local("正在檢查輸入資料…", "Checking input files…") : local("檢查輸入資料", "Validate input files");
        panel.replaceChildren(element("h2", local("輸入資料檢查", "Input file validation"), {id: "ml-input-validation-title"}));
        const datasetName = selection?.name?.[root.lang === "en" ? 1 : 0];
        if (datasetName) panel.append(element("p", datasetName));
        let message = local("選好檔案後，按「檢查輸入資料」查看格式及樣本配對。", "Select the input files, then choose Validate input files to check formats and sample matching.");
        if (!remote.connected) message = local("請先到設定連線遠端，再回來檢查輸入資料。", "Connect to the remote server in Settings, then validate the input files.");
        else if (!selection?.persisted || !selection.ready) message = local("請先選擇已儲存且可讀取的資料組。", "Select a saved, available dataset first.");
        else if (state === "checking") message = local("正在讀取並檢查選定檔案；不會啟動分析工作。", "Reading and checking the selected files. This does not start an analysis.");
        else if (state === "stale") message = error || local("檔案或遠端環境已變更，請重新檢查。", "The files or remote context changed. Validate again.");
        else if (state === "unavailable") message = error || local("無法完成檢查，請確認遠端連線與檔案後重試。", "The check could not complete. Review the remote connection and files, then retry.");
        else if (report?.stage_readiness?.["1"].status === "ready" && report.status !== "incomplete") message = local(
          "第 1 階段的輸入檢查通過，可繼續核對第 1 階段設定。後續階段如有問題，仍須在該階段送出前處理。",
          "Stage 1 input checks passed; you can continue to its settings review. Resolve any later-stage input issues before submitting that stage.");
        else if (report) message = {
          passed: local("檔案結構檢查通過。", "File structure checks passed."),
          warning: local("檢查已完成，仍有需要確認的警示。", "Checks completed with warnings that need review."),
          failed: local("輸入資料未通過檢查，請修正下列問題。", "The input files did not pass validation. Correct the issues below."),
          incomplete: local("檢查未完整完成，尚無法確認所有輸入資料。", "The scan is incomplete. All input files have not been confirmed."),
        }[report.status];
        panel.append(element("p", message, {"data-validation-summary": "", role: "status"}));
        if (enabled && report) renderReport();
      }
      function isReport(value, captured) {
        const matching = value && value.dataset_id === captured.id && inputsKey(value.inputs) === inputsKey(captured.inputs) &&
          ["passed", "warning", "failed", "incomplete"].includes(value.status) && value.read_only === true && value.executed === false &&
          Array.isArray(value.checks) && value.checks.length === checkIds.length && checkIds.every(id => value.checks.filter(check => check?.id === id).length === 1) &&
          value.checks.every(check => kinds.includes(check.kind) && checkIds[kinds.indexOf(check.kind)] === check.id &&
            ["passed", "warning", "failed", "unchecked"].includes(check.status) && Array.isArray(check.paths) && check.paths.every(path => typeof path === "string")) &&
          value.pairing && ["passed", "warning", "failed", "unchecked"].includes(value.pairing.status) && typeof value.checked_at === "string";
        if (!matching) return false;
        if (value.stage_readiness !== undefined) {
          const stages = value.stage_readiness;
          if (!stages || Array.isArray(stages) || Object.keys(stages).length !== 3 || !["1", "2", "3"].every(stage => {
            const check = stages[stage];
            return check && Object.hasOwn(stageStatuses, check.status) && Array.isArray(check.issues) && check.issues.every(issue =>
              issue && typeof issue.code === "string" && typeof issue.message === "string" && [1, 2, 3].includes(issue.stage) &&
              ["warning", "needs_review", "error"].includes(issue.severity)) &&
              !(check.status === "ready" && check.issues.some(issue => issue.severity !== "warning"));
          })) return false;
          if (stages["1"].status === "ready" && (
            value.status === "incomplete" ||
            !["passed", "warning"].includes(value.checks.find(check => check.kind === "genotype")?.status) ||
            !Array.isArray(value.files) || value.files.length !== kinds.flatMap(kind => captured.inputs[kind]).length ||
            kinds.flatMap(kind => captured.inputs[kind]).some(path => value.files.filter(file => file?.path === path && file.complete === true &&
              typeof file.sha256 === "string" && /^[a-f0-9]{64}$/.test(file.sha256)).length !== 1))) return false;
          for (const [stage, kind] of [["2", "expression"], ["3", "clinical"]]) {
            if (stages[stage].status === "ready" && !["passed", "warning"].includes(value.checks.find(check => check.kind === kind)?.status)) return false;
          }
          if (stages["3"].status === "ready" && !["passed", "warning"].includes(value.pairing.status)) return false;
          if (value.status === "passed" && Object.values(stages).some(check => check.status !== "ready")) return false;
        }
        if (value.status === "passed" && (value.checks.some(check => check.status !== "passed") || value.pairing.status !== "passed" ||
            !Array.isArray(value.files) || value.files.length !== kinds.flatMap(kind => captured.inputs[kind]).length || value.files.some(file => file?.complete !== true))) return false;
        return true;
      }
      async function validate() {
        sync();
        if (button.disabled || pending) return;
        const captured = snapshot();
        const attempt = {key: captured.key, controller: new AbortController()};
        pending = attempt;state = "checking";report = null;error = "";render();
        try {
          const token = document.querySelector('meta[name="chat-token"]')?.content ?? "";
          const response = await fetch(`/signet/datasets/${encodeURIComponent(captured.id)}/validate`, {
            method: "POST", headers: {"Content-Type": "application/json", "X-Chat-Token": token},
            body: JSON.stringify({inputs: captured.inputs}), signal: attempt.controller.signal,
          });
          const value = await response.json().catch(() => null);
          if (pending !== attempt || attempt.controller.signal.aborted || snapshot().key !== captured.key) return;
          if (!response.ok || !isReport(value, captured)) {
            state = response.status === 409 ? "stale" : "unavailable";
            error = value?.error || value?.reason || local("服務未回傳這組資料完整且相符的檢查結果。", "The service did not return a complete, matching validation report for this dataset.");
          } else {
            report = value;state = value.status;
          }
        } catch (cause) {
          if (pending === attempt && !attempt.controller.signal.aborted) {
            state = "unavailable";error = cause.message || local("無法連線至檢查服務。", "Could not reach the validation service.");
          }
        } finally {
          if (pending === attempt) {pending = null;sync();}
        }
      }
      button.addEventListener("click", () => void validate());
      window.addEventListener("workspace-remote-context", event => {
        const detail = event.detail ?? {};
        remote = {connected: detail.connected === true, identity: typeof detail.identity === "string" ? detail.identity : "",
          environmentKey: typeof detail.environmentKey === "string" ? detail.environmentKey : ""};
        sync();
      });
      sync();
      window.dispatchEvent(new Event("workspace-request-remote-context"));
      return {sync};
    },
  };
})();
