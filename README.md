# SIGNET Local Research Assistant

Use a local chat interface to explore SIGNET's analysis capabilities, inspect files you provide, and run operations through controlled tools. The interface supports English and Traditional Chinese and tool progress. SIGNET's six stages run on UCI HPC3 from confirmation cards in the chat, and the results card shows the network, SIGNET's plots and a connection table.

**This version includes no study data, example datasets, reference datasets, or precomputed results.**

The desktop opens to the bilingual workspace. The chat uses the existing SIGNET Agent with your configured model and saved conversations. Data and Run history show saved dataset records and their archived runs. Each run has an input snapshot and a timeline that opens its saved stage results. Analysis can submit Stage 1 for the chromosome 1 example through the existing HPC3 workflow. After Stage 1 completes, open Stage 2 of that run to review and manually submit expression preprocessing. Stage 3 continues that run with a reviewed clinical file and principal component count, live progress, and saved sample matching, PCA and expression adjustment results. Stage 4 reviews the association threshold, analysis range and permutations before submitting cis-eQTL mapping in the same run, with saved settings and the complete association table. Stage 5 continues with reviewed bootstrap, instrument correlation and compute settings, follows the controller and model work progress, and shows all saved candidate connections and bootstrap frequencies. Stage 6 reviews the frequency threshold and subnetwork count, runs the original exports, and opens the same run's graph and linked edge table with gene filtering. Use **Settings → Remote compute** to connect to HPC3 and check remote resources.

Datasets created in **Data** and their current file selections survive an app
restart. Each dataset shows only its own run history, whose original files and
settings remain preserved when current selections change. **Choose remote files**
browses HPC3 folders after connecting and saves readable, nonempty file paths
to that dataset. Genotype selections can include multiple files. This selection
checks file metadata only. **Validate input files** separately reads the saved
remote files without changing them, checks the TCGA input structure, and
reports preliminary sample overlap and compatibility warnings. It does not
establish scientific validity. In **Analysis → Stage 1**, **Review dataset
files** checks the saved inputs and selected reference resources. After you
confirm the warnings and submit, that run freezes its inputs, prepares its own
imputation references, and starts the original SIGNET genotype workflow in one
Slurm job. Stages 2–6 continue that same run manually. Stages 2 and 3 use its
frozen expression, annotation, and clinical files, even if current Data settings
change. Custom execution currently supports TCGA data for one autosome with a
matching raw VCF reference and genetic map. The unchanged built-in chromosome 1
example retains its existing path.

Failed or cancelled Stage 1 jobs can be reviewed and manually retried in the
same run. The original files and chromosome remain fixed while quality
thresholds and compute resources can change. Previous attempt records, saved
logs and downloaded results are retained. Custom datasets use a fresh input
directory and repeat reference preparation for every attempt; their original
sources must remain unchanged and available. Completed runs or runs with
later-stage records require a new analysis instead.

If a stage failed only because its required outputs were not yet readable,
**Recheck outputs** checks and collects the same job's results without a new
submission. The original failure and later checks remain in that attempt's
history. Confirmed program errors, scheduler failures, cancellation and unknown
submissions cannot use this recovery action.

**Run history** also lists recorded local Agent operations, generic Slurm run
records, and archived results. Filter by the current dataset, unclassified
records, or all runs. Same-named runs from different sources remain separate.
Open a record to inspect its saved files, settings, and execution evidence;
missing historical settings are labeled rather than filled from today's
configuration. Unclassified records can be assigned to a dataset for
organization, with that assignment saved separately from the original records.
This does not validate sample compatibility or enable a legacy run to continue.
History reads local records without querying remote jobs or rerunning analysis.
Each stage can expand its individual submission attempts, showing that attempt's
saved settings, job ID, times, failure reason and result evidence. Earlier
attempts remain separate from the latest one; missing records stay explicit.
Queued or running workspace jobs can be cancelled from their stage's progress
panel. Review the run, stage, job ID and attempt before confirming. Cancellation
remains pending until HPC3 confirms that the job and its owned child jobs have
stopped; connection failures do not imply successful cancellation. Existing
results and earlier attempt records remain preserved.
Stage progress and saved attempts have a separate execution-log disclosure.
It shows saved failure reasons, exit status and missing outputs, then lets you
read output messages, error messages or submission errors on demand. Each log
is bound to its own source, run, stage and attempt. Missing files, empty files
and disconnected remote access are distinct states; opening logs never retries
analysis or adds the log text to the conversation.

## Replacing the Former Desktop Workbench

This version replaces the desktop workbench with the local chat research assistant. The retired `desktop/` implementation, former `tools/` setup and execution entry points, desktop architecture documents, and historical validation records have been removed. Use the Python installation and startup steps below; the former desktop `npm start` and `tools/setup-dev.sh` are no longer entry points. The current Electron client is the supported UI described below.

This replaces the application entry point and file layout. It does not automatically migrate desktop work data or run records, and scientific analysis still requires a separately prepared environment. The old application and environment tools remain available in the [desktop history](https://github.com/TLoE419/SIGNET-AGENT/tree/cfd64e0ceaeabc6d8aa285285bd991587b8272e0).

## Quick Start

The application has been checked on macOS with Python 3.11. Python 3.11 or later is required. Native Windows operation has not been verified; some process-management and scientific tools require a Unix-like environment.

Download and extract this project, then run these commands from its root directory:

If Python is not installed yet or you need to set up Codex CLI, follow the [user guide](docs/USER_GUIDE.md) first.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --prefix electron
npm start --prefix electron
```

Electron opens the application and starts its Python API automatically. Requires Node.js 22.12+ on macOS or Linux. Opening the window does not establish model sign-in or scientific readiness.

When Gemini is selected, chat starts with `gemini-3.8-flash`. On HTTP 500, 502, 503, 504 or a transport timeout, the failed model request is sent once to `gemini-3.5-flash-lite` with the same conversation and tool results. The activity log and answer identify the fallback; completed tools are not replayed. The rest of that turn stays on Flash-Lite, while each new user turn starts with 3.8 again. Authentication, request-format, model-name and quota errors do not trigger fallback. If Flash-Lite also fails, the turn stops and preserves existing results.

Chat uses your own signed-in Codex CLI by default. See the [user guide](docs/USER_GUIDE.md) for installation and sign-in. The CLI version checked for this project is `0.162.1`; other versions need compatible command arguments and structured responses.

## Desktop client and independent Python backend

`electron/renderer/` is the only frontend source. Electron builds and serves the
renderer; Python continues to own chat, model providers, tools and scientific APIs.
The desktop client manages Python startup/shutdown and the SSH connection.
See [desktop setup and lifecycle](electron/README.md).

For backend-only development, run `.venv/bin/python -m agent.app.chat_ui --port 8880`.
This starts an API, not a browser interface. `GET /bootstrap` supplies initial
conversation state; `/chat` and the `/signet/` routes keep their request contracts.
Standalone Python tools and tests remain available. Existing desktop state and
scientific inputs/results are not moved or rewritten by the frontend migration.

## Capabilities and Prerequisites

| Level | Prerequisites | Behavior |
|---|---|---|
| Open the interface | Python dependencies and Electron/Node.js setup | Displays the chat page and guidance without calling a model |
| Natural-language interaction | Your own model sign-in or key | Answers questions, queries the tool catalog, and lists project files; this does not establish that an analysis ran |
| Prepare scientific operations | Pinned official source and your own inputs | Creates an isolated working directory and checks prerequisites |
| Run scientific analysis | An HPC3 account and the environment prepared in the Workflow panel | Each stage runs as a Slurm job after you confirm its card; completion does not establish biological validity |
| Change settings | A completed analysis | **Rerun stage** starts a new run from that stage and keeps the original for comparison |

There are **5 SIGNET tools, 3 general file tools, 8 HPC3 setup tools and 1 page control, for a total of 17 model tools**. None of them runs a SIGNET stage; only a confirmed card does. See [signet_inventory.json](signet_inventory.json) for the complete scientific-source inventory. Scientific code is pinned to the [official SIGNET commit](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3); the assistant does not execute arbitrary scripts.

## Usage and Data

To run an analysis on HPC3 from start to finish, follow the [user guide](docs/USER_GUIDE.md). For where the reference data comes from and how it is processed, see [reference data](docs/REFERENCE_DATA.md). For the local API that runs SIGNET steps on HPC3, see the [SIGNET step API](docs/SIGNET_STEP_API.md).

Create `data/` yourself for inputs; scientific tools create `runs/`. Both directories are excluded from version control. Credentials in `.env`, chat histories, execution logs and screenshots are also excluded.

The **Activity** control below the conversation opens when you send a request. It shows status, elapsed time, and tool records, and you can collapse and reopen it after completion.

The service listens only on `127.0.0.1`. Chat messages and content needed by the tools are sent to your selected model service; a local interface does not mean the model runs offline. Web chat history is saved locally in `.chat-state.json`; do not share this file. Closing a tab does not cancel tools that have already started. If a process is interrupted, inspect its recorded status before retrying instead of automatically running it again.

## Development and Checks

The full tool test suite needs the audited official code, but no real datasets, model keys, or HPC3 account:

```sh
.venv/bin/python scripts/setup_source.py
.venv/bin/python -m unittest discover -s tests -v
node tests/test_markdown.cjs
node tests/test_i18n.cjs
node tests/test_chat_progress.cjs
```

Pull-request and main-branch CI runs this process on Ubuntu 24.04 with Python 3.11 and Node.js 24, without model keys or real study data. These checks do not validate the complete scientific environment.

Source preparation needs Git and network access. Frontend checks and network-output verification need Node.js 20 or later. Tests create minimal synthetic content in temporary directories; that content is not a bundled research or demonstration dataset and does not provide biological validation.

See [third-party notes](docs/THIRD_PARTY.md) for source and licensing status. The project owner has not yet selected a license for the project itself.

## Terminology

- **Python:** the language and runtime used for the chat service and tools.
- **Ubuntu:** the Linux distribution used by CI.
- **Unix-like environment:** an operating environment supporting the process-management and command-line operations required by some tools.
- **Codex CLI:** the default model command-line tool; users sign in with their own accounts.
- **Git:** the version-control tool used to obtain the pinned official source.
- **Node.js:** the runtime used for frontend checks and network-output verification.

## Integrated desktop setup

The desktop header contains the existing SSH/environment controls and a Gemini
settings panel. Gemini keys entered there are verified with Google and encrypted
with the operating system key store. Saving or removing an active key restarts
the owned Python service after active work finishes; saved conversations remain.
Do not enter private research data unless your chosen provider is appropriate.

Open **Workflow** to prepare the shared installation; **HPC3 settings** changes its root and partition.
The same verified root, source revision, container runtime module and Slurm
partition are used by analysis and reference preparation. The workflow never
creates a second installation under `/pub`. Reference downloads and example
reference conversion require confirmation and run as remote Slurm jobs. Their
logs and state live in `<installation-root>/.signet-agent/steps`; raw reference
files live in `<installation-root>/refdata`. Existing paths and data are not migrated.
The preprocessing and results stages of this panel list each analysis's six steps;
the chat cards submit them.
A passing setup check is not evidence of a biologically valid analysis.
