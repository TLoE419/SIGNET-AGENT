# Using SIGNET Agent on HPC3

For faculty and researchers running SIGNET through the desktop app on UCI HPC3.
Part 1 covers setup and reference data; the analysis stages come in later parts.

## Part 1: Environment and reference data

### 1.1 How it runs

- You sign in with your own HPC3 account (password and Duo).
- Checks and job submission run on the login node. Downloads, conversion and SIGNET steps run as Slurm jobs.
- SIGNET is installed unmodified at commit
  [`bed55b3`](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3)
  and runs in the container provided by Prof. Zhang.

### 1.2 Folder layout

The installation root defaults to `/pub/<account>/signet-agent` (or `~/.local/share/signet-agent`
if `/pub` is not writable). Change it in **HPC3 settings**.

```
<root>/
├── software/<revision>/        SIGNET source, with example/ (simulated data)
├── images/signet-0.0.6.sif     container
├── refdata/
│   ├── ref/                    imputation reference panel (VCF)
│   ├── gmap/                   genetic map
│   ├── gencode.v22.genes.gtf   collapsed GTF used by -t (full GTF kept beside it)
│   ├── clinical.tsv            clinical table used by -a
│   ├── prepared/example/       IMPUTE2 inputs for the example study, summary.json
│   ├── selected.tsv            your own files chosen instead of downloads
│   └── SOURCES.tsv             download record: date, size, checksum, URL
├── runs/<analysis>/            one folder per analysis
└── .signet-agent/steps/        setup logs and state
```

Nothing is overwritten or deleted. A replaced file is kept as `<name>.replaced-<time>`.

### 1.3 Reference data sources

| File | Used by | Source |
|---|---|---|
| ref | `-g` | [1000 Genomes](https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/release/20181203_biallelic_SNV/) GRCh38, chr1, phased biallelic SNVs |
| gmap | `-g` | [SHAPEIT4](https://github.com/odelaneau/shapeit4/tree/master/maps) GRCh38 genetic map, chr1 |
| GTF | `-t` | [GENCODE v22](https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_22/), collapsed to one record per gene with GTEx `collapse_annotation.py` |
| clinical | `-a` | [GDC API](https://api.gdc.cancer.gov/), TCGA-LUAD: `submitter_id`, `race`, `sex_at_birth` (saved as `gender`) |

- Only chromosome 1 is prepared, matching the example study.
- ref, gmap and GTF use GRCh38. Study genotypes must use the same build.
- Clinical values are kept as GDC provides them. The download log counts each value, including blanks.
- You can choose your own file on HPC3 for any row instead of downloading it.

### 1.4 Checks

| When | Checked |
|---|---|
| Check environment (HPC3 settings) | Root writable, Slurm and Apptainer available, SIGNET files match their checksums, container runs |
| Workflow panel | Each item exists; clinical header has the three columns; conversion matches the current ref and gmap |
| Install SIGNET | Only audited files, published after every checksum matches |
| Container download | Size and checksum match |
| GTF download | Gene rows have `transcript_type` (otherwise `-t` finds 0 genes) |
| Clinical download | Has `submitter_id`, `race`, `gender`, or nothing is saved |
| Choosing a file | Readable from compute nodes and the container; format fits its role |

Accepted formats: ref as VCF or IMPUTE2 `.gen`; gmap as `pos chr cM` or IMPUTE2 `position rate cM`;
GTF uncompressed and collapsed; clinical tab-separated with the three columns.

Checks never read case rows; at most the clinical header.

### 1.5 ref/gmap conversion

**轉檔** prepares IMPUTE2 inputs for the example study in one Slurm job:

1. Keep only reference positions that are also in the study, with matching alleles.
2. Convert VCF genotypes to `.gen` probabilities (`0/0` → `1 0 0`, `0/1` → `0 1 0`, `1/1` → `0 0 1`).
3. Write a copy of the study `ped`/`map` with the kept markers. The original is unchanged.
4. Convert the genetic map to IMPUTE2 format (rate = cM per Mb to the next position).

Restricting the reference to study markers matches SIGNET, which runs IMPUTE2 with
`-include_snps empty`: it fills missing genotypes at existing markers and adds no new ones.

`summary.json` reports counts only: `match_rate`, and `rejected` reasons (`not_in_reference`,
`allele_mismatch`, `not_biallelic_snv`, `duplicate_position`). A rate below 20% triggers a
warning, usually meaning different genome builds.

If ref, gmap or the study changes, the panel marks the conversion as outdated and 轉檔 runs it again.

### 1.6 Left to the researcher

- **Genome build**: not detected directly; a low match rate is the signal.
- **Strand**: opposite-strand markers are dropped, not flipped. A/T and C/G markers are kept as is.
- **Clinical values**: the downloaded table keeps GDC's values. SIGNET itself maps race `not reported`
  to `white`, drops `american indian or alaska native`, and stops unless exactly asian,
  black or african american, and white remain. The `-a` card counts each value for the matched
  patients and asks how to treat any other race value (such as `Unknown`, 5 patients in the
  example): as `not reported`, or excluded. The choice is applied to a copy in the run's folder
  and recorded with the step.
- **Content errors**: reported by SIGNET or IMPUTE2 when the step runs.
