# Install from Scratch and Run the Chat Demo

This guide starts with a newly downloaded copy of SIGNET and ends with the local chat page open. The basic demo needs Python and one model provider. It does not need study data, Node.js, R, Docker, a VM, or a scheduler.

The verified desktop platform is macOS with Python 3.11. The project requires Python 3.11 or later. CI checks run on Ubuntu 24.04, but that is not a full Linux desktop acceptance test. Native Windows operation has not been verified; use [Windows Subsystem for Linux (WSL)](https://learn.microsoft.com/windows/wsl/install) if you need a Unix-like command line on Windows, and treat that route as unverified.

## 1. Install Python

On macOS, install a Python 3.11 or later macOS package from the [official Python downloads](https://www.python.org/downloads/macos/). On Linux, use your distribution's Python 3 package and confirm it is version 3.11 or later. On WSL Ubuntu, install Python and the virtual-environment package in step 2.

Check that Python is available in a terminal:

```sh
python3 --version
```

The output must show Python 3.11 or later. If `python3` is missing or older, finish installing a supported version before continuing. Do not change or remove the operating system's system-managed Python.

## 2. Download and extract SIGNET

Download the [latest main-branch ZIP](https://github.com/TLoE419/SIGNET-AGENT/archive/refs/heads/main.zip) and extract it. Open a terminal in the extracted `SIGNET-AGENT-main` folder. Avoid spaces and special characters in the project path if you plan to use scientific tools; some pinned upstream scripts cannot handle them safely.

On WSL Ubuntu, you can download and extract the same archive from the terminal instead:

```sh
sudo apt update
sudo apt install -y curl unzip python3 python3-venv
curl -fL -o SIGNET-AGENT-main.zip https://github.com/TLoE419/SIGNET-AGENT/archive/refs/heads/main.zip
unzip SIGNET-AGENT-main.zip
cd SIGNET-AGENT-main
python3 --version
```

Check that Python is 3.11 or later. If Ubuntu provides an older version, install a newer Python using the Ubuntu release's official instructions before continuing.

## 3. Create the application environment

Run these commands in the project root. They create an isolated Python environment and install the pinned direct dependencies without changing system Python packages:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pip check
```

The last command should report `No broken requirements found.` The project pins direct dependency versions; transitive dependencies are resolved by the package installer, so this is not a complete lock of every installed package. The desktop frontend requires Node.js 22.12+ and npm. Python remains independently usable for backend development.

## 4. Set up a model provider

Choose one provider. The default is Codex CLI, which uses your own sign-in:

1. Install Codex CLI with the official macOS/Linux installer, or follow the [official installation instructions](https://learn.chatgpt.com/docs/codex/cli):

   ```sh
   curl -fsSL https://chatgpt.com/codex/install.sh | sh
   ```

2. Open a new terminal and run:

   ```sh
   codex --version
   codex login
   codex login status
   ```

3. Complete sign-in yourself when prompted. `codex login status` should report that you are logged in. This project was checked with Codex CLI `0.162.1`; other versions may use incompatible command options or response formats. The CLI uses your account's available usage allowance.

Alternatively, provide your own [Groq API key](https://console.groq.com/keys) or [Gemini API key](https://aistudio.google.com/app/apikey). Create the key in the provider console, then copy `.env.example` only when `.env` does not already exist:

```sh
cp -n .env.example .env
```

Add the key to the matching `GROQ_API_KEY` or `GEMINI_API_KEY` line in `.env`. Keep `.env` private; it is excluded from version control. Never paste API keys into source files, issues, or chat messages. Provider account terms, quotas, and possible charges are controlled by that provider.

## 5. Start and check the chat page

From the project root, start the default Codex provider:

```sh
npm ci --prefix electron
npm start --prefix electron
```

Electron opens the desktop client and starts its Python API. Send a short question to check model sign-in, then follow the [no-data demonstration](DEMO.md).

If you chose Groq or Gemini, start the selected provider instead:

```sh
npm start --prefix electron -- --provider groq
```

```sh
npm start --prefix electron -- --provider gemini
```

Electron chooses an available local API port automatically. Closing the app
waits for active work. For backend-only development, run
`.venv/bin/python chat_ui.py --port 8881`; this serves APIs, not a browser UI.
Model requests still use the selected provider's network service.

## Troubleshooting

| Problem | What to check |
|---|---|
| `python3` is missing or older than 3.11 | Install a supported Python version, open a new terminal, and rerun `python3 --version`. |
| `venv` creation fails on Ubuntu | Install `python3-venv` with `sudo apt install python3-venv`, then retry. |
| `pip install` fails | Check network access, confirm the terminal is in the project root, and retry the install command. Do not use `sudo pip`. |
| `codex` is not found | Complete the official CLI installation, open a new terminal, and run `codex --version`. |
| Model sign-in fails | Run `codex login status` and complete sign-in again, or switch to a provider with a valid key in `.env`. |
| The page opens but chat fails | Check the selected provider's sign-in or key and inspect the terminal where Electron was launched. |
| Port 8880 is busy | Electron uses an available port; standalone API development can use `--port 8881`. |

## Scientific analysis requires a separate setup

The steps above install and run the chat interface; they do not prepare the scientific analysis environment. For the scientific software, VM, data, and stage-by-stage prerequisites, read the [scientific setup guide](SCIENTIFIC_SETUP.md). This repository does not include study or reference datasets, VM disks, or container images, and it does not provide a from-scratch scientific-environment installer. The repository has not been verified to run all six scientific stages from a clean machine.

For terminal chat instead of the web page, run `.venv/bin/python main.py` from the project root.
