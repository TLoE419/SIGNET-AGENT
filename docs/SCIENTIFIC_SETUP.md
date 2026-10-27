# Scientific Analysis Environment Setup

This guide describes the scientific setup and the six-stage SIGNET workflow supported by this repository. It is for users who want to run a TCGA analysis; GTEx has a different input and dependency set, described below.

## Read This Before Installing

The current repository does **not** provide a fully reproducible, from-zero scientific environment installation. It can install the audited SIGNET source and check individual tool prerequisites, but it does not build or download the Linux VM, VM disk, container image, or study/reference data. The VM startup script only starts a pre-existing recovery environment.

There is also a host/runtime split:

- Stages 1–3 run local commands and require Linux plus the scientific command-line tools and language packages listed below. They are not supported directly on macOS or native Windows by these entry points.
- Stages 4–6 use the existing local Linux VM on macOS. That VM must already contain the required runtime and the pinned SIGNET image.
- The repository has no supported end-to-end VM provisioning procedure that joins these requirements into a clean-machine install.

So a clean download is enough to run the chat demo, but **not** enough to complete a scientific analysis. Do not begin a real cohort run until you have independently provisioned both supported execution environments, obtained data you are authorized to use, and passed the preflight checks. A successful preflight or program exit is technical evidence only; it does not establish scientific validity.

## 1. Install the Chat Application and Audited SIGNET Source

First follow [Install from Scratch](INSTALL.md) to install Python and configure a model provider. The provider is used for chat; it is not a scientific dependency.

From the project root, install the exact upstream commit recorded in `signet_inventory.json`:

```sh
.venv/bin/python scripts/setup_source.py
```

The script requires Git and network access. It installs only inventoried code, configuration and scheduler templates, and license files into `.dependencies/official-signet`. It checks SHA-256 hashes and does not install datasets. Existing destinations are never overwritten. To verify the installation, inspect the chat tool catalog and confirm it reports the same source revision as `signet_inventory.json`.

## 2. Prepare the Execution Environments

### Linux host for Stages 1–3

Run the application and these stages on a Linux host. The entry points require Bash and the GNU userland tools `getopt`, `sed`, `readlink`, and coreutils. They check the stage-specific programs before execution.

Install the dependencies for the cohort and stages you plan to run. The repository does not pin or install these scientific packages for you:

| Stage | TCGA command dependencies checked by this project | GTEx command dependencies checked by this project |
|---|---|---|
| 1. Genotype QC/preparation | `bash`, `Rscript`, Perl, PLINK, impute2, ParaFly | `bash`, `Rscript`, bcftools, tabix, PLINK |
| 2. Expression preparation | `bash`, `Rscript` | `bash`, `Rscript`, Python 3, bgzip, tabix; Python modules numpy, pandas, scipy, feather |
| 3. PCA/covariate adjustment | `bash`, `Rscript`, Perl, ParaFly, `smartpca.perl` | `bash`, `Rscript`, PLINK, `smartpca.perl`, Python 3; Python modules numpy, pandas, statsmodels |

The pinned scripts also load R packages not listed by the command preflight. The inspected source uses `data.table`, `dplyr`, `DESeq2`, `GenomicRanges`, `plyr`, `ggplot2`, and `Rgb` across TCGA preparation; GTEx paths use `dplyr`, `data.table`, and `rtracklayer`. Network scripts use `MASS`, `parcor`, `matrixcalc`, `chron`, and `dataPreparation` in addition to `data.table`. Visualization scripts load `igraph`, `dnet`, `visNetwork`, `STRINGdb`, `TFutils`, `shiny`, `shinyfullscreen`, `shinycustomloader`, `shinydashboard`, `plotly`, `DT`, `circlize`, `ggthemes`, and `fmsb`. This is a source-derived inventory, not a verified install recipe: some packages are stage-specific or legacy/interactive-only, and compatible versions must be resolved for your R version.

For Stage 4, the VM preflight checks Singularity, R, Bash, ParaFly, `getopt`, and the R package `data.table`. Stage 5 checks `MASS`, `data.table`, `dataPreparation`, `parcor`, `matrixcalc`, and `chron` inside the image. Stage 6 checks `igraph`, `dnet`, `visNetwork`, `STRINGdb`, `TFutils`, `shiny`, `shinyfullscreen`, `shinycustomloader`, `shinydashboard`, `plotly`, `DT`, `circlize`, `ggthemes`, and `fmsb`. A successful SSH connection alone does not prove these stage-specific dependencies are present.

Use the installation instructions and licenses from the maintainers of each program and the pinned [official SIGNET source](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3). Versions and R package requirements vary by upstream stage; this repository does not define a complete environment lockfile. Before using a real cohort, record the OS, package versions, and installation sources in your own run notes.

### Existing Linux VM for Stages 4–6

In browser mode on macOS, the application host needs an SSH client and connects to an already running VM on `127.0.0.1:2226` by default. The runtime directory defaults to `.dependencies/scientific-runtime` and must contain the user's VM SSH key and strict `known_hosts` file. In Electron mode, use the desktop SSH control to select the host, port, username and encrypted key; Electron owns that connection and the Python runtime uses it through a private local broker. Inside the selected remote environment, the configured image must exist at `/work/evidence/signet-0.0.6.sif` unless `SIGNET_CONTAINER_IMAGE` is changed. The remote host needs `timeout`, Singularity, and the existing SLURM local partition. Stage 5 also checks for `scontrol`, `sinfo`, Python 3, `setsid`, at least four idle cores, and 4 GB available memory. The image must provide Linux, Bash, R, ParaFly, and the R packages required by the pinned scripts.

Stage 5 submits to the VM's local SLURM partition. Stage 6 runs the official exports there and contacts online STRING annotation services. Stage 5 has fixed runtime settings in the current execution entry point: 4 cores, 4 GB memory, one hour, and three markers per gene. The Stage 5 and Stage 6 prepare tools only create plans; they do not execute the analysis.

Set optional paths and ports in a private `.env` based on `.env.example`. Paths in `SIGNET_RUNTIME_PROJECT` are host paths; `SIGNET_CONTAINER_IMAGE` is a path **inside** the VM. Do not commit `.env`, SSH keys, host-key files, VM disks, or container images.

The `scripts/advanced/start_scientific_vm.sh` script is a recovery helper, not a VM installer. It expects existing containers and disk/seed assets named in [Advanced Environment Requirements](ADVANCED.md); it cannot create those prerequisites from a fresh download. Do not run it against an existing analysis runtime unless you have checked which disk and container it will use.

## 3. Obtain and Stage Your Own Data

This repository intentionally contains no study cohort, reference panel, genetic map, expression data, clinical/phenotype file, annotation, or example analysis result. Obtain inputs from the relevant data custodian and confirm access, consent, usage terms, genome assembly, and provenance before using them. Do not put restricted data in GitHub or a public issue.

Create `data/` in the project root and organize each study in its own folder. Input paths must be inside `data/` or `runs/`, and may contain only letters, digits, underscores, dots, slashes, and hyphens. Keep source files immutable and record checksums and metadata separately.

For TCGA, the current wrappers expect:

- Stage 1: `.ped` and `.map` study genotypes; reference `.gen` and `.sample` files by chromosome; and genetic-map `.map` files by chromosome. The wrapper checks for the chromosome files represented by your configured chromosome count.
- Stage 2: the cohort expression input and a compatible gene annotation GTF.
- Stage 3: a cohort clinical/covariate file, plus the genotype and expression intermediates produced by earlier stages.
- Stage 4: matched expression, expression-with-PC, genotype, SNP map, SNP MAF, and ordered gene-position files. These should be produced from aligned samples and matched earlier-stage outputs.
- Stage 5: Stage 4 significant-pair results and matching expression, genotype, gene-name, and gene-position files.
- Stage 6: aligned frequency and coefficient matrices plus ordered gene positions from the network analysis.

GTEx uses a different set of VCF, read-count, tissue, annotation, TPM, and phenotype inputs. Use the explicit `genotype_gtex`, `expression_gtex`, and `adjust_gtex` tool descriptions rather than renaming TCGA files to fit those inputs.

Before running a stage, inspect the source data headers, sample IDs, genome build, chromosome naming, allele orientation, and row ordering. A file existing at the expected path is not evidence that it is scientifically compatible. The wrappers enforce path and prerequisite checks, but they do not establish that datasets are biologically compatible.

## 4. Run the Stages in Order

Use the local chat assistant to inspect the catalog and ask what inputs a stage requires. The assistant exposes fixed tools; it does not accept arbitrary shell commands. Start each independent analysis with a new run ID and cohort configuration. Each run is isolated under `runs/<run-id>/`; attempted stages cannot be replayed in place.

1. **Stage 1 — genotype preparation.** For TCGA, provide the study `.ped`/`.map`, reference-panel chromosome files, and genetic maps. For GTEx, provide its VCF, reads, annotation, and tissue inputs. Check logs, QC outputs, sample counts, marker counts, and allele/assembly assumptions before proceeding.
2. **Stage 2 — expression preparation.** Provide the cohort expression input and compatible annotation. GTEx also needs its reads, TPM, tissue, and Stage 1 intermediates. Verify sample IDs and gene mapping.
3. **Stage 3 — PCA and covariates.** Provide the TCGA clinical file or GTEx phenotype/annotation files. Inspect PCA plots and choose the number of components based on the study design; do not copy a default without review. Confirm the resulting samples and covariates match the expression and genotype data.
4. **Stage 4 — cis-eQTL.** Provide aligned genotype/expression inputs and SNP/gene metadata. On macOS this calls the existing VM. Confirm the VM preflight succeeds before starting; an unavailable connection means the analysis did not start. Review outputs and logs before using significant pairs.
5. **Stage 5 — network inference.** First use `prepare_network` to inspect the plan; it does not submit jobs. When prerequisites and parameters are independently reviewed, `submit_network` sends work to the existing local SLURM runtime. Query status after submission; if status is unknown, do not resubmit the same run.
6. **Stage 6 — visualization.** First use `prepare_visualization` to inspect the plan; it does not execute or create a persistent Shiny service. `run_visualization` runs exports in the existing VM and may need online STRING annotation. Verify the exported matrices/plots and their alignment before using the chat visualization.

The exact file names and parameters depend on the pinned upstream config and your cohort. Inspect the generated `runs/<run-id>/work/config.ini`, stage records, and logs. Do not edit the audited source copy under `.dependencies/official-signet`; the application copies it into each isolated run.

## 5. Verify, Record, and Stop Safely

- Verify source revision and hashes, runtime software versions, input checksums, sample/marker counts, configuration, and the stage's required outputs.
- Keep each stage record and its standard-output/error logs with the private run data. `process_completed` means the process returned successfully, not that the scientific result is valid.
- If a VM connection or output transfer is interrupted, inspect the recorded status and remote run before retrying. Never replay an operation with unknown status or overwrite a run; use a new run only after determining the prior run's state.
- Preserve source data and intermediate outputs. Do not delete or regenerate them to clear an error until the run status and disk/container ownership are understood.
- Apply the study's scientific protocol and an independent review to QC thresholds, genome build, cohort selection, covariates, model parameters, and interpretation.

## What This Repository Still Cannot Install for You

From a new download, you can install the chat application and prepare the hash-audited official source. You cannot use this repository alone to create the required Linux scientific host, provision the existing VM, produce or obtain the `signet-0.0.6.sif` image, or obtain authorized cohort/reference data. Until a separately documented provisioning procedure and an end-to-end clean-machine validation exist, this guide is a setup and readiness procedure, not a promise that a public clone can run a complete analysis by itself.

See [Advanced Environment Requirements](ADVANCED.md) for runtime configuration and recovery-environment details, and [No-Data Demonstration](DEMO.md) for the chat-only demonstration.
