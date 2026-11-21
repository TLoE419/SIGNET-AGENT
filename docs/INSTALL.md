# Install from Scratch and Run the Chat Demo

This guide starts with a newly downloaded copy of SIGNET and ends with the desktop chat open. The desktop demo needs Python, Node.js, and one model provider. Study data, R, Docker, a VM, and a scheduler are only needed for scientific work.

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

The workspace opens without model credentials. For desktop chat, create a
[Gemini API key](https://aistudio.google.com/app/apikey) and save it under
**Settings → Chat model** after launch. To configure chat from the terminal,
create a Gemini or [Groq API key](https://console.groq.com/keys) and copy
`.env.example` only when `.env` does not already exist.

```sh
cp -n .env.example .env
```

Add the key to the matching `GROQ_API_KEY` or `GEMINI_API_KEY` line in `.env`. Keep `.env` private; it is excluded from version control. Never paste API keys into source files, issues, or chat messages. Provider account terms, quotas, and possible charges are controlled by that provider.

## 5. Start and check the chat page

From the project root, install the desktop dependencies and launch the app.

```sh
npm ci --prefix electron
npm start --prefix electron
```

Electron opens the desktop client and starts its Python API. With a model
configured, send a short question, then follow the [no-data demonstration](DEMO.md).

To use a provider configured in `.env`, start the desktop with that provider.

```sh
npm start --prefix electron -- --provider groq
```

```sh
npm start --prefix electron -- --provider gemini
```

For local testing with an installed and signed-in Codex CLI, launch with
`npm start --prefix electron -- --provider codex`.

Electron chooses an available local API port automatically. Closing the app
waits for active work. For backend-only development, run
`.venv/bin/python -m agent.app.chat_ui --port 8881`. Add `--provider gemini` or
`--provider groq` to enable chat using the configured key.

## Troubleshooting

| Problem | What to check |
|---|---|
| `python3` is missing or older than 3.11 | Install a supported Python version, open a new terminal, and rerun `python3 --version`. |
| `venv` creation fails on Ubuntu | Install `python3-venv` with `sudo apt install python3-venv`, then retry. |
| `pip install` fails | Check network access, confirm the terminal is in the project root, and retry the install command. Do not use `sudo pip`. |
| Chat says a model is required | Save a Gemini key in Settings, or launch with a provider configured in `.env`. |
| Model requests fail | Check the selected key, model access, provider quota, and terminal output. |
| Port 8880 is busy | Electron uses an available port; standalone API development can use `--port 8881`. |

## Scientific analysis requires a separate setup

The steps above install and run the chat interface; they do not prepare the scientific analysis environment. For the scientific software, VM, data, and stage-by-stage prerequisites, read the [scientific setup guide](SCIENTIFIC_SETUP.md). This repository does not include study or reference datasets, VM disks, or container images, and it does not provide a from-scratch scientific-environment installer. The repository has not been verified to run all six scientific stages from a clean machine.

For terminal chat, run `.venv/bin/python -m agent.core.conversation` from the project
root with a Gemini key, or add `--provider groq` with a Groq key.

### Desktop model and workflow controls

After launching Electron, configure SSH and open **Settings → Environment
readiness** to check the pinned source, container, and remote infrastructure.
Install SIGNET and download the container from the setup actions as needed. The
container download uses the configured Slurm partition. Use **HPC3 settings**
to change the installation root or partition. Select your uploaded study files
and references under **Data**.
The desktop environment settings are authoritative: `SIGNET_HPC_WORKSPACE` does
not override them. This preserves the root already selected for your SSH account.

The Gemini panel accepts your own key, verifies it with Google, and stores it
only when OS key-store encryption is available. Changing the chat configuration
waits for active Python work, restarts the backend, and restores conversation history.
