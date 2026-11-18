# Advanced Scientific Environment

Basic chat does not depend on this environment. For the complete stage-by-stage scientific setup and readiness procedure, start with the [scientific setup guide](SCIENTIFIC_SETUP.md). This document records the existing runtime configuration and recovery environment; it is not an automated scientific-environment installer. This project includes no study data, example datasets, reference datasets, precomputed results, container images, or VM disks.

## Official Scientific Source

Run from the project root:

```sh
.venv/bin/python scripts/setup_source.py
```

Git and network access are required. The script obtains commit `bed55b3e121de0edf5fd43da683dc59850ff82d3` specified by `signet_inventory.json`, installing only the 138 inventoried code files, configuration and scheduler templates, and license documents. Downloaded Git objects may include upstream data objects, but data is not installed into this project; temporary downloads are cleaned up.

The default installation directory is `.dependencies/official-signet`, which is entirely excluded from version control. Each inventoried file is checked against its SHA-256 hash. A failed check prevents installation, and existing directories are not overwritten. If a local Git repository already contains the commit, use:

```sh
.venv/bin/python scripts/setup_source.py --from-checkout /path/to/official-signet
```

This exports the specified commit and does not use uncommitted changes. Use `--destination` to install into another new directory, then set `SIGNET_SOURCE` in `.env`. The application resolves relative paths from the project root. The standalone source-preparation script uses explicit command arguments and does not load `.env`.

## Where analyses run

All six SIGNET stages run on UCI HPC3 as Slurm jobs, started only from the chat confirmation cards
(see the [HPC3 guide](HPC3_GUIDE.md) and the [step API](SIGNET_STEP_API.md)). The earlier local Docker VM
path, its Stage 5 and Stage 6 execution tools and the Stage 6 comparison workspace have been removed;
the assistant can explain, prepare a card and read step reports, but never runs a step itself.

## Reference-Data Utilities

This utility neither downloads nor supplies data. Explicitly provide your own inputs:

```sh
.venv/bin/python scripts/prepare_genotype_reference.py --help
```

It converts prepared reference files and checks positions and alleles; it does not replace scientific verification of the genome assembly.

## Interruption and Verification Boundaries

Created jobs remain in `runs/`. If a connection is interrupted or status is unknown, query the status before resubmitting the same operation. Program completion, technical verification, and biological validity are distinct states. Report only the state supported by available evidence.

## Terminology

- **Git:** the version-control tool used to obtain the pinned official commit.
- **SHA-256:** the hash used to check source-file contents.
- **Linux:** the operating system required by some scientific tools.
- **R:** the runtime used for official scientific analysis and visualization.
- **PLINK:** a genotype-processing tool.
- **SLURM:** the scheduler managing scientific jobs and resources on HPC3.
- **ParaFly:** the tool used to execute the official parallel analysis commands.
