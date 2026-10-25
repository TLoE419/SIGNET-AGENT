# Install from Scratch and Run Your First Demonstration

Start here on a computer that does not yet have this project's tools. Run commands in a terminal, one block at a time, and stop if a command fails. Commands below use macOS Terminal (zsh) or Ubuntu's bash; they are not PowerShell commands.

## 1. Choose Your Goal and Platform

| Goal | What you need | Next steps |
|---|---|---|
| Open the chat page | Python and this project's Python packages | Sections 2–4 and 6; no model account is needed to load the page |
| Chat and demonstrate tool discovery | The above plus your own Codex sign-in, Groq key, or Gemini key | Sections 5–7 |
| Run the automated checks | Git, Node.js 24, Python packages, and pinned scientific source | Section 8; no model credentials or research data |
| Execute scientific analysis | Your own compatible data and the scientific dependencies for the selected stage | [Advanced setup](ADVANCED.md); source installation alone is insufficient |

The application has been exercised on macOS with Python 3.11. CI checks run on Ubuntu 24.04 with Python 3.11 and Node.js 24. The Ubuntu bootstrap below uses its packaged Python 3.12, which meets the application's Python 3.11+ requirement; see the PR validation record for versions actually exercised. Native Windows is unverified. Windows users can install [Ubuntu through WSL](https://learn.microsoft.com/en-us/windows/wsl/install), then follow the Ubuntu instructions inside that Linux terminal; WSL and its browser/network behavior have not been accepted by this project. The scientific VM path is separate from WSL.

Do not install R, Docker, a scheduler, or a scientific VM just to try chat. The project includes no research/example/reference datasets or completed analysis results.

## 2. Install the Basic Tools

Choose only the subsection for your operating system. An administrator password may be requested by the system package manager. Install project packages later inside `.venv`, never with `sudo pip`.

### macOS

1. Install Homebrew from the [official installation page](https://brew.sh/), using its installer or package. Follow the installer's **Next steps**, including the `brew shellenv` command it prints, then reopen Terminal. Use the instructions for your actual Apple Silicon or Intel machine rather than copying another machine's path.
2. Install the project tools:

```sh
brew install python@3.11 node@24 git
export PATH="$(brew --prefix node@24)/bin:$PATH"
python3.11 --version
node --version
npm --version
git --version
```

Python should report `3.11.x` and Node should report `v24.x`. The [Python formula](https://formulae.brew.sh/formula/python@3.11) supplies `python3.11`. Repeat the `export PATH=...` line in each new terminal before using Node or an npm-installed Codex. To make it persistent in zsh, add that exact line once to your `~/.zshrc`, then open a new terminal. Do not overwrite the whole file.

### Ubuntu 24.04

```sh
sudo apt-get update
sudo apt-get install -y python3 python3-venv python3-pip git curl ca-certificates build-essential
python3 --version
git --version
```

Python should report `3.12.x`. Install Node 24 under your own account with the [Node Version Manager's official installer](https://github.com/nvm-sh/nvm#installing-and-updating):

```sh
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh -o /tmp/signet-install-nvm.sh
bash /tmp/signet-install-nvm.sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install 24
nvm alias default 24
node --version
npm --version
```

Node should report `v24.x`. In a new terminal, your shell profile normally loads nvm. If it does not, repeat the two `NVM_DIR` / `nvm.sh` lines before using Node or Codex. These commands install development tools; they do not prepare a scientific runtime.

## 3. Download the Project

From a directory where you want a **new** checkout:

```sh
mkdir -p "$HOME/Developer"
cd "$HOME/Developer"
git clone https://github.com/TLoE419/SIGNET-AGENT.git
cd SIGNET-AGENT
```

If `SIGNET-AGENT` already exists, use a different new directory name rather than replacing it. Alternatively, choose **Code → Download ZIP** on GitHub, extract it, and open a terminal in the extracted root containing `chat_ui.py` and `requirements.txt`. Git is still required for source preparation in section 8.

Run all remaining **host** commands from that project root. For future scientific tools, the absolute project/input paths must contain only English letters, digits, `_`, `.`, `/`, and `-`; spaces or non-ASCII characters in your home directory also matter. If necessary, choose another writable location meeting that restriction.

## 4. Create the Python Environment

On macOS:

```sh
python3.11 -m venv .venv
```

On Ubuntu 24.04:

```sh
python3 -m venv .venv
```

Then, on either platform:

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
.venv/bin/python -c "import dotenv, google.genai, httpx, tokenizers; print('Python dependencies ready')"
```

Expected: `No broken requirements found.` and `Python dependencies ready`. No activation command is needed: `.venv/bin/python` explicitly selects this project's environment. `requirements.txt` pins four direct dependencies; transitive dependencies are resolved at installation time and are not fully locked.

## 5. Configure One Model Provider

### Option A: Codex (default)

[OpenAI's official CLI guide](https://learn.chatgpt.com/docs/codex/cli) documents npm installation. This project checks compatibility against version `0.162.1`; install that version explicitly rather than silently switching to the latest:

```sh
npm install -g @openai/codex@0.162.1
codex --version
codex login
codex login status
```

Complete sign-in yourself in the browser. The version should be `codex-cli 0.162.1`, and status must confirm that you are signed in. A compatible account and available usage allowance are required. Do not copy another person's credentials. If a different Codex version is already installed, use a separate user-managed Node environment or one of the alternative providers instead of replacing a shared installation without checking its users.

The model follows your local Codex configuration by default. An optional `SIGNET_CODEX_MODEL` in `.env` selects a model your account can access. A successful sign-in does not prove a particular model or account allowance is available.

### Option B: Groq or Gemini

Create `.env` only when it does not already exist:

```sh
if [ ! -e .env ]; then cp .env.example .env; fi
```

Open `.env` in your text editor and fill in **one** of `GROQ_API_KEY` or `GEMINI_API_KEY`. Obtain your own key from [Groq Console](https://console.groq.com/keys) or [Google AI Studio](https://aistudio.google.com/apikey). Keep the unused key blank. This project does not provide account access, keys, or credits. Keep `.env` local; do not paste secrets into chat, source code, or screenshots.

## 6. Start and Check the Page

Choose the command matching section 5:

```sh
# Codex
.venv/bin/python chat_ui.py
# Or Groq
.venv/bin/python chat_ui.py --provider groq
# Or Gemini
.venv/bin/python chat_ui.py --provider gemini
```

Run **one** of these commands, leave that terminal open, and open [http://127.0.0.1:8880](http://127.0.0.1:8880) in a browser on the same computer. Do not double-click the HTML file or expose the service on your network.

In a second terminal at the project root, this check needs no model request:

```sh
.venv/bin/python -c "from urllib.request import urlopen; r=urlopen('http://127.0.0.1:8880', timeout=5); print(r.status)"
```

Expected: `200` and the chat page in the browser. Page loading confirms only the web service; model and scientific readiness are separate.

If port 8880 is busy, append `--port 8881` to the chosen launch command and use `http://127.0.0.1:8881` in both the browser and check. For WSL, try the localhost address in the Windows browser; if forwarding is unavailable, consult the [WSL networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking) rather than changing this service's loopback binding.

## 7. Verify a Small Demonstration, Then Stop or Restart

Select **English**, then ask: "Describe the available analysis tools and their required inputs. Do not execute an analysis." A real answer requires your selected provider and may consume account allowance. Inspect **Activity** below the conversation for progress and tool records. Follow [DEMO.md](DEMO.md) for the remaining no-data checks.

A fresh download has no graph baseline or scientific results. You can demonstrate chat, tool discovery, and missing-prerequisite reporting without obtaining research datasets. Messages and required tool content are sent to the selected model service; the local interface does not imply an offline model.

Press Ctrl+C in the service terminal to stop it. Closing a browser tab does not cancel already-started scientific tools; query their recorded status before retrying. Local history is stored in `.chat-state.json` and workspace state in `.stage6-workspace.json`; do not share either file. Restart from the same project root using the same section 6 command. Your `.venv` and settings remain, so you do not reinstall on each launch. To use terminal chat, run `.venv/bin/python main.py` instead.

## 8. Prepare Scientific Source and Run Checks (Optional)

This downloads audited code, templates, and upstream licenses, **not data or a scientific runtime**:

```sh
.venv/bin/python scripts/setup_source.py
.venv/bin/python -m unittest discover -s tests -v
node tests/test_markdown.cjs
node tests/test_i18n.cjs
node tests/test_stage6_graph.cjs
node tests/test_chat_progress.cjs
```

Expected: source installed under `.dependencies/official-signet`, Python reports `OK` (platform-specific skips may be reported), and all four Node checks succeed. Source preparation needs network access and refuses to replace an existing destination. If source is already present and valid, skip the setup command; do not delete user assets to silence that refusal. For a separate new destination and `SIGNET_SOURCE`, see [ADVANCED.md](ADVANCED.md).

These tests use temporary synthetic inputs and do not need model keys, research data, or a running VM. Passing them does not validate scientific analysis. For scientific execution, continue to the [advanced guide](ADVANCED.md), including its [fresh VM recipe](SCIENTIFIC_VM.md).

## 9. Troubleshooting

| Symptom | Check or action |
|---|---|
| `brew`, `python3.11`, `node`, `npm`, or `codex` not found | Complete section 2, open a new terminal, and check the Homebrew/nvm PATH steps; do not substitute an old system Python |
| `No module named venv` / `ensurepip` unavailable | On Ubuntu, install `python3-venv` for the selected Python; recreate only a disposable, incomplete `.venv` |
| Package download or TLS error | Check internet, system time, proxy, and trusted certificates; do not disable TLS checks |
| Binary package cannot be installed | Confirm Python 3.11+ and supported machine architecture; retain the installer error and use the documented baseline before adding arbitrary packages |
| npm reports `EACCES` | On Ubuntu use your nvm-managed Node; on macOS check Homebrew ownership/prefix. Do not use `sudo npm install` as a generic workaround |
| Browser says connection refused | Keep the server terminal open; inspect its error and use the same port in browser and launch command |
| Page loads but chat fails | Check `codex login status` or the selected provider's key, quota, and model availability; inspect Activity without sharing credentials |
| Groq is waiting after a rate limit | It retries the same model request without repeating completed tools; Ctrl+C interrupts the wait |
| Official source unavailable | Run section 8; do not confuse source readiness with scientific runtime readiness |
| Data or scientific dependencies unavailable | Follow ADVANCED.md; do not expect bundled data, a VM disk, or automatic science-tool installation |

When asking for help, include OS, architecture, Python/Node/Codex versions, the failing command, and its redacted error. Preserve `.env`, data, run records, and existing environments. Never post private keys, chat history, or model tokens.
