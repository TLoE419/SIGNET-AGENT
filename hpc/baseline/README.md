# HPC3 Baseline Observation (Monitor Spec 01)

Scripts that run each SIGNET step on UCI HPC3 with the simulated data shipped in `example/`, and record what Slurm and the logs report at every stage. The recordings become the specification and offline test fixtures for the monitor (Specs 02–04).

Everything here runs **while logged in to HPC3**. Nothing is imported by the chat application. Python is stdlib only; heavy work always goes through `sbatch`.

## Layout

| Path | Purpose |
|---|---|
| `env.sh.example` | Copy to `env.sh` (git-ignored) and fill in paths and the lab account |
| `config/baseline.overrides` | Settings applied to SIGNET's `config.ini` through `signet -s` before every job |
| `templates/signet_{g,t,a,c}.sub` | One sbatch template per step; resources come from the command line |
| `templates/sleep_test.sub` | Scheduler-only job for timeout, OOM, cancel and pending experiments |
| `templates/common.sh` | START/END markers, config reset, container wrapper |
| `scripts/submit_step.sh` | Submit a step, snapshot outputs, start the observer |
| `scripts/observe.py` | Poll `squeue` / `sstat` / `sacct` (≥ 15 s) into `snapshots.jsonl` |
| `scripts/observe_network.py` | Observer for `signet -n` and its child jobs |
| `scripts/start_network.sh` | N1 launcher: runs `signet -n` in tmux with the network observer |
| `scripts/collect_outputs.sh`, `outputs.py` | `res*` / `tmp*` paths and sizes, plus the diff since submission |
| `scripts/run_experiments.sh` | B1–B4 and E1–E9 from Spec 01 §8 |
| `scripts/apply_config.sh` | Resets `config.ini` to the overrides and verifies each value |
| `scripts/sanitize_fixture.py` | Copies a raw fixture into `tests/fixtures/slurm/` with private values replaced |
| `scripts/slurm_parse.py`, `fixture_io.py` | Shared parsers and fixture writers; tested in CI |

## Setup on HPC3

```sh
cp -r hpc/baseline /pub/$USER/signet-monitor/baseline
cd /pub/$USER/signet-monitor/baseline
cp env.sh.example env.sh        # fill in SIGNET_DIR, LAB_ACCOUNT, optional input paths
source env.sh
sacctmgr show assoc user=$USER format=account
git -C "$SIGNET_DIR" rev-parse HEAD     # expect bed55b3e121de0edf5fd43da683dc59850ff82d3
mkdir -p reports && sinfo -o "%P %c %m %l" > reports/sinfo.txt
bash scripts/apply_config.sh            # check every line says "key = value" or SKIPPED
```

`apply_config.sh` backs up the original `config.ini` once as `config.ini.pre-baseline`.

## Running

```sh
scripts/run_experiments.sh E1 E2 E3          # scheduler-only experiments first
scripts/run_experiments.sh all-baselines     # B1-B4, one SIGNET step at a time
scripts/run_experiments.sh E4 E7 E8          # SIGNET failure experiments
tmux new -s n1 'scripts/start_network.sh N1'  # N1, from the login node as SIGNET intends
```

A single step can also be submitted directly:

```sh
scripts/submit_step.sh t B2-retry --partition=free --account=$LAB_ACCOUNT \
    --cpus-per-task=4 --mem=16G --time=02:00:00
```

Each run writes `fixtures/<YYYYMMDD-HHMMSS>_<step>_<label>/`:

| File | Content |
|---|---|
| `meta.json` | run_id, step, full sbatch argv, SIGNET commit, host, submit time, job ID, experiment env |
| `config_overrides.txt` | The overrides file used for this run |
| `outputs_before.json` / `outputs.json` / `outputs_diff.json` | `res*` / `tmp*` paths, sizes, mtimes |
| `snapshots.jsonl` | One line per poll: raw command output, parsed rows, state, log tail, log mtime/size |
| `stdout.log` / `stderr.log` | The job's own output, with `[BASELINE] START` / `END` markers |
| `sacct_final.txt` / `sacct_final.json` | Final accounting, raw and parsed, one row per job step |
| `observer_status.json` | Why the observer stopped (stable terminal state or deadline) |
| `children.json` | `-n` only: every child job with stage, account, state, elapsed, MaxRSS |
| `notes.md` | Human observations (Spec 01 §8.3 questions for N1) |

Add `notes.md` by hand after each run.

## Committing fixtures

The repository is public. Raw fixtures contain your UCInetID, the lab account, node names and `/pub` paths, so they stay on HPC3 (`fixtures/` is git-ignored). Copy them into the repo through the sanitizer:

```sh
source env.sh
python3 scripts/sanitize_fixture.py fixtures/<run_id> <repo>/tests/fixtures/slurm/<run_id>
```

It replaces `SIGNET_DIR`, `BASELINE_DIR`, `HOME`, the user and the account with `<SIGNET_DIR>`, `<USER>` and so on, maps node names to `hpc3-node-NN`, and replaces the UID in `CANCELLED by <uid>`. It refuses to run if any of those values remain, and never overwrites an existing destination.

## Where this differs from the spec text, and why

- **`--output` / `--error` are passed by `submit_step.sh`, not written in the templates.** `#SBATCH` lines cannot expand `$FIXTURE_DIR`. The templates keep only `--job-name`.
- **`-g`/`-t`/`-a`/`-c` run inside the container** (`singularity exec $SIGNET_SIF ./signet ...`), as the SIGNET manual requires. `-n` runs outside it.
- **Only `-g` has a core option (`--ncores`).** The other steps read `ncore_local` from `config.ini`, so every template sets it to `$SLURM_CPUS_PER_TASK` first.
- **The config is reset before every job.** SIGNET's step flags (for example E4's `--g /nonexistent/...`) write themselves into `config.ini` permanently. Without a reset, one experiment would break the next.
- **`snapshots.jsonl` stores `parsed` as a list of rows** rather than one object, because `sacct` returns one row per job step.

## Things to look for (predicted from the pinned source, not yet observed)

- `signet` always ends with `exit 0`, so a failing SIGNET step will most likely show `COMPLETED` in Slurm. The `[BASELINE] END exit=` marker and log patterns are what the monitor will have to rely on.
- `-n` writes `job<k>_command`, `sub*.sh` and `submit<k>_log` under `$SIGNET_DIR/tmp/tmpn/stage<k>/`. Both stages reuse the names `sub<i>.sh`, so stage is tagged from the job IDs in `submit<k>_log`.
- Before submitting anything, `-n` runs `uncor.R`, `gendata.R`, `rmcons.R` and a 10-gene profile (`bstest1.r`) inside the container **on the login node**. Confirm with RCIC that this is acceptable.
- `network.sh` regenerates `script/network/template.sub` from `template.sub.ori`, substituting `queue`, `ncores` and `walltime`. It never passes `memory`, so children get the partition's default memory. It also passes no `--account` and no `--job-name`. Check `sacct` for all three.
- E5 needs a request the partition can satisfy but not right now; tune `E5_SBATCH` using `reports/sinfo.txt`. If `sbatch` rejects the request, that rejection is recorded in `meta.json` and is itself a finding.
