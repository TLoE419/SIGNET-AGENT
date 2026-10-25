# Advanced Scientific Environment

Basic chat does not depend on this environment. This document describes the existing code's environment requirements; it is not an automated scientific-environment installer. This project includes no study data, example datasets, reference datasets, precomputed results, container images, or VM disks.

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

## User-Supplied Data

Create `data/` yourself for inputs. Tools accept only permitted files inside this project's `data/` and `runs/`. Some official scripts do not safely handle spaces or special characters, so input paths are restricted to English letters, digits, underscores, dots, slashes, and hyphens. Place the project at a path that meets these restrictions.

Preparing source does not complete the scientific environment. Local Linux preprocessing still requires each tool's R packages, PLINK, imputation tools, and other dependencies. Tools check dependencies and prerequisite outputs. Refer to the pinned [official source](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3). This project does not guarantee that all six stages can run end to end.

## Existing Local VM Interface

Stage 4 uses this VM on macOS. The Stage 5 and Stage 6 execution entry points also use this connection. Other local tools remain subject to platform and dependency checks.

| Setting | Default or requirement |
|---|---|
| `SIGNET_RUNTIME_PROJECT` | Host directory `.dependencies/scientific-runtime`; prepare the assets yourself |
| `SIGNET_SSH_PORT` | Local port `2226`; connects only to `127.0.0.1` |
| SSH user | `root` in the existing VM, for local use only |
| SSH key | `vm/id_ed25519` under the runtime directory, managed by the user |
| Host verification | `vm/known_hosts`; strict host-key verification is retained and cannot be bypassed |
| `SIGNET_CONTAINER_IMAGE` | `/work/evidence/signet-0.0.6.sif` inside the VM; an existing usable image is required |
| Stage 5 | SLURM's `local` partition, 4 cores and 4 GB, required R packages, and ParaFly |
| Stage 6 | Required R visualization packages and any online annotation services used |

See `.env.example` in the project root for settings. Do not commit private keys, host credentials, disks, or images. Missing environments are reported as unavailable; they are not automatically started or rebuilt.

`scripts/advanced/start_scientific_vm.sh` is only for the existing Apple Silicon recovery environment. It requires the existing `signet-qemu:20261006` image, original container, `vm/signet.qcow2`, and `vm/seed.img`. It uses single-threaded emulation and an overlay disk; it is not an installer for new users. Before using it, explicitly set `SIGNET_RUNTIME_PROJECT` and optionally `SIGNET_SSH_PORT` in the current shell. This shell script does not read `.env`. If the recovery container already exists, the script only starts it; it does not reapply port or mount changes. Check the existing container configuration yourself first.

The Stage 5 result verifier is bundled at `scripts/advanced/verify_network.cjs` and no longer depends on another desktop project. It checks scheduler jobs, the command-completion list, matrices, and resampling averages. Node.js 20 or later is required.

## Reference-Data Utilities

These utilities neither download nor supply data. Explicitly provide your own inputs:

```sh
.venv/bin/python scripts/prepare_genotype_reference.py --help
.venv/bin/python scripts/check_genotype_example.py --help
```

The first converts prepared reference files and checks positions and alleles; it does not replace scientific verification of the genome assembly. The second runs the pinned source entry point inside an existing VM.

## Interruption and Verification Boundaries

Created jobs remain in `runs/`. If a connection is interrupted or status is unknown, query the status before resubmitting the same operation. Program completion, technical verification, and biological validity are distinct states. Report only the state supported by available evidence.

## Terminology

- **Git:** the version-control tool used to obtain the pinned official commit.
- **SHA-256:** the hash used to check source-file contents.
- **Linux:** the operating system required by some scientific tools.
- **R:** the runtime used for official scientific analysis and visualization.
- **PLINK:** a genotype-processing tool.
- **SSH:** the protocol used to connect to the local VM.
- **root:** the administrator account used by this existing VM.
- **SLURM:** the scheduler managing scientific jobs and resources.
- **ParaFly:** the tool used to execute the official parallel analysis commands.
- **shell:** the command-line environment running the advanced startup script.
- **Node.js:** the runtime used by the result verifier.
