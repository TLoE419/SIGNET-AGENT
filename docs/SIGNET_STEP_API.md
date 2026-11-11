# SIGNET Step API

This document specifies the local HTTP API under `/signet/` that runs SIGNET steps on HPC3 as Slurm jobs. The workflow panel and any future AI tool call these routes. They never build shell or R commands themselves: every rule lives in one service, `agent/runtime/signet_jobs.py`, and the routes in `agent/app/signet_api.py` only translate HTTP into calls to it.

Steps available now (TCGA cohort only):

| Step name | SIGNET flag | What it does |
|---|---|---|
| `expression` | `signet -t` | Normalize read counts and find gene positions |
| `genotype` | `signet -g` | PLINK quality control, then IMPUTE2 imputation |
| `adjust` | `signet -a` | Match expression and genotype samples, filter rare SNPs, compute genotype PCs, regress out race, gender and PCs |
| `cis` | `signet -c` | cis-eQTL mapping: each gene's significant nearby SNPs (common, low-frequency, rare), used later as instrumental variables |
| `network` | `signet -n` | Gene regulatory network by two-stage penalized least squares on bootstrap data; SIGNET submits its own Slurm jobs (section 6.4) |

The chat tool `cis_eqtl` still runs `signet -c` through the older `remote.execute_cis()` path on the login node; the `cis` step here is the Slurm replacement.

## Contents

1. [How it fits together](#1-how-it-fits-together)
2. [Concepts: runs, steps, attempts](#2-concepts-runs-steps-attempts)
3. [Access and security](#3-access-and-security)
4. [Conventions and errors](#4-conventions-and-errors)
5. [Routes](#5-routes)
6. [Step reference](#6-step-reference)
7. [Step states](#7-step-states)
8. [Files on HPC3 and on this computer](#8-files-on-hpc3-and-on-this-computer)
9. [Worked example: -t, -g, -a in one run](#9-worked-example--t--g--a-in-one-run)
10. [Known limits](#10-known-limits)

## 1. How it fits together

```
Workflow panel / AI tool
  → /signet/* routes            agent/app/signet_api.py   (HTTP only, no rules)
  → step service                agent/runtime/signet_jobs.py  (all checks and decisions)
  → the app's SSH connection    Electron SSH transport (the user's own HPC3 login)
  → HPC3 login node             light commands only: mkdir, tar, sbatch, squeue, sacct, scancel, tail
  → Slurm job                   apptainer exec <signet image> bash ./signet <flag>
```

- One step is one Slurm job. A submit call returns as soon as Slurm accepts the job; the client then polls the status route. The job keeps running if the app or the SSH connection goes away, and the next status call picks it up.
- SIGNET itself runs only inside the container in the Slurm job, never on the login node.
- Run records and downloaded results live on this computer under `runs/<run_id>/`; the job's working files live in the run's HPC3 folder (section 8).

## 2. Concepts: runs, steps, attempts

**Run.** One analysis. A run is a local folder `runs/<run_id>/` (audited SIGNET scripts plus a `config.ini`) and one HPC3 folder `<workRoot>/<run_id>`.

- Run IDs are 1 to 64 letters, digits, `_` or `-`, starting with a letter or digit.
- `cis`, `network` and `runs` are reserved (other features use those folders under `workRoot`).
- Runs created before 2026-11-07 live in `<workRoot>/runs/<run_id>` on HPC3 and keep using it.

**Steps build on each other inside one run.** SIGNET has no notion of runs: a later step reads earlier results from its own `work/` folder, partly through `config.ini` paths and partly through fixed temporary folders (for example `-a` reads `-g`'s `tmp/tmpg/impute/`). So:

- A step lists the steps it `requires`. It is refused unless they completed **in the same run**. The error names other runs where they did complete, but their results are not used.
- A step lists the files it `needs` from earlier steps. They are checked on HPC3 before anything is queued.

**Attempt.** Each submission of a step is an attempt.

- A step that `failed` or was `cancelled` may be submitted again in the same run, so the earlier steps' results stay usable.
- Every earlier attempt is kept, never overwritten (section 8). The new record carries `attempt` (2, 3, …) and `previous_job_id`.
- Before retrying, a successful scheduler query must confirm that the previous job and this run's child jobs have stopped. This check happens before uploading a new configuration.
- A retry moves the step's previous result folder, remotely and locally, to `steps/<step>.attempt<N>.results`. Earlier steps' results stay in place; only fresh outputs can complete the new attempt.
- A `completed` step is not rerun in place: later steps may already have read its results. Compute it again in a new run.
- A step that is still active or `unknown` cannot be resubmitted; check its status first.

**One active step per run.** While a step of a run is active, no other step of that run can be submitted and its settings cannot change. Two steps of one run would otherwise share one `config.ini`.

**Success is decided by the app, not by `signet`'s exit code.** `signet` exits 0 even when a step fails. A step is `completed` only when all of these hold:

1. the job's exit marker (`steps/<step>.done`) is complete and says exit code 0,
2. every required output exists and is non-empty,
3. the job's stdout and stderr contain no known failure line (`Execution halted`, `Error in `, `cannot open`, `No such file or directory`, `command not found`, plus step-specific lines).

`completed` is not scientific validation. It means the outputs exist and the logs are clean.

## 3. Access and security

The API is served by the app's local Python backend on `127.0.0.1:<port>`. `agent/app/chat_ui.py` checks every request before it reaches `signet_api.py`:

| Check | Applies to | Failure |
|---|---|---|
| `Host` is `127.0.0.1:<port>` | every request | 403 |
| `X-Chat-Token` equals the page token | every request, **GET included** (responses name the user's runs and HPC3 paths) | 403 |
| `Origin` is `http://127.0.0.1:<port>` | POST and PATCH | 403 |

- The page obtains the token from `GET /bootstrap`. Developer scripts can do the same; see [Worked example](#9-worked-example--t--g--a-in-one-run).
- A 403 from these checks is plain text from `chat_ui.py`, not the JSON error below, and never contacts HPC3.

Inside the API:

- Bodies are JSON objects of at most 32 KB. Unknown or missing top-level fields are rejected. Query parameters are single-valued and only the listed ones are allowed.
- Inputs are absolute HPC3 paths made of letters, digits, `_`, `.`, `/` and `-` only, with no `..` and no `//`. They must lie below one of: `<workspace>/refdata/`, `<signet source>/example/`, or the run's own HPC3 folder. On HPC3, `readlink -f` must resolve each file to exactly that path, so no link can lead elsewhere.
- Settings, resources and options are checked against fixed rules (section 6). Values reach the shell only after validation, quoted.
- The HPC3 run folder holds a random owner token. A run never writes into a folder that belongs to another run.
- Cancel checks the Slurm job name (`signet-<step>-<run_id>`) on HPC3 first, so no other job can be cancelled.
- Unexpected errors return 500 `internal_error`. Details go to the backend log only, never to the page.

## 4. Conventions and errors

- Requests and responses are JSON (`application/json; charset=utf-8`).
- Times in records are local ISO 8601 with offset, for example `2026-11-08T11:24:16-0800`. `checked_at` is Unix seconds.
- Every error reply has the same shape:

```json
{"error": "Message for the user.", "code": "invalid_request"}
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `invalid_request` | Bad JSON; unknown or missing field; value out of range; path not allowed; input missing on HPC3; a required earlier step has not completed in this run |
| 403 | (plain text) | Host, Origin or token check failed |
| 404 | `not_found` | Unknown route, run or step; a step never submitted |
| 405 | `method_not_allowed` | The route exists but not for this method |
| 409 | `conflict` | Run name taken; step already completed or still active; another step of the run is active; HPC3 folder belongs to another run |
| 412 | `not_ready` | Not connected to HPC3, HPC3 too slow to answer, or the container or `sbatch` missing |
| 500 | `internal_error` | Unexpected error in the app; check the run state before retrying |
| 502 | `remote_failed` | An SSH or Slurm command on HPC3 failed (upload, sbatch, scancel) |

## 5. Routes

| # | Method and path | Contacts HPC3 | Purpose |
|---|---|---|---|
| 1 | `GET /signet/catalog` | no | Steps, inputs, settings, options, resources, outputs |
| 2 | `GET /signet/runs?session=<id>` | no | List local runs, optionally filtered by conversation |
| 3 | `POST /signet/runs` | no | Create a run |
| 4 | `GET /signet/runs/{run_id}` | no | One run's settings and full step records |
| 5 | `PATCH /signet/runs/{run_id}/settings` | no | Change settings (`signet -s`) |
| 6 | `POST /signet/runs/{run_id}/steps/{step}` | yes | Submit (or retry) a step as a Slurm job |
| 7 | `GET /signet/runs/{run_id}/steps/{step}` | yes | Step state; on completion, validate and download |
| 8 | `POST /signet/runs/{run_id}/steps/{step}/cancel` | yes | Cancel the step's own job |
| 9 | `GET /signet/runs/{run_id}/steps/{step}/log` | yes | Last lines of the job's stdout or stderr |
| 10 | `PATCH /signet/runs/{run_id}/conversation` | no | Link an analysis to a saved conversation |
| 11 | `GET /signet/progress?session=<id>` | no | Read current progress for a conversation’s linked analyses |
| 12 | `POST /signet/runs/{run_id}/genotype-proposal/prepare` | no job | Open the first-stage review in the linked chat |
| 13 | `POST /signet/runs/{run_id}/genotype-proposal/decline` | no | Close the review without submitting |
| 14 | `POST /signet/runs/{run_id}/genotype-proposal/confirm` | yes | Submit the exact reviewed first-stage parameters once |

### 5.1 `GET /signet/catalog`

What the app may offer. The panel builds its forms from this instead of hard-coding them.

Response 200:

```json
{
  "steps": [
    {
      "name": "adjust",
      "flag": "-a",
      "cohort": "TCGA",
      "description": "TCGA adjustment (signet -a): ...",
      "inputs": ["cli.file"],
      "prefix_inputs": {},
      "settings": {},
      "resources": {"cpus": 4, "mem_gb": 16, "hours": 2},
      "limits": {"cpus": [1, 16], "mem_gb": [1, 64], "hours": [0.25, 12]},
      "requires": ["expression", "genotype"],
      "options": {"npc": {"rule": "pcs", "default": 3}},
      "required_outputs": ["res/resa/signet_matched.gexp", "..."]
    }
  ],
  "input_roots": ["<workspace>/refdata", "<signet source>/example", "<this run on HPC3>"],
  "states": ["submitted", "pending", "running", "cancelling", "validating", "completed", "failed", "cancelled", "unknown"]
}
```

| Field | Meaning |
|---|---|
| `inputs` | `config.ini` keys the caller sets to HPC3 paths at submit |
| `prefix_inputs` | Inputs that are per-chromosome prefixes, not files: key → suffix (section 6.2) |
| `settings` | `config.ini` keys that may be changed with route 5, and their rule name |
| `options` | Answers to SIGNET's interactive questions, with rule and default |
| `requires` | Steps that must have completed in the same run first |
| `resources`, `limits` | Default Slurm request and the allowed range of each override |
| `required_outputs` | Files (relative to `work/`) that must exist and be non-empty for success |

### 5.2 `GET /signet/runs`

Every local run, newest first. Local files only. Optionally pass `?session=<id>` to list runs linked to one conversation.

```json
{"runs": [{"run_id": "a_test1", "cohort": "TCGA", "created_at": 1794100914, "session": null,
           "steps": {"adjust": "completed", "expression": "completed", "genotype": "completed"}}]}
```

The step states here are the last recorded ones. Use route 7 for a fresh state.

### 5.3 `POST /signet/runs`

```json
{"run_id": "luad_run1", "cohort": "TCGA"}
```

`cohort` is optional (default `TCGA`; `GTEx` is accepted for runs, but no GTEx step exists yet). This copies the audited SIGNET scripts and a fresh `config.ini` into `runs/<run_id>/`. It never overwrites a run.

- 201: `{"run_id", "cohort", "settings": {...}}`
- 400: bad name or cohort. 409: name taken.

### 5.4 `GET /signet/runs/{run_id}`

```json
{"run_id": "a_test1", "cohort": "TCGA", "settings": {"restrict.tcga.geno": "1", "...": "..."},
 "steps": {"adjust": {"state": "completed", "job_id": "59411219", "attempt": 2, "...": "..."}},
 "analysis": {"session": null, "completed_steps": 3, "total_steps": 6, "steps": ["..."]}}
```

`steps` holds the current record of each submitted step (section 7). The additive `analysis` view includes the linked conversation (`null` for unlinked runs), completion counts, and an ordered list of `{step, flag, phase, attempts}` entries for the six TCGA stages. Other cohorts have no stages in this view yet.

- `attempts` is the archived and current records, oldest first, with an explicit attempt number. New records also snapshot the step's editable settings at submission. Older records are read as-is; an absent attempt number means 1, and absent settings are not reconstructed from today's configuration.
- `phase` preserves the job state except that scheduler `pending` is reported as `queued` and a validated job whose results have not finished transferring is `downloading`. A transfer error leaves the same attempt in this phase; poll route 7 to resume checking it.
- `not_started` means no attempt exists. Visualization is `untracked` because the separate visualization workspace does not yet publish a record for the HPC3 analysis. It does not count as complete. This view does not create drafts or claim a step is awaiting approval.
- This view reads saved state only. Use route 7 to refresh scheduler status and collect results.

- 404: unknown run.

### 5.5 `PATCH /signet/runs/{run_id}/settings`

The app's `signet -s`. Only keys listed under some step's `settings` in the catalog are accepted, each checked by its rule (section 6.3).

```json
{"values": {"restrict.tcga.geno": 1, "mind": 0.05}}
```

The local `config.ini` changes now. It is sent to HPC3 with the next submitted step.

- 200: `{"settings": {...}}` (all current settings)
- 400: key not allowed or bad value. 404: unknown run. 409: a step of this run is active.

### 5.6 `POST /signet/runs/{run_id}/steps/{step}`

Submit one step as a Slurm job, or retry a failed or cancelled one.

```json
{
  "inputs":    {"cli.file": "/pub/<ucinetid>/signet-agent/refdata/clinical.tsv"},
  "resources": {"cpus": 4, "mem_gb": 16, "hours": 2},
  "options":   {"npc": 3}
}
```

- `inputs` (required): exactly the step's input keys, each an HPC3 path inside an allowed root.
- `resources` (optional): any of `cpus`, `mem_gb` (whole numbers) and `hours` (may be fractional), within the step's limits. Missing ones take the defaults.
- `options` (optional): only for steps that list `options` in the catalog. Missing ones take their default.

What happens, in order. Steps 1 to 3 run locally; nothing is sent to HPC3 if they fail.

1. The cohort, resources and options are checked.
2. The previous record of this step is checked: none, `failed` or `cancelled` may continue; `completed` or active returns 409.
3. No other step of the run may be active, and every step in `requires` must be `completed` in this run.
4. The inputs are written into the local `config.ini`. The run's scripts and `config.ini` are uploaded to its HPC3 folder.
5. A record in state `submitting` is saved before `sbatch`. A lost connection from here on may have started a job, so the record becomes `unknown`, never deleted.
6. On the login node, one script:
   - checks each input file (and each per-chromosome file of a prefix input),
   - checks each file in `needs` in the run folder,
   - checks that the container image and `sbatch` exist,
   - on a retry, renames the previous attempt's files to `<step>.attempt<N>.*`,
   - writes `steps/<step>.sbatch` and runs `sbatch`.

Response 202: the step record with `"state": "submitted"` and `"job_id"`. A retry also has `"attempt"` and `"previous_job_id"`.

If the connection dropped during `sbatch`, the response is 202 with `"state": "unknown"`. **Check the status route; never resubmit**: the job may be running.

| Status | When |
|---|---|
| 400 | Bad inputs, resources or options; wrong cohort; an input or a `needs` file missing on HPC3 (the message names it); a required step not completed in this run |
| 404 | Unknown run or step |
| 409 | Step completed or still active; another step of the run active; HPC3 folder owned by another run |
| 412 | Not connected; container or `sbatch` missing |
| 502 | Upload or `sbatch` failed |

When preflight checks refuse the submission before remote files move (400, 409 or 412), the previous record and local results are restored. Once preparation starts, the new attempt number is consumed even if `sbatch` refuses the job (502): its record remains `failed` without a job ID, its script and error are kept, and the next retry gets the next number. Existing archives are never overwritten.

### 5.7 `GET /signet/runs/{run_id}/steps/{step}[?refresh=1]`

The step's current record (section 7).

- Slurm is asked at most once every 15 seconds per step. `refresh=1` asks now.
- When Slurm reports the job ended, this call validates it (section 2): exit marker, required outputs, log lines. On success it downloads the step's result folder into the local run, so that one call takes longer.
- If the exit marker is missing or incomplete, the step stays `validating`. A later call decides.
- For a step with child jobs, a terminal control job is insufficient: a successful queue check must confirm that its children also stopped. While they drain (or the queue check fails), the run stays locked in `cancelling` for a cancelled parent or `validating` for a completed/failed parent. This also applies to normal status polling without an earlier cancel request.
- An exit marker cannot bypass that child check when the control job's scheduler state is temporarily absent. Results are not downloaded and settings remain locked until the queue check succeeds and related jobs are gone.
- A `failed` record caused only by missing outputs after exit 0 can be rechecked with `refresh=1`, and downloads if the outputs become readable. Confirmed nonzero exits, scheduler failures and known log errors remain terminal.
- `refresh=1` also rechecks an older failure whose only reason was an unconfirmed exit marker ("The job did not finish its last line."). Other failures stay final.
- If HPC3 cannot be reached, the reply is 200 with the last known record plus `"connection": "interrupted"`. The job keeps running.
- 400: `refresh` not `0` or `1`. 404: unknown run or step, or never submitted. 412: not connected.

### 5.8 `POST /signet/runs/{run_id}/steps/{step}/cancel`

Body `{}` or empty. Cancels the step's own job after checking its job name on HPC3. If the job already left the queue, the reply reports how it actually ended.

- 200: the record (`cancelling` while cancellation is pending, or its final state). A successful `scancel` only acknowledges the request. Keep polling; retry and settings changes remain blocked until the job and its children have stopped.
- If the control job already left the queue, cancellation still records the intent and waits for this run's child jobs. It does not release the settings lock merely because the parent is terminal.
- 404: never submitted. 409: already ended, or no job ID known yet. 412: not connected. 502: `scancel` failed.

### 5.9 `GET /signet/runs/{run_id}/steps/{step}/log[?stream=out|err&lines=50]`

Last lines of the job's stdout (`out`, default) or stderr (`err`) on HPC3. `lines` is 1 to 200 (default 50). Read-only. Only the current attempt's log is read.

```json
{"lines": ["[SIGNET-AGENT] START step=adjust job=59411219 ts=...", "..."], "truncated": true}
```

- 400: bad `stream` or `lines`. 404: never submitted. 412: not connected.

### 5.10 `PATCH /signet/runs/{run_id}/conversation`

Body: `{"session": "<saved conversation ID>"}`. Returns `{"run_id": "...", "session": "..."}`.
A run may be linked to one saved conversation; a conversation can have several runs. Linking the
same pair again is safe, and changing a linked run to a different conversation returns 409.
Invalid IDs return 400; unknown runs or conversations return 404. Existing runs can be linked
without starting or repeating any computation. The association is stored locally in
`runs/<run_id>/conversation.json`.


### 5.11 `GET /signet/progress?session=<id>`

Returns `{"analyses": [...]}` for TCGA runs linked to this conversation. Each entry has
`run_id`, `session`, `completed_steps`, `total_steps`, and the six ordered `steps` described in
section 5.4. Each step has `step`, `flag`, `phase`, and measured `progress` when available.
Attempt histories and job input paths are omitted. A linked genotype review is returned as
`genotype_proposal` with its own proposed or reviewed parameters, or `null` if there is none. A missing or malformed session is
rejected; a valid session with no linked runs returns an empty list.

In a saved chat, use **Track an existing analysis** to link an unassigned run. The chat updates
one card per run using this local snapshot. It checks active jobs separately via route 7, so
a long result download does not block the card or require another chat message. A lost connection
leaves the last recorded phase visible. Completed-stage counts exclude untracked visualization;
running steps only show work-unit counts reported by the backend.


### 5.12 First-stage genotype review

Ask the desktop assistant to prepare genotype preprocessing on an existing TCGA run, or ask it to
create a fresh analysis first. The model can create the review and link the run to the conversation;
it cannot confirm. To open a review without the model, link a run using **Track an existing analysis**
and choose **Configure stage 1** or **Use official example** below its progress card.

- `prepare`: body `{"session": "...", "mode": "custom"}`, or mode `"example"`. The example
  fills paths under the prepared chromosome 1 reference folder. It does not install or convert
  missing data. Preparation leaves the run settings and scheduler unchanged.
- `decline`: body `{"session": "...", "proposal_id": "..."}`. The card is marked declined.
  Preparing again is an explicit action and gets a new ID.
- `confirm`: body contains `session`, `proposal_id`, and the reviewed `inputs`, `settings` and
  `resources` objects. These contain the genotype catalog's exact input and setting keys and the
  three resource values. Settings use numbers, or `"no"` for all configured chromosomes. The
  request is rejected if the run settings or prior attempt changed since review. On acceptance,
  the ID is consumed under the run's submission lock before the scheduler is contacted.
  A repeat or stale confirmation returns 409, including after a lost submission reply.
  The normal genotype step record becomes the source of truth for the existing progress card.


## 6. Step reference

### 6.1 Steps

| | `expression` (`-t`) | `genotype` (`-g`) | `adjust` (`-a`) | `cis` (`-c`) |
|---|---|---|---|---|
| Inputs | `gexp.file`, `pmap.file` | `ped.file`, `map.file`, `ref` (prefix), `gmap` (prefix) | `cli.file` | none (send `{}`) |
| Requires | none | none | `expression`, `genotype` | `expression`, `adjust` |
| Needs on HPC3 | none | none | `res/rest/signet_gexp`, `res/rest/signet_gexpID`, `res/resg/signet_Geno`, `res/resg/signet_Genotype.sampleID`, `tmp/tmpg/impute/impute_Genotype.sizes` | `res/resa/signet_new.Geno.map`, `_new.Geno.maf`, `_gexp_rmpc.data`, `_gexp.data`, `_geno.data`, `res/rest/signet_gene_pos` |
| Settings | `restrict.tcga` | `restrict.tcga.geno`, `mind`, `geno`, `hwe`, `int` | none | `alpha.cis`, `nperms`, `upstream`, `downstream` |
| Options | none | none | `npc` | none |
| Required outputs (under `work/`) | `res/rest/signet_gexp`, `_gexpID`, `_gene_pos`, `_gene_name` | `res/resg/signet_Geno`, `_Genotype.sampleID` | `res/resa/signet_matched.gexp`, `_new.Geno`, `_new.Geno.map`, `_new.Geno.maf`, `_gexp.data`, `_gexp_rmpc.data`, `_geno.data` | `res/resc/signet_all.sig.pValue_<alpha.cis>`, `_all.eQTL.data`, `_net.gexp.data`, `_net.genepos`, `_net.genename` |
| Downloaded folder | `work/res/rest` | `work/res/resg` | `work/res/resa` | `work/res/resc` |
| Default resources | 4 CPUs, 16 GB, 2 h | 8 CPUs, 32 GB, 4 h | 4 CPUs, 16 GB, 2 h | 8 CPUs, 32 GB, 4 h |
| Limits | 1–16 CPUs, 1–64 GB, 0.25–12 h | 1–32 CPUs, 1–128 GB, 0.25–24 h | 1–16 CPUs, 1–64 GB, 0.25–12 h | 1–32 CPUs, 1–128 GB, 0.25–24 h |
| Extra failure lines | none | `No SNP listed in your chromosome input`, `Some of the jobs are incomplete` | none | none |
| Typical time on HPC3 | about 1 min | 25–40 min (chromosome 1 only) | under 1 min | about 1 min (chromosome 1 only) |

Input notes:

- `pmap.file` must be a **collapsed** GENCODE v22 gene GTF (gene rows carry `transcript_type`). The full annotation GTF yields empty `gene_pos` and `gene_name`, and the step correctly fails.
- `cis` takes no input files: `script/cis_portal.sh` reads the `-a` and `-t` results of the same run through the `[ciseqtl]` paths in `config.ini`.
- The name of the main `-c` result contains `alpha.cis` (for example `signet_all.sig.pValue_0.05`). The required output names are fixed in the step record (`required_outputs`) at submit, so a later settings change cannot alter how that attempt is judged.
- `cis` runs R with `OPENBLAS_NUM_THREADS`, `OMP_NUM_THREADS` and `MKL_NUM_THREADS` set to 1, because ParaFly already runs one R job per CPU.
- `cli.file` is a tab-separated clinical file with at least `submitter_id`, `race` and `gender` (see section 10 for SIGNET's race handling). Samples are matched on the third part of the TCGA barcode.

### 6.2 Prefix inputs

`ref` and `gmap` of `genotype` are prefixes. SIGNET reads `<ref><N>.gen` and `<gmap><N>.map` for each chromosome `N` it processes:

- If `restrict.tcga.geno` is a chromosome `N`: only chromosome `N`.
- Otherwise: chromosomes 1 to `nchr` (22 by default).

Before queueing, each of those files is checked on HPC3. A missing one is named in the 400 error, with a hint to set `restrict.tcga.geno`.

### 6.3 Setting and option rules

Before a step is submitted, the run's **current** values of that step's settings are checked against these rules too, since they may still be defaults that do not fit HPC3 (SIGNET's `memory = 256` for `-n`). A failing value returns 400 naming the key; change it with route 5 first.


| Key | Step | Rule | Example |
|---|---|---|---|
| `restrict.tcga` | expression | `"no"` or a whole number 1–22 | `1` |
| `restrict.tcga.geno` | genotype | `"no"` or a whole number 1–22 | `1` |
| `mind`, `geno`, `hwe` | genotype | a number from 0 to 1 (PLINK `--mind`, `--geno`, `--hwe`) | `0.1`, `0.0001` |
| `int` | genotype | a whole number of base pairs, 1–100,000,000 (IMPUTE2 chunk length) | `5000000` |
| `alpha.cis` | cis | a number above 0 and at most 1 (significance level) | `0.05` |
| `nperms` | cis | a whole number 1–100,000 (permutations for low-frequency and rare variants) | `100` |
| `nboots` | network | a whole number 1–1,000 (bootstrap data sets; SIGNET runs nboots + 1) | `100` |
| `ncis` | network | a whole number 1–10 (most instrumental variables per gene) | `3` |
| `cor` | network | a number above 0 and at most 1 (largest correlation between a gene's instrumental variables) | `0.3` |
| `ncores` | network | a whole number 1–64: CPUs of **each of SIGNET's own jobs** | `16` |
| `memory` | network | a whole number of GB 1–128: memory of each of SIGNET's own jobs | `32` |
| `walltime` | network | `H:MM:SS` from `0:05:00` to `48:00:00`: wall time of each of SIGNET's own jobs | `4:00:00` |
| `upstream`, `downstream` | cis | a whole number of base pairs 0–10,000,000 around each gene | `1000` |
| `npc` (option) | adjust | a whole number 0–10: genotype PCs used as covariates (0 = none) | `3` |

Booleans and numbers sent as strings are rejected. Settings such as `forcerm` and `ncore_local` are not exposed: every job forces `forcerm = T` (batch jobs cannot answer SIGNET's "remove old files?" prompt) and sets `ncore_local` to the CPUs Slurm granted.

**Why options exist.** `signet -a` asks *"Enter the number of PCs for population structures"* with `read -p`. A batch job has no keyboard, so the job feeds the validated answers to SIGNET's standard input in order. Steps without options get `/dev/null` as standard input. The answers are stored in the step record under `options`.

### 6.4 The `network` step (`signet -n`)

`signet -n` is itself a job dispatcher, so this step works differently from the others:

| | Other steps | `network` |
|---|---|---|
| Where `signet` runs | inside the container, in the step's Slurm job | on the compute node, **outside** the container, in the step's Slurm job (the *control job*) |
| Slurm jobs | one | the control job, plus the jobs SIGNET submits for stage 1 and stage 2 (`sbatch -W`, one ParaFly batch of `ncores` commands each) |
| Resources in `resources` | the SIGNET job | the control job only (default 2 CPUs, 16 GB, 24 h; it waits for both stages, runs data preparation and the summary) |
| Size of the 2SPLS jobs | — | settings `ncores`, `memory`, `walltime` |

What the control job adds around `bash ./signet -n`:

- `singularity` on `PATH`: a link to the configured container runtime if only `apptainer` exists, because SIGNET calls `singularity exec` itself.
- `SINGULARITY_BIND` / `APPTAINER_BIND` set to the run folder, so every container SIGNET starts (and its own jobs, which inherit the environment) can read the run's files.
- `OPENBLAS_NUM_THREADS`, `OMP_NUM_THREADS`, `MKL_NUM_THREADS` = 1.
- `#SBATCH --mem=<memory>G` added to SIGNET's job template `script/network/template.sub.ori`, which has none. SIGNET fills in `queue`, `ncores` and `walltime` itself; the app sets `queue` to the HPC3 partition and `sif` to the container image.

Following and stopping it:

- Status adds `"progress": {"stage1": "<finished> <total>", "stage2": "..."}`: ParaFly commands finished out of all commands in each stage.
- Cancel cancels the control job and the jobs SIGNET submitted (IDs from `tmp/tmpn/stage1/submit1_log` and `stage2/submit2_log`), but only those whose working directory is inside this run's HPC3 folder.
- When the control job has ended (completed, failed, timed out), a status call cancels any of those jobs still queued, so none are left behind.
- Failure lines: `Some jobs are incomplete` (SIGNET then cancels its jobs and stops), `Cannot find the container`, `doesn't exist`, `Please reset` (SIGNET's test run found `ncores × memory per job` too large).

Required outputs: `res/resn/signet_Afreq` (edge frequencies over the bootstraps), `signet_CoeffMat0` (coefficients on the original data) and `signet_net.genepos`; `work/res/resn` is downloaded.

Measured on HPC3 (chromosome-1 example: 2,090 genes, 85 with cis-eQTL, `nboots` 10, `ncores` 4): stage 1 had 11 commands and stage 2 had 165; the whole step took 19 minutes, mostly waiting in the queue. `signet_Afreq` is comma-separated, 2,090 rows × 85 columns (one column per gene with cis-eQTL), with values in steps of 1/`nboots`.

## 7. Step states

```
submitting ──► submitted ──► pending ──► running ──► validating ──► completed
     │              │                       │             │
     │              └───────────────────────┴─────────────┴──► failed
     ▼                                      └────────────────► cancelled
   unknown  (connection lost during sbatch, or the job cannot be confirmed)
```

| State | Meaning | Client action |
|---|---|---|
| `submitting` | Record saved, `sbatch` in progress | Wait |
| `submitted` | Slurm accepted the job | Poll status |
| `pending` | Waiting in the Slurm queue | Poll status |
| `running` | Running | Poll status; read logs |
| `validating` | Job ended; checking outputs and logs, downloading, or waiting for a complete exit marker | Poll status |
| `cancelling` | Cancellation accepted, but termination of the job and its children is not confirmed | Poll status; do not resubmit or change settings |
| `completed` | Outputs present, logs clean, results downloaded | Go on to the next step |
| `failed` | Slurm failure (OUT_OF_MEMORY, TIMEOUT, …), nonzero exit, missing outputs, or a failure line in the logs | Read `reason`, `missing_outputs`, `failure_hints`; fix; resubmit in the same run |
| `cancelled` | Cancelled by the user or Slurm | Resubmit in the same run if wanted |
| `unknown` | No job could be confirmed (lost connection during `sbatch`, or Slurm has no record) | Check status again; inspect the HPC3 folder. **Do not resubmit** |

Record fields (route 7 and route 4):

| Field | Meaning |
|---|---|
| `step`, `run_id`, `flag`, `remote_dir` | Which step, run and HPC3 folder |
| `inputs`, `resources`, `options`, `partition`, `image` | Exactly what was submitted (for reproducibility) |
| `state`, `history` | Current state and every change with its time |
| `job_id`, `slurm_state`, `exit_code` | Slurm job, its last Slurm state, and SIGNET's exit code |
| `submitted_at`, `finished_at`, `checked_at` | Times |
| `missing_outputs`, `failure_hints`, `reason` | Why it failed, or the validation note on success |
| `outputs` | Files downloaded into the local run |
| `required_outputs` | Present when output names depend on settings (`cis`): the exact files this attempt must produce |
| `progress` | `network` only: finished and total ParaFly commands per stage |
| `attempt`, `previous_job_id` | Present on a retry |
| `connection` | `"interrupted"` when HPC3 could not be reached (not saved) |

## 8. Files on HPC3 and on this computer

HPC3, run folder `<workRoot>/<run_id>/`:

```
.owner                       random token: this folder belongs to this run
work/                        SIGNET's home for the run: signet, script/, config.ini
  res/rest/ res/resg/ res/resa/ res/resc/ res/resn/    step results (-t, -g, -a, -c, -n)
  tmp/tmpt/ tmp/tmpg/ tmp/tmpa/ tmp/tmpc/ tmp/tmpn/    step temporary files (-a reads tmp/tmpg/impute/; -n runs its own jobs in tmp/tmpn/stage1, stage2)
steps/bin/singularity        (network only) link to the container runtime, if HPC3 has no `singularity`
steps/
  <step>.sbatch              the generated job script
  <step>.job                 Slurm job ID
  <step>.out  <step>.err     job stdout and stderr
  <step>.done                exit marker: "<exit code> <ISO time>", written as the job's last line
  <step>.attempt<N>.*        the same files of earlier attempts, kept on retry
  <step>.attempt<N>.results/ the earlier attempt's result folder, kept on retry
```

This computer, `runs/<run_id>/`:

```
work/config.ini              settings, including the input paths last submitted
work/res/...                 downloaded results of completed steps
steps/<step>.json            current record of each step
steps/<step>.attempt<N>.json records of earlier attempts
steps/<step>.attempt<N>.results/ earlier attempts' local result folders
steps/remote.owner           the HPC3 folder and its owner token
```

## 9. Worked example: -t, -g, -a in one run

A developer can call the API with `curl`. The port is that of the app's Python backend (listening on `127.0.0.1`); the token comes from `/bootstrap`.

```bash
BASE=http://127.0.0.1:<port>
TOKEN=$(curl -s "$BASE/bootstrap" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
api() { curl -s -X "$1" -H "X-Chat-Token: $TOKEN" -H "Origin: $BASE" -H 'Content-Type: application/json' ${3:+-d "$3"} "$BASE$2"; }
W=/pub/<ucinetid>/signet-agent
P=$W/refdata/prepared/example
```

```bash
api POST  /signet/runs '{"run_id":"luad_run1","cohort":"TCGA"}'
api PATCH /signet/runs/luad_run1/settings '{"values":{"restrict.tcga.geno":1}}'

api POST /signet/runs/luad_run1/steps/expression \
  "{\"inputs\":{\"gexp.file\":\"$W/refdata/example/example_gexp\",\"pmap.file\":\"$W/refdata/gencode.v22.genes.gtf\"}}"
api GET '/signet/runs/luad_run1/steps/expression?refresh=1'     # repeat until "completed"

api POST /signet/runs/luad_run1/steps/genotype \
  "{\"inputs\":{\"ped.file\":\"$P/study.ped\",\"map.file\":\"$P/study.map\",\"ref\":\"$P/ref/chr\",\"gmap\":\"$P/gmap/chr\"}}"
api GET '/signet/runs/luad_run1/steps/genotype?refresh=1'       # repeat until "completed"
api GET '/signet/runs/luad_run1/steps/genotype/log?lines=20'

api POST /signet/runs/luad_run1/steps/adjust \
  "{\"inputs\":{\"cli.file\":\"$W/refdata/clinical.tsv\"},\"options\":{\"npc\":3}}"
api GET '/signet/runs/luad_run1/steps/adjust?refresh=1'

api PATCH /signet/runs/luad_run1/settings '{"values":{"alpha.cis":0.05,"nperms":100}}'   # optional
api POST /signet/runs/luad_run1/steps/cis '{"inputs":{}}'
api GET '/signet/runs/luad_run1/steps/cis?refresh=1'

api PATCH /signet/runs/luad_run1/settings '{"values":{"nboots":100,"ncores":16,"memory":32,"walltime":"4:00:00"}}'
api POST /signet/runs/luad_run1/steps/network '{"inputs":{}}'
api GET '/signet/runs/luad_run1/steps/network?refresh=1'      # "progress": {"stage1": "120 303"}
```

If `adjust` fails (for example because of the clinical file), fix the cause and send the same `POST` again in the same run: the reply has `"attempt": 2`, and `-t` and `-g` are not rerun.

## 10. Known limits

- **Clinical file and SIGNET's race handling.** `script/adj/adj_adjust.R` (official SIGNET) drops `american indian or alaska native`, turns `not reported` into `white`, and then expects exactly three race levels, named by position as asian, black or african american, white. Any other value (an empty race, `Unknown`) stops `-a` with `number of levels differs`. Worse, three different levels would be renamed silently. The app does not yet check race values before submitting. It also requires a `gender` column, which the clinical file downloaded by the environment panel does not yet include.
- **IMPUTE2 seed.** SIGNET runs IMPUTE2 without `-seed`, so two `-g` runs on the same data differ slightly (about 0.01 % of genotype calls in one test).
- **No job confirmed.** A step that ends `unknown` without a job ID has no way out yet other than inspecting the HPC3 folder: it cannot be retried, and it blocks the run's other steps and settings.
- **One run per analysis.** Results are never taken from another run. Copying `-t` or `-g` results between runs would also need `-g`'s `tmp/tmpg/impute/` and a check that both runs used the same samples.
- **`network` holds a control job for hours.** It needs 1–2 CPUs while SIGNET's jobs run; a control job that hits its wall time stops SIGNET, and its remaining jobs are cancelled by the next status call.
- **Not yet steps:** `-v` (visualization) and all GTEx steps. The chat tool `cis_eqtl` still uses the older login-node path.
