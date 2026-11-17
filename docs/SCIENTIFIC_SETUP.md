# Scientific Analysis Environment Setup

This guide describes the scientific setup and the six-stage SIGNET workflow supported by this repository. It is for users who want to run a TCGA analysis; GTEx has a different input and dependency set, described below.

## Read This Before Installing

The app runs SIGNET on UCI HPC3 with your own account. Electron signs in over SSH, and the Workflow panel installs the audited SIGNET source, the official container and the chromosome 1 reference data there (see the [HPC3 guide](HPC3_GUIDE.md)). All six stages then run as Slurm jobs from the chat confirmation cards; nothing scientific runs on this computer. The app does not install HPC3's container runtime or scheduler, and it supplies no study data.

With an HPC3 account, a clean download can run the official example study end to end. Do not begin a real cohort run until you have data you are authorized to use and the environment check passes. A successful preflight or program exit is technical evidence only; it does not establish scientific validity.

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

On HPC3 these packages come from the SIGNET container (`signet-0.0.6.sif`); the environment check runs it before any analysis.

Use the installation instructions and licenses from the maintainers of each program and the pinned [official SIGNET source](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3). Versions and R package requirements vary by upstream stage; this repository does not define a complete environment lockfile. Before using a real cohort, record the OS, package versions, and installation sources in your own run notes.

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

GTEx uses a different set of VCF, read-count, tissue, annotation, TPM, and phenotype inputs. The HPC3 workflow supports TCGA only; do not rename TCGA files to fit GTEx inputs.

Before running a stage, inspect the source data headers, sample IDs, genome build, chromosome naming, allele orientation, and row ordering. A file existing at the expected path is not evidence that it is scientifically compatible. The wrappers enforce path and prerequisite checks, but they do not establish that datasets are biologically compatible.

## 4. Run the Stages in Order

Use the local chat assistant to inspect the catalog and ask what inputs a stage requires. The assistant exposes fixed tools; it does not accept arbitrary shell commands. Start each independent analysis with a new run ID and cohort configuration. Each run is isolated under `runs/<run-id>/`; attempted stages cannot be replayed in place.

All six stages run on HPC3 from the chat confirmation cards (see [HPC3 guide](HPC3_GUIDE.md)); there are no local tools for them. After a stage completes, the next card appears.

1. **Stage 1 — genotype preparation.** Provide the study `.ped`/`.map`, reference-panel chromosome files, and genetic maps. Check logs, QC outputs, sample counts, marker counts, and allele/assembly assumptions before proceeding.
2. **Stage 2 — expression preparation.** Provide the cohort expression input and compatible annotation. Verify sample IDs and gene mapping.
3. **Stage 3 — PCA and covariates.** Provide the TCGA clinical file. Choose the number of components based on the study design; do not copy a default without review. Confirm the resulting samples and covariates match the expression and genotype data.
4. **Stage 4 — cis-eQTL.** Uses the outputs of stages 1–3. Review the significant pairs before continuing.
5. **Stage 5 — network inference.** Choose bootstrap count and the size of SIGNET's own Slurm jobs on the card. If a status is unknown, do not resubmit; check the card first.
6. **Stage 6 — visualization.** Exports the network, edge list and SIGNET's plots (PNG copies are shown on the results card). It uses online STRING annotation and does not start the Shiny dashboard.

The exact file names and parameters depend on the pinned upstream config and your cohort. Inspect the generated `runs/<run-id>/work/config.ini`, stage records, and logs. Do not edit the audited source copy under `.dependencies/official-signet`; the application copies it into each isolated run.

## 5. Verify, Record, and Stop Safely

- Verify source revision and hashes, runtime software versions, input checksums, sample/marker counts, configuration, and the stage's required outputs.
- Keep each stage record and its standard-output/error logs with the private run data. `process_completed` means the process returned successfully, not that the scientific result is valid.
- If an HPC3 connection or output transfer is interrupted, inspect the recorded status and remote run before retrying. Never replay an operation with unknown status or overwrite a run; use a new run only after determining the prior run's state.
- Preserve source data and intermediate outputs. Do not delete or regenerate them to clear an error until the run status and disk/container ownership are understood.
- Apply the study's scientific protocol and an independent review to QC thresholds, genome build, cohort selection, covariates, model parameters, and interpretation.

## What This Repository Still Cannot Install for You

From a new download, you can install the chat application and prepare the hash-audited official source. You still need an HPC3 account with access to the SIGNET container, and authorized cohort data for your own studies. Until a separately documented provisioning procedure and an end-to-end clean-machine validation exist, this guide is a setup and readiness procedure, not a promise that a public clone can run a complete analysis by itself.

See [Advanced Environment Requirements](ADVANCED.md) for source setup, and [No-Data Demonstration](DEMO.md) for the chat-only demonstration.
