# Project Files and Responsibilities

This tree lists the supported Electron client, Python API, and standalone HPC3 baseline scripts; the pull request records the actual merge status. All data and local work products are excluded. Tests generate only the necessary synthetic content in temporary directories.

```text
SIGNET-agent/
├── .github/
│   └── workflows/
│       └── test.yml              # Automated tests for chat, frontend behavior, and pinned source
├── .env.example                  # Template for empty keys and advanced environment settings
├── .gitignore                    # Excludes all data, credentials, records, and local dependencies
├── README.md                     # Project overview, scope, and quick start
├── requirements.txt              # Pins four direct dependency versions
├── runtime_modules.sh           # Shared versioned container-module initialization
├── signet_inventory.json         # Official code version, classification, and file hashes
├── agent/                        # All Python code, one package
│   ├── paths.py                  # The single definition of the project root (data/, runs/, .env, assets/)
│   ├── app/
│   │   ├── chat_ui.py            # Loopback API, conversation storage, and workspace API
│   │   └── signet_api.py         # /signet/* routes: runs, settings (-s), and HPC3 step jobs; no business logic
│   ├── core/
│   │   ├── conversation.py       # Conversation flow, public progress, controlled tool calls; terminal chat entry point
│   │   ├── context_budget.py     # Input length and compression of repeated tool evidence
│   │   └── model_timing.py       # Model request and transport timing
│   ├── providers/                # Factory dispatch and isolated Codex, Gemini and Groq adapters
│   │   ├── codex_client.py       # Uses the downloader's own signed-in model CLI
│   │   └── groq_client.py        # Groq connection, tool format, and rate-limit waits
│   ├── tools/
│   │   ├── general.py            # Restricted file listing and paginated text reading
│   │   ├── registry.py           # Every model-callable tool; also the dispatch allow-list
│   │   ├── hpc.py                # HPC3 readiness check, shared environment boundary, reference preparation, setup logs
│   │   └── signet.py             # Scientific tools, parameter validation, and isolated job preparation
│   ├── runtime/
│   │   ├── hpc.py                # HPC3 workspace layout, read-only checks, background setup steps
│   │   ├── hpc_files.py          # Desktop file window: browse HPC3 and choose reference files (not a model tool)
│   │   ├── jobs/
│   │   │   └── prepare_reference.py  # Runs on HPC3: detects ref/gmap formats and converts them for one study
│   │   ├── remote.py             # Remote connection, packaging, and output collection
│   │   ├── ssh_transport.py      # Private Electron broker client for SSH command transport
│   │   ├── network.py            # Network inference submission, queries, cancellation, and result checks
│   │   ├── network_worker.py     # Uploaded on its own; supervises owned jobs on the remote host
│   │   ├── signet_jobs.py        # One SIGNET step (e.g. signet -t) as a Slurm job: submit, status, cancel, logs, output checks
│   │   └── visualization.py      # Stage 6 plotting and input/output checks
│   └── stage6/
│       └── workspace.py          # Parameter proposals, human confirmation, history, and comparison
├── assets/
│   └── tokenizers/
│       ├── qwen3.8-27b.json       # About 12.8 MB of tokenizer data; no study data or model weights
│       ├── README.md             # Tokenizer data source, version, and hash
│       └── LICENSE               # Upstream license for tokenizer data
├── docs/
│   ├── INSTALL.md                # First installation, model sign-in, and interface startup
│   ├── SCIENTIFIC_SETUP.md       # Scientific software, VM, data, and six-stage readiness guide
│   ├── ADVANCED.md               # Official source, user-supplied data, and advanced scientific environment
│   ├── THIRD_PARTY.md            # Third-party sources and pending licensing decision
│   ├── FILE_TREE.md              # This file tree and per-file responsibilities
│   └── DEMO.md                   # No-data demonstration and operations with user-supplied results
├── scripts/
│   ├── setup_source.py           # Obtains and checks pinned scientific code without installing data
│   ├── prepare_genotype_reference.py  # Converts user-supplied reference files
│   ├── check_genotype_example.py  # Checks user inputs inside an existing VM
│   └── advanced/
│       ├── start_scientific_vm.sh # Advanced startup script for the existing recovery environment
│       └── verify_network.cjs     # Verifies scheduler, matrices, commands, and resampling results
├── electron/
│   ├── main/
│   │   ├── app/                  # Entry, windows and application lifecycle
│   │   ├── backend/              # Python process supervision and server.py
│   │   ├── security/             # Navigation and owned-origin policy
│   │   ├── renderer/             # Asset serving and API forwarding
│   │   ├── ssh/                  # Native transport, keys, trust, IPC and broker
│   │   ├── model/                # Encrypted Gemini key storage and model switching
│   │   ├── environment/          # Single remote environment authority and module initialization
│   │   └── devtools/             # Developer terminal service
│   ├── preload/                  # Restricted desktop API bridge
│   ├── renderer/
│   │   ├── app/                  # React root and application shell
│   │   ├── features/             # chat/, stage6/, ssh/, model/, environment/, remote-files/, devtools/
│   │   ├── components/           # Shared dialogs, actions and icons
│   │   ├── styles/               # Colors, spacing and interface styles
│   │   ├── i18n/                 # English / Traditional Chinese
│   │   └── vendor/               # Third-party assets and licenses
│   ├── shared/ssh/               # Shared contracts and validation
│   ├── scripts/                  # Build and native dependency preparation
│   ├── tests/                    # Unit, integration and Electron smoke tests
│   └── package.json              # App entry and build/test commands
├── hpc/
│   └── baseline/                 # Monitor Spec 01: runs on HPC3, not imported by the app
│       ├── README.md             # Setup, experiments, fixture format, and sanitizing before commit
│       ├── env.sh.example        # Template for SIGNET path and lab account; env.sh is excluded
│       ├── config/baseline.overrides  # SIGNET settings applied through `signet -s` before each job
│       ├── templates/            # sbatch templates for -g/-t/-a/-c and a scheduler-only sleep job
│       ├── scripts/              # Submission, Slurm observers, output listing, experiments, sanitizer
│       └── reports/README.md     # Where partition limits and the observation report go
└── tests/
    ├── fixtures/slurm/README.md  # Where sanitized HPC3 baseline fixtures go and how to add them
    ├── test_baseline_monitor.py  # Slurm parsing, observers, sanitizer, and baseline shell scripts
    ├── test_chat.py              # Conversation and tool flow
    ├── test_chat_progress.cjs     # Chat progress visibility, restoration, errors, and visualization isolation
    ├── test_chat_ui.py           # Web request protection, streamed progress, and conversation isolation
    ├── test_codex_provider.py    # Model CLI, formatting, and credential isolation
    ├── test_context_budget.py   # Input length and evidence compression
    ├── test_decision_summary.py # Public tool-selection summaries
    ├── test_diagnostics.py      # Error reporting and sensitive-content redaction
    ├── test_genotype_reference.py # Reference-data conversion
    ├── test_groq_provider.py    # Groq responses, rate limits, and tool format
    ├── test_i18n.cjs            # Language switching and content retention
    ├── test_list_files.py      # Recursive file listing and hidden-file / symlink exclusion
    ├── test_markdown.cjs       # Response formatting and unsafe-content handling
    ├── test_model_timing.py    # Model transport timing
    ├── test_network_runtime.py # Scheduling, cancellation, and the actual verifier
    ├── test_portability.py     # Portable paths, source installation, and configuration protection
    ├── test_read_file.py       # Text-reading boundaries and pagination
    ├── test_signet_api.py      # /signet/* token, Origin and Host checks, status codes and JSON shapes
    ├── test_signet_jobs.py     # SIGNET step jobs against a fake HPC3 folder and fake Slurm commands
    ├── test_signet_runtime.py  # VM packaging, collection, and unknown status
    ├── test_ssh_transport.py   # Electron broker protocol and runtime transport selection
    ├── test_signet_tools.py    # Source, tools, and execution restrictions
    ├── test_stage6_graph.cjs   # Network graph dragging, viewport, and comparison
    ├── test_stage6_workspace.py # Proposals, human confirmation, and workspace isolation
    ├── test_visualization_runtime.py # Stage 6 inputs and outputs
    └── test_vm_start.py        # Startup-script disk and container protection
```

Excluded from uploads: `data/`, `runs/`, `.env`, chat/workspace state, `.venv/`, `.dependencies/`, caches, `evidence/`, `artifacts/`, `.archify/`.

Existing local data is retained. Code obtained by the source-preparation script also stays in an excluded directory and is not part of the upload list.
