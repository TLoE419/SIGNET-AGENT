# User Guide: Running SIGNET Agent

This guide takes you from a fresh download to a finished SIGNET network on UCI HPC3, using the
official example data. The app runs on your computer; all SIGNET steps run on HPC3 under your own account.

## 1. What you need

- macOS (the tested platform; Linux should work, Windows is not supported)
- [Python](https://www.python.org/downloads/) 3.11 or later
- [Node.js](https://nodejs.org/) 22.12 or later
- An HPC3 account with Duo. Off campus, connect to the UCI VPN first.
- One chat model: a signed-in [Codex CLI](https://learn.chatgpt.com/docs/codex/cli) (default) or a
  [Gemini API key](https://aistudio.google.com/app/apikey)

## 2. Install and start

From the project folder:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci --prefix electron
npm start --prefix electron
```

The desktop window opens and starts the local Python service automatically. Next time, only
`npm start --prefix electron` is needed.

**Chat model.** For Codex, run `codex login` once in a terminal before starting the app.
For Gemini, enter your key in the app's Gemini settings at the top of the window
(it is verified and stored in the system keychain).

## 3. Connect to HPC3

1. Click the SSH control at the top right.
2. Choose **Duo**, enter your UCInetID, then **Connect**.
3. Enter your password and approve the Duo prompt.
4. The first time, the app shows HPC3's host-key fingerprint. Confirm it before trusting.

## 4. Prepare the environment (once per account)

Open **Workflow → Prepare environment**. Each item shows *Ready*, *Missing* or *Problem*.
Click the button on each missing item, in this order:

| Item | Button | What happens |
|---|---|---|
| Workspace folder | Create | Creates `/pub/<account>/signet-agent` |
| SIGNET source code | Install | Installs the audited SIGNET commit with its example data |
| SIGNET container | Download | Downloads `signet-0.0.6.sif` (about 6 GB) |
| ref, gmap, gtf, clinical | Download | Downloads public reference data (see [REFERENCE_DATA.md](REFERENCE_DATA.md)) |
| Imputation reference | Convert | Converts ref and gmap for IMPUTE2 |

- Each button asks for confirmation, then runs as a Slurm job. You can keep using the app.
- Download the container before the gtf (the GTF is processed inside the container).
- Press **Check again** to refresh. When everything is *Ready*, the panel shows **Next: Data preprocessing →**.
- **HPC3 settings** changes the install folder or Slurm partition (default `free`).

## 5. Run an analysis

1. In **Workflow → Data preprocessing**, click **Start with the official example**.
2. A confirmation card appears in the chat. Review it and click **Approve and start this step**.
   Nothing is submitted to HPC3 until you click.
3. When a step finishes, the card for the next step appears. The six steps are:

| # | Step | SIGNET | What you decide on the card |
|---|---|---|---|
| 1 | Genotype QC and imputation | `-g` | Review settings |
| 2 | Expression preparation | `-t` | Review settings |
| 3 | Covariate adjustment | `-a` | How to treat race values SIGNET cannot handle (e.g. `Unknown`) |
| 4 | cis-eQTL mapping | `-c` | Review settings |
| 5 | Network inference | `-n` | Bootstrap count and job size (the longest step) |
| 6 | Visualization | `-v` | Review settings |

Each card shows live progress. Jobs keep running on HPC3 even if you close the app; reopen it
and the chat picks up the status.

## 6. Results

After step 6, the results card shows:

- the gene regulatory network graph
- SIGNET's own plots
- a connections table and the frequency-cutoff chart
- **Download analysis results** (network-level files only; patient-level results stay on HPC3)

To try different settings, click **Rerun stage** on a finished card. This creates a new analysis
from that step and keeps the original for comparison. Start each new analysis in a new chat.

## 7. Using the chat assistant

You can ask the assistant in English or Traditional Chinese, for example:

- "What does step 3 do and what input does it need?"
- "Why did the last step fail?" (it reads the step log, with patient IDs masked)
- "Summarize the results of this analysis."

The assistant can explain, prepare cards and read step reports. It cannot run a step by itself and
never sees patient-level data.

## 8. Troubleshooting

| Problem | What to do |
|---|---|
| Cannot connect to HPC3 | Check the VPN off campus and approve Duo within 3 minutes |
| Workflow items stuck on *In progress* | A Slurm job is still running; press **Check again** later |
| A step failed | Ask the assistant why it failed (it reads the step log), then fix the cause and run the step again |
| Chat does not answer | Run `codex login status`, or check the Gemini key |
| `python3` or `npm` not found | Install Python 3.11+ / Node.js 22.12+ and open a new terminal |
