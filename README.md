# SIGNET Local Research Assistant

Use a local chat interface to explore SIGNET's analysis capabilities, inspect files you provide, and run operations through controlled tools. The interface supports English and Traditional Chinese, tool progress, and parameter proposals and comparisons for Stage 6 network results.

**This version includes no study data, example datasets, reference datasets, or precomputed results.** After installation, you can open the web interface. With your own model sign-in configured, you can chat, query the analysis catalog, and list project files. Network visualization and comparison require your own analysis results that have passed the technical output checks; no example graph appears on first launch.

## Replacing the Former Desktop Workbench

This version replaces the desktop workbench with the local chat research assistant. The retired `desktop/` implementation, former `tools/` setup and execution entry points, desktop architecture documents, and historical validation records have been removed. Use the Python installation and startup steps below; the former desktop `npm start` and `tools/setup-dev.sh` are no longer entry points. An optional new Electron shell is described below.

This replaces the application entry point and file layout. It does not automatically migrate desktop work data or run records, and scientific analysis still requires a separately prepared environment. The old application and environment tools remain available in the [desktop history](https://github.com/TLoE419/SIGNET-AGENT/tree/cfd64e0ceaeabc6d8aa285285bd991587b8272e0).

## Quick Start

The application has been checked on macOS with Python 3.11. Python 3.11 or later is required. Native Windows operation has not been verified; some process-management and scientific tools require a Unix-like environment.

Download and extract this project, then run these commands from its root directory:

If Python is not installed yet or you need to set up Codex CLI, follow the [from-scratch installation guide](docs/INSTALL.md) first.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python chat_ui.py
```

Open the [local interface](http://127.0.0.1:8880). A page loading successfully does not establish that your model is signed in or that the scientific environment is ready.

Chat uses your own signed-in Codex CLI by default. See the [installation guide](docs/INSTALL.md) for installation, sign-in checks, and other model providers. The CLI version checked for this project is `0.162.1`; other versions need compatible command arguments and structured responses.

## Optional Desktop Window

After the Python setup above, you can open the same interface in Electron:

```sh
npm ci --prefix electron
npm start --prefix electron
```

Requires Node.js 22.12+ on macOS or Linux. The shell starts its own loopback Python
service and manages its shutdown; it preserves the existing UI, APIs and analysis
implementation. Browser startup remains supported. Desktop conversation state is
separate, while scientific inputs and runs are shared; run scientific work through
only one interface at a time. See [desktop setup and lifecycle](electron/README.md)
for model selection, shutdown behavior and tests. No installer is provided yet.

## Capabilities and Prerequisites

| Level | Prerequisites | Behavior |
|---|---|---|
| Open the interface | Python dependencies | Displays the chat page and guidance without calling a model |
| Natural-language interaction | Your own model sign-in or key | Answers questions, queries the tool catalog, and lists project files; this does not establish that an analysis ran |
| Prepare scientific operations | Pinned official source and your own inputs | Creates an isolated working directory and checks prerequisites |
| Run scientific analysis | The corresponding scientific dependencies, VM, or scheduler | Runs within each tool's limits and retains logs; completion does not establish biological validity |
| Compare Stage 6 results | Your own technically verified results and scientific environment | Proposes changes, starts a separate run after your confirmation, and compares results |

There are **23 SIGNET tools and 2 general file tools, for a total of 25 model tools**. See [signet_inventory.json](signet_inventory.json) for the complete scientific-source inventory. Scientific code is pinned to the [official SIGNET commit](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3); the assistant does not execute arbitrary scripts.

## Usage and Data

Follow the [no-data demonstration guide](docs/DEMO.md) to try chat, capability queries, and missing-prerequisite reporting. For scientific analysis, start with the [scientific setup guide](docs/SCIENTIFIC_SETUP.md), then consult the [advanced environment guide](docs/ADVANCED.md) for runtime configuration.

Create `data/` yourself for inputs; scientific tools create `runs/`. Both directories are excluded from version control. Credentials in `.env`, chat histories, workspace state, execution logs, screenshots, and VM assets are also excluded. For the scientific software, VM, data, and six-stage workflow requirements, follow the [scientific setup guide](docs/SCIENTIFIC_SETUP.md); it also explains what a clean download still cannot provision.

The **Activity** control below the conversation opens when you send a request. It shows status, elapsed time, and tool records, and you can collapse and reopen it after completion. It is independent of Stage 6 activation; collapsing network visualization does not hide chat progress.

The service listens only on `127.0.0.1`. Chat messages and content needed by the tools are sent to your selected model service; a local interface does not mean the model runs offline. Web chat history is saved locally in `.chat-state.json`; do not share this file. Closing a tab does not cancel tools that have already started. If a process is interrupted, inspect its recorded status before retrying instead of automatically running it again.

## Development and Checks

The full tool test suite needs the audited official code, but no real datasets, model keys, or VM:

```sh
.venv/bin/python scripts/setup_source.py
.venv/bin/python -m unittest discover -s tests -v
node tests/test_markdown.cjs
node tests/test_i18n.cjs
node tests/test_stage6_graph.cjs
node tests/test_chat_progress.cjs
```

Pull-request and main-branch CI runs this process on Ubuntu 24.04 with Python 3.11 and Node.js 24, without model keys or real study data. These checks do not validate the complete scientific environment.

Source preparation needs Git and network access. Frontend checks and network-output verification need Node.js 20 or later. Tests create minimal synthetic content in temporary directories; that content is not a bundled research or demonstration dataset and does not provide biological validation.

See the [file tree](docs/FILE_TREE.md) for file responsibilities and [third-party notes](docs/THIRD_PARTY.md) for source and licensing status. The project owner has not yet selected a license for the project itself.

## Terminology

- **Python:** the language and runtime used for the chat service and tools.
- **Ubuntu:** the Linux distribution used by CI.
- **Unix-like environment:** an operating environment supporting the process-management and command-line operations required by some tools.
- **Codex CLI:** the default model command-line tool; users sign in with their own accounts.
- **Git:** the version-control tool used to obtain the pinned official source.
- **Node.js:** the runtime used for frontend checks and network-output verification.
