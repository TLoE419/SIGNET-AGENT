# Installation and First Launch

The former desktop application's `desktop/` and `tools/setup-dev.sh` have been retired. This version starts a Python chat service from the project root. Desktop work data is not migrated automatically; retain your old data and environment assets.

## 1. Prepare the Runtime

Download and extract the project, then open a terminal in its root directory. The basic chat interface needs no scientific data, R, containers, or scheduler. Python 3.11 or later is required; the checked platform is macOS with Python 3.11. Native Windows operation has not been verified, and advanced tools rely on Unix-like process management.

```sh
python3.11 --version
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
```

`requirements.txt` pins direct dependencies. Transitive dependencies are resolved by the package installer; this is not a complete dependency lock. Frontend packages are bundled, so no web build packages need to be installed.

## 2. Configure Your Model

Codex CLI is the default provider. The version checked for this project is `0.162.1`, using structured responses, ephemeral sessions, and a read-only sandbox; other versions may be incompatible. See the [Codex CLI documentation](https://learn.chatgpt.com/docs/codex/cli) for installation and the [official OpenAI command reference](https://learn.chatgpt.com/docs/developer-commands#codex-login) for sign-in and command behavior.

After installation, check:

```sh
codex --version
codex login
codex login status
```

Sign in yourself. This project does not provide or copy account credentials. The model follows your local Codex configuration by default; to select a model explicitly, set `SIGNET_CODEX_MODEL` in `.env`. Chat consumes your account's usage allowance.

Groq and Gemini are also supported:

```sh
cp .env.example .env
```

Copy this file only on first setup, when `.env` does not already exist. Edit it to supply your own `GROQ_API_KEY` or `GEMINI_API_KEY`. `.env` is excluded from version control; do not paste keys into chat or source code.

```sh
.venv/bin/python chat_ui.py --provider groq
# or
.venv/bin/python chat_ui.py --provider gemini
```

## 3. Start the Service

```sh
.venv/bin/python chat_ui.py
```

Open the [local interface](http://127.0.0.1:8880). The page can load without model sign-in, but real chat responses require it. If the port is already in use, run:

```sh
.venv/bin/python chat_ui.py --port 8881
```

Open `http://127.0.0.1:8881` instead. Press Ctrl+C in the terminal to stop the service. Check status records for scientific tools that have already started; closing the page does not cancel them.

## 4. Verify a Minimal Demonstration

Follow the [demonstration guide](DEMO.md) to ask about tool capabilities and input requirements. The download includes no `data/`, `runs/`, or completed results. An absent network graph is expected and does not indicate a loading failure.

For terminal chat, run:

```sh
.venv/bin/python main.py
```

## 5. Common Missing Prerequisites

| Symptom | Action |
|---|---|
| Codex is unavailable or sign-in fails | Confirm that the command runs and sign-in is valid, or select a model with a configured key |
| Official source is not prepared | Run `scripts/setup_source.py` as described in the advanced guide; basic chat does not require this step |
| Input data cannot be found | Create `data/` yourself and provide inputs in the format required by the tool |
| Scientific environment is unavailable | Read the advanced guide; this project does not automatically create a VM or install scientific tools |
| Waiting after a rate limit | Groq retains the same model request for retry without repeating completed tools; Ctrl+C interrupts the wait |

## Terminology

- **Python:** the language and runtime required by this project.
- **Unix-like:** an operating environment supporting the relevant process-management operations.
- **Codex CLI:** the default model command-line tool.
- **API:** the model-service interface accessed with a key.
