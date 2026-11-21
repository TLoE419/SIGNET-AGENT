# Reference Data: Sources and Processing

This note explains where every input of the TCGA workflow comes from and what the app does to it
before SIGNET runs. All files live on HPC3 under `<root>/refdata/` (default root
`/pub/<account>/signet-agent`). Nothing is bundled in this repository.

## 1. What we use

| Item | Used by | Source | Version / scope |
|---|---|---|---|
| Study data | all steps | `example/` folder of the official SIGNET repo, commit [`bed55b3`](https://github.com/signet4grn/SIGNET/tree/bed55b3e121de0edf5fd43da683dc59850ff82d3) | Simulated TCGA-LUAD-format data, chromosome 1 |
| Container | all steps | `signet-0.0.6.sif` provided by Prof. Zhang (Google Drive) | Checked by size and SHA-256 |
| `ref` (imputation reference panel) | `-g` | [1000 Genomes](https://ftp.1000genomes.ebi.ac.uk/vol1/ftp/data_collections/1000_genomes_project/release/20181203_biallelic_SNV/) `ALL.chr1.shapeit2_integrated_v1a.GRCh38.20181129.phased.vcf.gz` | GRCh38, chr1, phased biallelic SNVs (~950 MB) |
| `gmap` (genetic map) | `-g` | [SHAPEIT4](https://github.com/odelaneau/shapeit4/tree/master/maps) `genetic_maps.b38.tar.gz`, file `chr1.b38.gmap.gz` | GRCh38, chr1 |
| `gtf` (gene annotation) | `-t` | [GENCODE release 22](https://ftp.ebi.ac.uk/pub/databases/gencode/Gencode_human/release_22/) `gencode.v22.annotation.gtf.gz` | v22, because TCGA expression uses v22 gene IDs |
| `clinical` | `-a` | [GDC API](https://api.gdc.cancer.gov/), project TCGA-LUAD, fields `submitter_id`, `demographic.race`, `demographic.sex_at_birth` | Open-access fields only |

Why these choices:

- **Chromosome 1 only**, because the example study covers only chromosome 1.
- **GRCh38 for ref, gmap and GTF.** The study genotypes must use the same build.
- The SIGNET repo does not ship ref, gmap, GTF or clinical data and records no download source,
  so we picked public sources that match the format SIGNET's scripts expect.

## 2. How each file is processed

Every download runs as a Slurm job on HPC3. Each one is logged in `refdata/SOURCES.tsv`
(date, size, SHA-256, URL). Existing files are never overwritten; a replaced file is kept as
`<name>.replaced-<time>`.

### ref and gmap → IMPUTE2 inputs (the **Convert** button)

SIGNET's `-g` runs IMPUTE2, which needs `.gen` reference files and an IMPUTE2-format map.
One Slurm job (`agent/runtime/jobs/prepare_reference.py`) does the following:

1. Keeps only reference positions that also appear in the study, with matching alleles.
2. Converts VCF genotypes to `.gen` probabilities (`0/0` → `1 0 0`, `0/1` → `0 1 0`, `1/1` → `0 0 1`).
3. Writes a copy of the study `ped`/`map` with the kept markers. The original is unchanged.
4. Converts the genetic map to IMPUTE2 format (`position`, rate in cM/Mb, `cM`).

Restricting the reference to study markers matches how SIGNET calls IMPUTE2
(`-include_snps empty`): it fills missing genotypes at existing markers and adds no new markers.

Output: `refdata/prepared/example/` plus `summary.json`, which holds counts only: the match rate
and why markers were dropped (`not_in_reference`, `allele_mismatch`, `not_biallelic_snv`,
`duplicate_position`). A match rate below 20% raises a warning, which usually means a genome-build mismatch.

### gtf → collapsed gene-level GTF

`signet -t` keeps gene rows whose `transcript_type` is `protein_coding`. In the full GENCODE file,
gene rows have no `transcript_type`, so `-t` silently finds **0 genes**. We therefore collapse the
file to one record per gene with the GTEx pipeline's `collapse_annotation.py`
(pinned commit `3218db7`, SHA-256 checked), run inside the SIGNET container.

- Used by `-t`: `refdata/gencode.v22.genes.gtf`
- Full file kept beside it: `refdata/gencode.v22.annotation.gtf`

### clinical → table for `-a`

The GDC download is saved as `refdata/clinical.tsv` with columns `submitter_id`, `race` and
`gender` (renamed from `sex_at_birth`, the column name SIGNET's `adj_adjust.R` reads).
Values are kept exactly as GDC provides them; nothing is recoded at download time.

SIGNET itself maps race `not reported` to `white`, drops `american indian or alaska native`, and stops
unless the remaining values are exactly asian, black or african american, and white. Any other
value is a scientific decision, so the app does not decide it:

- The `-a` confirmation card counts each race value among the patients who have both genotype and
  expression results.
- For any value SIGNET cannot handle (in the example, `Unknown` for 5 patients), the researcher
  chooses **treat as not reported** or **leave these patients out**.
- The choice is applied to a copy in the run folder (`clinical/clinical.signet.tsv`) and recorded
  with the step. `refdata/clinical.tsv` is never edited.

In our example run we chose to leave the `Unknown` patients out.

## 3. Using your own files

Each reference row in the Workflow panel also has **Choose on HPC3**. The chosen path is recorded in
`refdata/selected.tsv` (the file is not copied). The app checks the format from the first lines and
runs a small job to confirm that compute nodes and the container can read it.

Accepted formats: ref as VCF or IMPUTE2 `.gen`; gmap as `pos chr cM` or IMPUTE2 `position rate cM`;
GTF uncompressed and collapsed; clinical tab-separated with the three columns above.

## 4. Checks and privacy

| Check | When |
|---|---|
| Container size and SHA-256 | Container download |
| SIGNET files match the audited checksums | Install and environment check |
| GTF gene rows have `transcript_type` | GTF download, and again before `-t` |
| Clinical header has `submitter_id`, `race`, `gender` | Clinical download, and again before `-a` |
| Conversion matches the current ref, gmap and study | Workflow panel (marked outdated if any changes) |

- Checks read file headers only, never patient rows.
- Person-level results (`-g`, `-t`, `-a`, `-c`) stay on HPC3. Only the gene-level network results
  (`-n`, `-v`) are copied to the local computer.
- The AI assistant sees counts and summaries, not file paths or patient-level data.

## 5. Left to the researcher

- **Genome build** is not detected directly; a low match rate is the signal.
- **Strand:** opposite-strand markers are dropped, not flipped. A/T and C/G markers are kept as is.
- **Clinical values** other than those SIGNET handles (see above).
- Passing these checks shows the files are technically usable, not that the analysis is biologically valid.
