# Optional Electron shell

Electron is the only supported UI. `renderer/` owns the application shell,
styles, translations, chat and Stage 6 controllers. One React entry renders the
shell and SSH controls. Existing chat/graph DOM controllers remain isolated in
`workspace.js` to preserve their behavior during integration.
Python remains a separate API service and can be developed without Electron.

## Run

First follow the root Python setup and model sign-in instructions. Then, from the
repository root (Node.js 22.12+ and npm are required):

```sh
npm ci --prefix electron
npm start --prefix electron
# Optional model provider; uses the existing .env configuration:
npm start --prefix electron -- --provider groq
```

The launcher prefers `.venv/bin/python`, then `python3` on PATH. To choose another
interpreter, set `SIGNET_PYTHON` to its executable path (not a shell command):

```sh
SIGNET_PYTHON=/absolute/path/to/python npm start --prefix electron
```

macOS and Linux are supported by this launcher; Windows process management and
packaged installers are not implemented. This is a source checkout launcher:
Python, its dependencies, and scientific prerequisites
must still be installed. No scientific data, Python runtime or model credentials
are bundled.

### Workspace

The desktop opens directly to the English workspace. The left chat uses the
existing SIGNET Agent, model configuration, and saved conversations. Choose a
dataset in **Data**, then open **Run history** to see that dataset's saved
runs. Each run shows its saved input filenames and the timeline stages
available for that run. Stages 1 and 2 show genotype and expression outputs.
Stage 3 shows sample matching, the recorded principal component count, and the
archived expression comparison. Stage 4 shows significant association pairs,
and Stage 5 shows candidate edges grouped by their recorded bootstrap frequency.
Stage 6 opens the network and edge table, with a filter for the selected gene.
Each stage uses the settings preserved with its job. The Stage 6 selector in
**Analysis** also follows the selected dataset. Stages 1–6 can be submitted
manually for the chromosome 1 example.

**Add dataset** saves the dataset immediately. Applying a file selection or
restoring its defaults also saves that dataset's current file configuration;
reopening the application reads it back. Save failures remain visible and do
not replace the last saved configuration. **Choose remote files** opens the
existing HPC3 browser after connecting, with locations, folder navigation,
typed paths, and file sizes. Genotype files can be selected across folders;
expression and clinical inputs each select one file. Applying checks canonical
paths, readability, regular-file type, and nonempty size before saving. Cancel
does not save, and **Use default** restores the dataset's saved defaults.
Each Data section has its own validation button and result. Genotype checks
the PED/MAP pair, gene expression checks the selected matrix, and clinical
checks the selected table and its required columns. Changing a file requires
rechecking its section. Switching datasets, remote accounts, or environments
clears or invalidates the saved view of these checks. Results show file issues
and counts. Expression scale and the meaning of the final five rows require
researcher confirmation. Sample matching is checked during analysis review.

To run the saved dataset, open **Analysis → Stage 1 → Review dataset files**.
Review all study files, the inferred chromosome, reference resources, settings,
and compute resources. The submission requires explicit acknowledgement of the
input and reference-preparation warnings. It queues one genotype job, which
first copies and fingerprints the reviewed inputs into its owned run folder,
prepares study-specific imputation references, and then runs the original
SIGNET workflow. It never borrows another study's prepared reference files.
Current support is TCGA data on one autosome, a matching raw VCF reference, and
a genetic map covering the study markers. Missing or incompatible resources
block submission with a reason; selecting a dataset does not install or run it.

Stages 2–6 use that run's prerequisites and snapshots. Expression, annotation,
and clinical inputs are frozen at Stage 1, so later changes in Data or reference
settings apply to new runs. Stage 3 starts with that frozen clinical source.
Its manual review can explicitly select a corrected clinical file, recheck it,
and use a separate reviewed copy while preserving the original frozen inputs
and completed Stages 1/2. Changing the clinical source invalidates the previous
review; the user must check and confirm it again before submission.
Run history retains the dataset name, original source paths, frozen paths,
settings, and reference-preparation summary. The unchanged built-in chromosome 1
example keeps its existing execution path.

### Complete run history

**Run history** defaults to the current dataset. Its scope selector also shows
unclassified records or all runs, including archives whose dataset is no longer
in the current catalog. The list combines workspace snapshots, generic Slurm
step records, old Agent operation/plan records, and saved archives. A run folder
already represented by workspace snapshots keeps its old operation evidence in
that same entry. Identical run names from different sources stay separate.

Details show the original files, recorded settings/resources, job identifiers,
and recorded execution states. A prepared plan is distinct from an executed
process, and process completion is distinct from verified scientific output.
Legacy records without saved settings show **Not recorded**; history never
reads today's mutable configuration as historical settings. Result links only
appear when the corresponding local reader has the required artifacts. History
listing does not poll SSH or the scheduler.

An unclassified record can be assigned to a saved dataset. That organizational
assignment survives restarts in `data/workspace-history.json`; it does not edit
original records, establish sample compatibility, or enable legacy execution.
Explicit original dataset ownership cannot be replaced. Source changes reject
stale assignments, and a replaced run folder does not inherit an old assignment.
Current dataset file changes do not alter saved run inputs or settings.

Each stage's saved-job disclosure also lists its individual submission attempts.
Open an attempt to inspect its own inputs, settings, prompt options, compute
resources, job identifier, timestamps, recorded state changes, failure reason,
and output-check evidence. The latest attempt is marked separately. Earlier
attempts come from the immutable `steps/<step>.attempt<N>.json` records; current
configuration and current result folders never fill gaps in an older attempt.
Missing or unreadable attempt records are identified explicitly. Archives that
did not preserve attempt numbers show that limitation instead of inventing a
first attempt. Output paths describe saved evidence; they are not links to
today's result folders. These disclosures do not submit, retry, cancel, or poll
remote work.

### Cancel a workspace job

In an active stage's progress panel, choose **Cancel job**, review the exact
run/stage/job/attempt, and confirm. **Keep job** dismisses that confirmation
without sending a request. Cancellation is available only for eligible live
workspace jobs with a known job ID and an active remote connection. Completed
jobs, historical attempts, generic old-tool evidence and archived results do
not offer this action. From **Run history**, open that run's active stage to
reach the same progress controls, including Stage 1. Returning to Analysis
preserves its previously selected run and draft.

The UI submits the expected job ID and attempt to the existing cancellation
service. A changed target is rejected before contacting HPC3. While the request
or termination is pending, duplicate cancellation, settings and retry controls
stay blocked. The panel continues checking status and reports **Cancelled** only
after the backend confirms the parent and its owned child jobs have stopped.
If the job completed first, the actual final state is retained. Lost connections
or partially failed cancellation remain unconfirmed, with the reason visible;
reconnect and check status before deciding what to do next. Switching datasets,
runs or remote environments clears an unsubmitted confirmation. No original
input, output, configuration or attempt archive is deleted by cancellation.

### Execution logs and failure details

Open the execution-log disclosure in a stage's progress panel or inside a saved
attempt in **Run history**. Saved failure reasons, exit status, failure hints
and missing-output paths remain readable from the recorded snapshot even while
disconnected. Output messages, error messages and submission errors are separate
streams. Read and refresh them manually; closed disclosures do not poll logs.
Content is displayed as plain text, independently of chat activity.

The viewer identifies the source, run, stage, attempt and job. Earlier attempts
read only their own archived log filenames, and same-named archive/workspace
runs never share a log. A source/attempt replacement is rejected. Switching the
selected run, dataset or remote environment prevents an old response from
appearing in another view. Local saved logs can be read offline; missing remote
logs require the matching existing connection. Empty, missing, unreadable,
disconnected and truncated logs are displayed explicitly. The response is
limited to the requested tail and at most 64 KiB.
Loose current local log files also need a matching saved job marker, because
older retries may have left those filenames behind. New retries archive local
job markers, exit markers, logs and submission files with their attempt number.
An old residual file is not treated as the new attempt's log.

Old Agent operations read only their fixed, owned local stdout/stderr files;
saved plans do not imply execution. Archives do not borrow live or remote logs.
The viewer does not create log files, download scientific results, refresh job
state, cancel, submit or retry any analysis. It does not send logs to the chat
model. Original files and attempt snapshots remain unchanged.

For a current failed stage whose only problem was incomplete output evidence,
**Recheck outputs** manually checks the same job and attempt again. Connect to
its recorded remote environment, open that stage, and select the button.
The check reads the job's markers, required outputs and logs; valid results
are collected and can be opened normally. It does not submit or cancel jobs,
change parameters or rerun analysis. Real program/scheduler errors, cancellation
and unknown submissions are excluded. Merely opening a stage never rechecks it.
Run history retains the original failure and each recorded output check under
that same attempt, including after a restart. Earlier attempts and archives
remain read-only. Changes of run, dataset or remote environment prevent late
responses from replacing another view.

### Submit the chromosome 1 example

Connect to HPC3 from **Settings → Remote compute**. The same panel can check
the remote resources and open the existing environment settings.
While Settings is open, connecting automatically checks the remote connection,
writable work directory, scheduler, container runtime, audited SIGNET source,
and container image. Each row shows its status and the returned
reason directly. **Check environment** refreshes the report and verifies the
remote configuration when needed. Incomplete or
contradictory replies and existing environment-verification errors cannot mark
the environment ready. Disconnecting or changing the account or installation
clears the previous report. These checks do not install resources or start an
analysis. Upload your study files to the remote workspace and choose them in
**Data**, including clinical data and study-specific reference files. The
dataset and stage reviews check the files selected for that run.

Missing software has separate manual actions beside its checks: **Install
SIGNET** and **Download container**. No setup action runs on connection, navigation,
refresh, or application restart. A click starts only that resource's existing
setup workflow. Its accepted job, queued/running state, completion, or failure
appears with the resource.
While setup work is pending, the panel waits for setup metadata changes over
the existing SSH connection (`POST /hpc/watch`, body `{"cursor":"<setup_cursor>"}`).
The cursor comes from `/hpc/check` and is captured before the full inspection,
so completion during inspection is not lost. Batch jobs record their outcome
through an exit hook. The bounded waiter samples only fixed metadata on the
remote shared filesystem; it does not repeatedly hash source files or query
the scheduler. No public callback endpoint or remote service is installed.
Unchanged wait replies do not refresh readiness. Changes trigger one quiet
inspection that retains the displayed rows until the new result arrives.
A quiet 60-second reconciliation covers older jobs, cancellation and jobs
that could not publish an exit marker. Leaving Settings or disconnecting
cancels the local wait; reopening reconciles the saved remote state without
resubmitting jobs. An event only triggers validation and cannot establish
readiness by itself.
Under **Remote configuration**, **Remote environment settings** opens the installation
root and scheduler partition form. Use **Check environment** after changing
settings or preparing software to confirm readiness.

In **Analysis → Stage → Stage 1**
of the chromosome 1 example, check the four prepared input files. Review the
fixed chromosome, thresholds, and resource settings, then select **Submit Stage 1**.
The application tracks the saved job through the queue, execution, and output
validation. From **Run history**, open the new run and select its Stage 1 result
to read the collected data and the settings actually submitted.

If Stage 1 failed or was cancelled, open that run's Stage 1 and select
**Review a new attempt**. Review its original files, adjust quality thresholds,
imputation chunk length and compute resources, acknowledge the warnings, then manually
submit the next attempt. This keeps the run ID and dataset identity. **Prepare
a new run** remains a separate action. Completed, active, unknown, or
downstream-started runs cannot retry Stage 1; old jobs must be confirmed stopped.
The original snapshot, previous attempt records, downloaded results and saved
logs remain available in Run history.

For a custom dataset, every retry copies the original source files into a new
attempt-specific input directory and prepares its references again. The
original files and their recorded identities must still match; changes in Data
or global reference selections are not used. The chromosome and run environment
remain fixed. After a successful retry, Stages 2 and 3 use its new frozen inputs.
Legacy example runs without source fingerprints disclose that limitation in
the review. Opening the review never submits work automatically.

After Stage 1 completes, open the same run from **Run history** and select
**Stage 2**. Confirm the example expression file, gene annotation, chromosome
and resources, then select **Submit Stage 2**. Its queue and execution status
update automatically. The completed run retains both stages, their input
files and the settings submitted for each step. Reopening Stage 2 after completion
shows its collected expression distribution and gene summary.

Once both steps complete, open **Stage 3** of the same run. Its review keeps the
clinical path, principal component count (0–10, default 3) and resources visible.
**Check clinical file** checks the required columns and matching patients before
**Submit Stage 3** starts the original adjustment workflow. The default clinical
path uses the existing chromosome 1 example from earlier saved runs when present,
with the current selected clinical file taking precedence. You can enter another
allowed remote clinical path and check it before submission.

Stage 3 collects the clinical data actually used and the official PCA outputs
with its results. The saved view shows the original component count, matching
and excluded sample counts, retained individuals at their SIGNET PCA coordinates,
and expression variation on the same retained individuals before adjustment,
after clinical covariates, and after clinical covariates plus the selected PCs.

After Stage 3 completes, open **Stage 4** of the same run. Its review keeps the
significance threshold, range before the gene start and after the gene end,
permutation count and scheduler resources visible. The values come from that
run's current configuration. **Check prior results** checks all six preceding
output files without creating a job. **Submit Stage 4** submits the reviewed
values through the existing cis-eQTL workflow and tracks its queue and progress.
The saved result lists all associations, with the submitted settings, category
counts, gene names, category-local variant or region indices, and p-values.

After Stage 4 completes, **Stage 5** reviews the bootstrap count, the correlation
limit for selecting instrumental variants, and each compute job's cores, memory
and time limit. Its controller has separate resources and stays active while
the model jobs run. Existing valid settings are retained. Unsupported upstream
resource defaults are replaced in the review with explicit proposals, which are
saved only when **Submit Stage 5** is selected.

The existing network workflow submits its own model jobs and reports completed
work items for each of its two calculation batches. Reopening an active run
resumes status tracking. Saved results read the actual normalized bootstrap
frequency matrix and preserve the official direction from source columns to
target rows, including every positive candidate. Stage 5 uses the significance
file from the completed Stage 4 job even if the run's current threshold changes.

When Stage 5 completes, **Stage 6** reviews the frequency threshold and number
of subnetworks against that run's collected matrices. **Check network and
thresholds** checks the selected values without submitting. **Submit Stage 6**
runs the original SIGNET exports on HPC3 in the same run, with queue and
execution progress. The confirmed settings and original edge list, subnetwork
names, interactive graph and plot files are saved with the job.

The completed Stage 6 history view opens the existing graph and edge table.
Both follow the actual exported subnetworks. Selecting **MEGF6**, or another
gene in the graph, filters the table to that gene's incident edges. Returning
from another stage restores the selection for the same run. Archived graphs
remain available in the completed-result selector.

The local installation needs the audited SIGNET source, as described under
[installation](../docs/INSTALL.md). The existing desktop SSH environment
supplies the prepared files and scheduler for the submission.

Archived HPC3 exports remain local. The application reads these records under
the ignored `data/` directory:

- `datasets/<dataset-id>.json` supplies `id`, `name` (a string or a legacy `[Chinese, English]` pair),
  and current `inputs` grouped as `genotype`, `expression`, and `clinical`
  filename arrays.
- `stage6-results/<run-id>/history.json` supplies `run_id`, `dataset_id`,
  `name` (a string or a legacy `[Chinese, English]` pair), and a separate `inputs` snapshot in the same
  format. Record the filenames confirmed for that run.
- Beside `history.json`, keep the original `verification.json` and
  `signet_edgelist_<frequency>.txt` from the completed visualization. The
  verification report supplies the run's timestamps, settings, and counts.
- If available, `stage3.json` beside the verification report contains that run's
  matching counts, principal component scatter, and expression comparison. The
  recorded component count must match the completed adjustment job.
- `stages.json` contains the same `run_id` and a `stages` object for stages
  `1`, `2`, `4`, and `5`. These summaries come from the archived genotype
  codes, transformed expression matrix, per-category significant pairs, and
  network frequency matrix. The Stage 5 chart counts positive frequencies in
  that matrix before the separate Stage 6 display threshold. Settings and
  resources come from `verification.json`.

The November 11 archives preserve genotype and expression matrices but omit the
original PCA score files. The Stage 3 scatter uses the archived retained
genotypes, centered by mean dosage and scaled by genotype variance under the
observed allele frequencies. The two plotted coordinates are the leading
principal component scores of that standardized matrix. The inspector records
the component count from the original job. The comparison uses the median
per-gene sample standard deviation across the same retained individuals.
Pre-adjustment expression is aligned by matching each retained genotype row
uniquely and in order to the matched genotype matrix. The other columns use
the two archived expression outputs, adjusted for sex and race and then for
those covariates plus the original genotype components.

Dataset additions and current file selections are saved atomically in
`data/workspace-datasets.json`. The existing `data/datasets/*.json` files supply
the initial definitions and defaults; edits are stored separately. The dataset
catalog includes both these definitions and saved additions. Run history stays
scoped to each dataset's stable ID and reads its files and settings from the
run's original snapshots, so changing a dataset cannot rewrite an old run.

The authenticated `/signet/datasets` routes manage this metadata only; saving a
file path neither opens that file nor submits a scientific job. Removing a
dataset leaves its recorded analyses accessible under **All runs**. For an isolated
test profile, `SIGNET_DATASETS_STATE_FILE` overrides the state-file location.

Use **View → Classic Interface** for model setup, existing Stage 6 tools, and
the development terminal. **View → Workspace** returns to the new interface.
Both interfaces share the same HPC3 connection.

## Development terminal

Start explicitly in development mode from the repository root:

```sh
npm run dev --prefix electron
# Or choose a provider:
npm run dev --prefix electron -- --provider groq
```

Quit an already-running SIGNET instance first; a second launch focuses the
existing instance and does not change its mode. Choose **View → Classic Interface**.
Before signing in, click **Dev terminal → Connection diagnostics** at the bottom right. Then use the
normal SSH controls to Connect; dev login/unlock dialogs also show the live log.

- **Connection diagnostics** monitors local key unlock, system OpenSSH startup,
  authentication, Duo challenge waiting, remote health, failure and disconnect.
  The opening event states the exact `username@host:port` target before
  authentication.
  It works before authentication. The last 300
  events stay in Electron Main memory across panel close, failure and page reload,
  until app exit. Only fixed allowlisted protocol messages and sanitized error
  codes are recorded; raw PTY output, banners, challenge text/responses,
  passwords, passphrases and private keys are never forwarded to this log.
- **Raw SSH log** shows text received through the system OpenSSH PTY, including
  server banners and keyboard-interactive prompts. This is the place to inspect
  the exact Duo menu and login text returned by HPC3.
  Server-provided text can contain account or device details, so the view is
  available only in dev mode and is rendered as inert escaped text rather than
  being executed by the interactive terminal. Passwords, passphrases and private
  keys submitted by the app are not logged; OpenSSH may echo a non-secret menu
  choice such as `2`. The
  latest 2 MiB / 2,000 entries stay only in Electron Main memory until app exit;
  attempts made before this feature was running cannot be recovered afterward.
- When HPC3 returns a keyboard-interactive challenge, the complete server name,
  instructions and prompts are forwarded to the active login dialog. Numbered
  choices such as `1. Duo Push ...` are rendered as buttons; selecting one sends
  that exact option back to the pending SSH challenge, whether the server placed
  the option in its instructions or in a prompt. Manual Duo passcodes remain
  available through the prompt field. Prompt contents are displayed transiently
  and are never added to diagnostics or persisted.
- **Execution activity** previews Python SSH broker commands, stdout/stderr,
  start/end times, exit status and the current running count. It follows output
  while scrolled to the bottom. It is a bounded, in-memory preview: 128 KiB per
  command and the last 200,000 characters in the panel; it is not a durable log.
  Local Python processes, LLM output and previously submitted scheduler jobs
  are not automatically attached to this view.
- **Interactive shell → Attach terminal** attaches xterm to the primary
  xterm-256color login PTY already owned by Electron. Input, Ctrl-C, ANSI output
  and resizing affect that real login shell. Detaching or closing the panel only
  removes the renderer view; it does not close SSH. Python commands use separate
  channels through the same OpenSSH control connection.
- Authentication success alone is not treated as connected. Electron immediately
  starts `/usr/bin/ssh` in a foreground xterm-256color PTY with an app-private
  ControlMaster socket and `ControlPersist=no`, then runs a fixed,
  input-free identity probe that verifies the selected username and confirms
  `sbatch` exists. It publishes the connected state only after all checks pass.
  This mirrors HPC3's native SSH
  login flow, keeps the transport tied to the app lifecycle, and captures the
  server MOTD and prompt in **Raw SSH log**. The optional developer terminal
  attaches to that primary PTY; Python commands open sibling channels through
  its private control socket. Closing the primary process closes the connection.
- The connection snapshot includes the current phase, the verified remote
  hostname/account, Slurm availability, check steps, and timestamp. **Check
  again**, window focus, and return from background run the same health check;
  results are cached for 15 seconds to avoid unnecessary HPC3 traffic. Python
  broker work also requires a recent healthy result. A failed forced/proactive
  check closes the stale transport and reports whether identity, Slurm, timeout,
  DNS/network, or session health failed. No ASKPASS, polling web API, detached
  `ssh -f`, long-lived `ControlPersist`, or second SSH owner is introduced.
- **Detach terminal**, **Close panel** or page reload detaches the renderer while
  preserving the Electron-owned primary PTY. SSH disconnect/app shutdown first
  requests `ssh -O exit`, then terminates the owned PTY if needed and removes its
  private control directory. Reconnecting never replays input.

`npm start` have no terminal UI or terminal bridge. Main only
registers the dev IPC handlers for an explicit `--dev` in an unpackaged app;
packaged apps ignore the flag. Dev IPC checks the owning window/main-frame
origin, caps input and dimensions, and bounds unacknowledged terminal output.
Terminal history and activity are not saved. xterm generates layout/theme CSS,
so only the dev window permits inline styles; script and network restrictions
remain in force, and production CSP remains unchanged.

Validate the real terminal against an isolated localhost SSH test server with
`npm run test:dev --prefix electron`. This test covers real renderer input,
Ctrl-C, broker activity, a single shared transport, and panel/reload cleanup.

## SSH connection

The top bar reuses the original `ssh-auth-key-management` status control: click
its identity or LED to edit the connection; use the switch to connect, disconnect,
or cancel. Connect first checks the selected authentication method and only then
opens the required temporary credential prompt.

The connection dialog offers **Duo** and **SSH key**. With no saved key, the SSH
key block offers key creation/import. Host and port are preset to UCI HPC3 under **Advanced connection
settings**. **Save** only saves the profile; **Connect** saves and connects.
Neither account passwords nor private-key passphrases appear in this dialog.
Duo sign-in requests the account password and forwards server-provided keyboard
challenges. Both methods use an Electron-owned SSH session for Python commands.

**Add SSH key…** opens **Generate SSH key**, which requests a key name and a new
passphrase with confirmation, without UCInetID. It creates an encrypted RSA 4096
key locally. Only afterwards does **Set up SSH key** request UCInetID and account
password, complete Duo challenges, install the public key, and verify a fresh
key-authenticated session before selecting the profile. Account association is
saved only after verification succeeds. The public key is available there for
manual setup. Cancelling retains the encrypted key but clears the temporary
passphrase and cancels temporary authentication sessions.
**Use Existing SSH Key** uses the native picker and offline inspection, also
without account fields; the username is entered in connection settings later.
Passwords and passphrases are never persisted.
Existing private keys must be passphrase-protected OpenSSH keys owned by the
current user with owner-only permissions (normally `0600`).
As in the original design, inspection accepts one RSA, Ed25519 or NIST ECDSA
key in an OpenSSH container using `aes256-ctr` with bcrypt (16-byte salt,
1–100 rounds). Other formats, ciphers and excessive KDF costs are rejected
before local unlock; inspection and decryption run in bounded worker threads.

The first connection to a host is blocked and shows its SHA-256 host-key
fingerprint. Verify that value through an independent administrator-provided
channel before trusting it. A changed saved identity is always blocked and cannot
be replaced in the UI. Profiles, encrypted app-managed keys and host trust are
stored below Electron's `userData/ssh` directory with owner-only permissions.
Passwords and passphrases are not persisted.

Once connected, Python scientific commands use a per-launch private Unix socket
to ask Electron Main to open command channels through the owned OpenSSH
ControlMaster. The broker socket is
placed in a random owner-private short directory, requires a random token passed
only to the owned Python child, and transfers command input/output as binary data.
Standalone Python has no broker variables and continues to use its configured
system OpenSSH transport.

SSH UI lives in `renderer/features/ssh`, native SSH services in `main/ssh`,
and their contracts in `shared/ssh`. Chat and Stage 6 retain their existing
JavaScript controllers under `renderer/features`.
`npm start` builds the renderer and SSH Main/worker bundles automatically. A missing or corrupt SSH
configuration is reported by the SSH controls without preventing chat startup.
The earlier integration's flat version-1 profiles and host pins are read without
rewriting them. Private-key-only edits retain their existing version (1 or 3).
Saving a Duo profile upgrades profiles.json to version 4 and first writes an
owner-private profiles.before-duo-<uuid>.json backup. New installations use
version 4. Earlier app versions cannot read version 4: quit the app and restore
the pre-Duo backup before rolling back; preserve the current profiles.json too.
Private key files and host pins are not migrated.

## Architecture and ownership

- Electron Main spawns `main/backend/server.py` with an anonymous control pipe. The wrapper
  calls the independently usable `create_server` API factory.
- Python binds an OS-assigned loopback port, reports readiness over stdout, and
  sends existing application diagnostics to stderr. Main never adopts another
  server or assumes that an occupied fixed port belongs to SIGNET.
- Electron serves an allowlisted local renderer build through its session protocol handler. API requests are forwarded unchanged to the owned Python origin. Python serves no HTML or frontend assets. Node integration is off,
  context isolation and sandboxing are on. A narrow preload exposes only named SSH
  profile, key-picker, trust, registration and connection methods. Normal mode
  exposes no generic IPC, filesystem, shell or remote-exec method; explicit dev
  mode adds the bounded PTY operations described above. Requests are restricted to the owned origin, permissions are denied,
  subframe navigation and popup windows are blocked. Existing Host, Origin, token
  and CSP protections remain in effect (with dev-only inline styles for xterm). Only the two official RCIC login/key guidance links open in the system browser.
- Result downloads from `/stage6/file` retain the native save dialog. No generic
  filesystem or local shell API is exposed to the page.
- Closing the window, quitting, or losing the renderer requests backend shutdown.
  Python stops accepting requests, lets existing request/Stage 6 workers finish
  and save, then exits. After five seconds the native dialog offers waiting or
  explicit force quit. No tool is automatically replayed or retried.
- If Main crashes, the Python control pipe reaches EOF and follows the same
  graceful drain. An active or stuck operation can keep Python alive; there is
  deliberately no promise of immediate termination. Explicit force quit kills the
  owned local process group. Tools which create separate sessions and remote jobs
  may outlive that group; inspect run records before retrying. This does not cancel
  VM/SLURM jobs and does not automatically cancel remote scheduler jobs.
- Main owns the foreground SSH PTY and its private control socket. Normal quit
  first drains and checkpoints Python work, then sends `ssh -O exit`, applies a
  bounded TERM/KILL fallback, and removes both SSH and broker socket directories.
  A Main crash closes the PTY file descriptors and releases the SSH TCP
  connection; already-submitted remote jobs may continue independently.
- A backend crash closes the desktop session with an error instead of restarting
  it and risking replay. A single-instance lock prevents a second desktop host
  using the same state directory.

## State

Desktop chat and Stage 6 session files live under `state/` within Electron's
`SIGNET Research Assistant` userData directory (normally
`~/Library/Application Support/SIGNET Research Assistant/state/` on macOS).
The last viewed saved conversation is restored on startup. Use the Saved conversations
selector to reopen older chats, or New chat to start a blank conversation. Older
state files without an active-session preference resume the most recently created
saved chat. Restoring a conversation displays its saved messages and work records;
it never repeats a model request or scientific operation. The previous 32-chat hard
limit is removed. Histories are retained without automatic eviction, so the local
state file grows with usage.

Standalone backend development still uses project-local state by default. No
existing history is moved, overwritten, or automatically imported. The desktop
and standalone backend share scientific files; do not run concurrent scientific
work through separate processes (the turn lock is per process).

## Renderer integration migration

- Removed: root `web/`, the browser UI at Python `/`, and Python static-asset routes.
- Frontend sources now live in `electron/renderer/`; generated assets are in
  `electron/build/renderer/` (not tracked). Run `npm ci --prefix electron`, then
  `npm start --prefix electron`.
- `python -m agent.app.chat_ui` still starts a standalone API. `/bootstrap` returns JSON with
  `token`, `model`, and `initial`; it replaces the former HTML bootstrap response.
  `/chat`, `/stage6`, and file downloads retain their contracts and protections.
- No stored-data migration is required. Preserve existing state files when
  switching revisions; returning to the previous revision restores its browser
  launcher without requiring a data conversion.

## Checks

```sh
npm test --prefix electron
npm run test:smoke --prefix electron
npm run test:startup --prefix electron
npm run test:history --prefix electron
npm run test:attempts --prefix electron
npm run test:cancellation --prefix electron
npm run test:logs --prefix electron
.venv/bin/python -m unittest discover -s tests -p 'test_desktop_server.py' -v
```

The Node suite starts the real Python service in disposable state directories,
checks HTTP boundaries, startup failures, owner-crash cleanup, key inspection,
registration/Duo challenges, live SSH execution and saved-file compatibility.
The restored UI tests check the original separate-dialog interaction flow. The native smoke
test loads the actual UI without a model call, checks sandboxing, workspace access,
language switching, blocked external navigation and service shutdown. It writes a
screenshot to the OS temporary directory. The startup regression test executes the
package entry and verifies that it creates a visible window containing the chat UI;
it uses disposable state with 32 legacy conversations, exercises history selection
and explicit new-chat navigation, verifies retained messages/events, and closes the
window afterward. This catches
entry-point failures that a direct call to `launch()` in the smoke test bypasses.
On Linux run both native checks with a display, or prefix each command with
`xvfb-run -a`. GitHub Actions runs all three Electron checks on macOS.

### SSH key management

Selecting **SSH key** reveals the key management block, including when no keys
are saved. The block contains the saved-key selector, **Add SSH key…**,
a details icon that opens key information and actions in a separate dialog.
**Edit key** (name and optional account) and **Delete key** each open their own
dialog; confirmation and errors stay in that dialog.
Duo mode hides this block. Deleting removes the saved metadata entry and changes
profiles referencing that key to Duo. It preserves private-key files and remote
authorized_keys entries; it does not revoke remote access. Disconnect before
changing keys. After changing the desktop bridge, restart Electron to load it.

## Source layout and ownership

```text
electron/
  main/
    app/          Application entry, windows and lifecycle
    backend/      Python process supervision and server.py
    security/     Navigation and origin policy
    renderer/     Allowlisted assets and API forwarding
    ssh/          Service coordinator; connection/, keys/, storage/, ipc/
    devtools/     Developer terminal service and IPC
  preload/        Explicit, restricted desktop bridge
  renderer/
    app/          React root, application shell and feature composition
    features/
      chat/       Chat, streaming progress and Markdown controller
      stage6/     Parameters, network graphs and comparisons
      ssh/        connection/, auth/, keys/, state/ and feature composition
      devtools/   Diagnostics and interactive terminal UI
    components/   Shared modal, confirmation, actions and icons
    styles/       Application styles and SSH color/layout tokens
    vendor/       Third-party assets and licenses
  shared/ssh/     Contracts and pure validation shared across processes
  scripts/        Build and native dependency preparation
  tests/          Unit, protocol, lifecycle and native application tests
  build/          Generated renderer and Main/worker bundles (ignored)
```

Renderer and shared code must not import Main or native Node APIs. Main owns
processes, filesystem access and private credentials. Renderer accesses desktop
capabilities only through preload. `scripts/build.mjs` builds the entire app;
`npm start`, `npm test` and the generated `build/ssh`/`build/renderer` locations
remain stable. Source paths changed from the former `src/ssh`, `modules/ssh`,
and root launcher files; no stored data or wire protocol changed.

## Remote environment setup

After SSH connects, the status block shows environment checks and installation
progress. The **Workflow** panel lists what is ready or missing, even before the
environment is verified, and offers the SIGNET install and container download.
**HPC3 settings** (or the status block's environment row) chooses the installation
root and partition. The default root is `/pub/<user>/signet-agent` when that folder
is writable, otherwise `~/.local/share/signet-agent`.

The GTF download produces `refdata/gencode.v22.genes.gtf`, because `signet -t` finds
0 genes in the full GENCODE file: its gene rows have no `transcript_type`. A Slurm job
runs the pinned, checksum-verified GTEx `collapse_annotation.py` inside the container,
so the container must exist first. The full file stays at
`refdata/gencode.v22.annotation.gtf`.

Each reference row can also **Choose on HPC3**, which opens a file window over the
same SSH connection. Choosing checks the format from the file's first lines, records
the path in `<root>/refdata/selected.tsv` without copying the file, and submits a small
job that proves compute nodes and the container can read it. Readiness checks and the
reference conversion then use that path. Paths stay on the window's own routes
(`agent/runtime/hpc_files.py`): they are not model tools and the assistant sees only
that a selected file is ready. Jobs that run SIGNET must also accept and bind these
paths; `selected.tsv` holds one `key<TAB>path` per line.
SSH stays connected when the scientific environment is unavailable. In development
mode, the setup dialog and developer panel show step diagnostics.
See [environment setup](main/environment/README.md) for behavior and limitations.

Run `npm run test:environment --prefix electron` for the localhost SSH mock flow;
it never connects to HPC3 or downloads the real image.

SSH readiness is detected through a bounded local OpenSSH ControlMaster check,
independent of the user's prompt. Authentication text is parsed only before the
transport becomes ready. Upload pipe failures are handled as command failures,
including broken input pipes, without terminating the application.

## Integration with baseline monitoring and the earlier login proposal

The standalone monitoring scripts in `hpc/baseline/` run on HPC3; they do not add
a second connection or a monitoring screen to the desktop. Their fixtures and
local account settings remain separate from Electron's private connection state.

The desktop keeps one SSH owner and one login entry point. The useful network,
VPN, DNS and reconnect guidance from the earlier browser login proposal is
incorporated into the existing connection dialog and errors. That proposal's
`/hpc3` polling API, detached shared master, ASKPASS helper and sidebar card are
not imported. Existing desktop cancellation, three-minute authentication timeout,
health checks, host trust and owned-connection cleanup continue to apply.

This integration does not verify a real HPC3 login or scientific job. Localhost
SSH fixtures exercise desktop behavior; actual remote acceptance remains separate.

## HPC3 container modules

HPC3 provides container tools through Environment Modules. The environment check
first tests executables already on PATH. If none work, it lists available
Singularity/Apptainer modules, prefers RCIC's documented `singularity/3.9.4` when
available, and otherwise tries explicit discovered versions. It verifies the
chosen executable with `--version` and displays the selected runtime module in
the environment dialog. It never runs an unversioned `module load`.

Each container download/verification and scientific command reloads that exact
module in its own shell. Uploaded command wrappers do the same inside a clean
worker/job environment. The shared `runtime_modules.sh` initializes the system
module function and HPC3's category paths when necessary, including USER in clean
worker environments. No `.bashrc` or `.bash_profile` is modified, and loading a
module does not download an image, start a container or submit a scheduler job.
Existing globally available runtimes still work without modules. If no usable
runtime/module exists, setup stays blocked.

Remote installation still requires the explicit Install confirmation. Study data
and scientific execution are separate. Follow RCIC's allocation guidance for
container building and use; this detection change does not authorize or verify
an installation or scientific job on a login node.

- [RCIC modules: versioned loading in each job; keep startup files unchanged](https://rcic.uci.edu/software/modules.html)
- [RCIC Singularity container guidance](https://rcic.uci.edu/software/user-installed.html)
