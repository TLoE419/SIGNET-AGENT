# Project Files and Responsibilities

This tree lists the project files with the optional Electron shell; the pull request records the actual merge status. All data and local work products are excluded. Tests generate only the necessary synthetic content in temporary directories.

```text
SIGNET-agent/
├── .github/
│   └── workflows/
│       └── test.yml              # Automated tests for chat, frontend behavior, and pinned source
├── .env.example                  # Template for empty keys and advanced environment settings
├── .gitignore                    # Excludes all data, credentials, records, and local dependencies
├── README.md                     # Project overview, scope, and quick start
├── requirements.txt              # Pins four direct dependency versions
├── chat_ui.py                    # Independent local API service, conversation storage, and workspace API
├── llm_providers/                # Factory dispatch and isolated Codex, Gemini and Groq adapters
├── main.py                       # Conversation flow, public progress, and controlled tool calls
├── codex_provider.py             # Uses the downloader's own signed-in model CLI
├── groq_provider.py              # Groq connection, tool format, and rate-limit waits
├── context_budget.py             # Input length and compression of repeated tool evidence
├── model_timing.py               # Model request and transport timing
├── tools.py                      # Restricted file listing and paginated text reading
├── signet_tools.py               # Scientific tools, parameter validation, and isolated job preparation
├── signet_inventory.json         # Official code version, classification, and file hashes
├── signet_runtime.py             # Local VM connection, packaging, and output collection
├── ssh_transport.py              # Private Electron broker client for SSH command transport
├── network_runtime.py            # Network inference submission, queries, cancellation, and result checks
├── network_worker.py             # Background control and supervision of owned jobs inside the VM
├── visualization_runtime.py      # Stage 6 plotting and input/output checks
├── stage6_workspace.py           # Parameter proposals, human confirmation, history, and comparison
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
│   │   └── devtools/             # Developer terminal service
│   ├── preload/                  # Restricted desktop API bridge
│   ├── renderer/
│   │   ├── app/                  # React root and application shell
│   │   ├── features/             # chat/, stage6/, ssh/, devtools/
│   │   ├── components/           # Shared dialogs, actions and icons
│   │   ├── styles/               # Colors, spacing and interface styles
│   │   ├── i18n/                 # English / Traditional Chinese
│   │   └── vendor/               # Third-party assets and licenses
│   ├── shared/ssh/               # Shared contracts and validation
│   ├── scripts/                  # Build and native dependency preparation
│   ├── tests/                    # Unit, integration and Electron smoke tests
│   └── package.json              # App entry and build/test commands
└── tests/
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
