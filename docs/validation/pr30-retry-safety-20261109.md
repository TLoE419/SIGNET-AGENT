# PR #30 retry safety: regression and HPC3 validation

Recorded on 2026-11-09 (America/Los_Angeles). This document records author-side execution evidence; it is not an independent review verdict.

## Version and scope

- PR base: `ab836b98d8b643a80ecf8832ea000fc0a55d052e` (`main`).
- Fix baseline: `ee81e8d39658a0c8f3d006148d01092064a11fd0`.
- Final runtime source: `3da62bbb34d409f474c6a80efb48c89dd3cc5666`.
- Source SHA-256 (`agent/runtime/signet_jobs.py`): `81f7f3c8e647a80ef67de2b1fa7b607ac5a7cd8f2572d226e54eeb84b9cc6ab5`.
- The `-g` submission used the first fix commit `7e59872312c12409cd8a28f5c61780ea0c01d4ec`. While it ran, two retry/recovery edge cases were added and the isolated API was reloaded at the final source revision. All subsequent submissions and completion checks used the final API. AST comparison confirmed `_job_script`, `_submit_script`, and `_status_script` were unchanged; `-g` was not resubmitted.
- Real HPC3, partition `standard`, container `signet-0.0.6.sif`, audited SIGNET source `bed55b3`. Example inputs, chromosome 1. All operations used the actual HTTP service and the desktop-owned authenticated SSH broker.

## Corrected behavior

1. Retry archives only this step's old result folder, remotely and locally, as `steps/<step>.attempt<N>.results`. A successful exit with no fresh outputs cannot reuse the previous result. Earlier steps remain available.
2. `scancel` success means `cancelling`, not confirmed termination. The run remains locked until the control job and its child jobs stop. A retry also checks the real scheduler before uploading configuration, including for legacy `cancelled` records.
3. Explicit refresh can recover exit-0 failures caused only by missing outputs, including delayed accounting. Confirmed nonzero exits, scheduler failures, and observed error log lines remain terminal.
4. A refused submission after preparation consumes its attempt number and retains its script/error. Later retries cannot overwrite previous archives. The last actual job ID is retained across refused submissions so a later lost connection cannot adopt an older job. A successful but malformed submission reply remains `unknown`, not retryable.

## Regression checks

Fourteen new tests (11 service tests, 3 HTTP route tests) cover the above behaviors plus local/remote stale outputs, legacy cancellation records, scheduler outage, immutable archive collisions, network child termination, refused-submission/connection-loss chains, malformed job IDs, and missing-output recovery without accounting.

The tests drive the real login-node scripts against isolated local folders and fake Slurm executables. HTTP tests use a real localhost server with the application's token/Origin/Host checks. They are controlled regression evidence, separate from real HPC3 execution below.

- Before: five initial regression cases reproduced stale result acceptance, premature retry, legacy cancellation overwrite, permanent missing-output failure, and forgotten refused attempts. The additional connection-loss and delayed-accounting cases were also observed failing before their fixes.
- After: **371 Python tests, 116 Electron tests, and 4 renderer logic checks passed**.

Commands (use the project's existing Python environment and audited source):

```sh
SIGNET_SOURCE=<audited-source> python -m unittest discover -s tests -v
SIGNET_PYTHON=<project-python> SIGNET_SOURCE=<audited-source> npm test --prefix electron
node tests/test_markdown.cjs
node tests/test_i18n.cjs
node tests/test_stage6_graph.cjs
node tests/test_chat_progress.cjs
```

## Same-run real HPC3 workflow

Run ID: `pr30_fixed_20261109_215423`, directory `<workRoot>/pr30_fixed_20261109_215423`.

| Step / attempt | Slurm job | API result | Accounting / duration |
| --- | --- | --- | --- |
| `-g` | 59413871 | completed, downloaded | COMPLETED / 28m23s |
| `-t` attempt 1 | 59414752 | cancelled | CANCELLED before allocation |
| `-t` attempt 2 | 59414754 | completed, downloaded | COMPLETED / 42s |
| `-a` original clinical input | 59414777 | failed, known error detected despite exit 0 | COMPLETED / 10s |
| `-a` workflow-fixture retry | 59414790 | completed, downloaded | COMPLETED / 11s |

Observed checks:

- Cancel returned `cancelling`; an immediate retry returned HTTP 409. Only after terminal scheduler confirmation was retry accepted.
- In the newly created validation run, one finished `-t` output was temporarily moved aside before completion validation. The API recorded an exit-0 missing-output failure. Restoring the exact file and refreshing recovered and downloaded results under the same job ID, without resubmission. Hash and modification time were unchanged. **This controlled withholding tests recovery; it does not prove actual filesystem latency.**
- Cancelled `-t` and failed `-a` job files were individually hash-matched against their archives. The failed `-a` result files were also hash-matched under `steps/adjust.attempt1.results` after retry.
- The `-a` retry did not rerun or change the successful `-g` or `-t` outputs.
- All 13 downloaded files matched remote SHA-256 and were written after the successful attempt's submission.
- Matrix checks: genotype 560 x 2,983; expression 554 x 95; matched samples 473; adjusted expression 471 x 95; adjusted genotype 471 x 1,110. Matrices were rectangular and finite, with consistent row counts. The log confirmed `npc=3`.

## Download integrity

| Relative file | Bytes | SHA-256 (local = remote) |
| --- | --- | --- |
| `work/res/resg/signet_Geno` | 3340960 | `ecf084d5019e07c27a5f5f9184fa6ca7bb2f5356ea69b5b1eebf7a0874c26409` |
| `work/res/resg/signet_Genotype.sampleID` | 16240 | `c89786d71d82f639f716067e34ad47482a25de2c51c513a4e61373526de197aa` |
| `work/res/rest/signet_gene_name` | 598 | `d619d224b144b465dafeb3680842f49adf93020a1f55b15ac6bfcc02a7c49aa8` |
| `work/res/rest/signet_gene_pos` | 2859 | `abc46036e955d17f1f774c0a5f3c56a5f04f2d813879da714d51aca88600fb42` |
| `work/res/rest/signet_gexp` | 888923 | `37c00af02876cbbe2ae0ee5d64a2636a3787b0ae342e30c93a42331e8fb05917` |
| `work/res/rest/signet_gexpID` | 9418 | `a38be89624c52c9899f80a065d54bc1727860ae10b58f064575142e606b498c2` |
| `work/res/resa/signet_geno.data` | 1045620 | `534e4f67107cbaa7e9a1ea09d38f2ff597d564a134e197dce2fa12af8549932b` |
| `work/res/resa/signet_gexp.data` | 814527 | `50c6733f067790555a66548cf9eb50004b3ec99e423bbef3bd0acaafe9d21744` |
| `work/res/resa/signet_gexp_rmpc.data` | 814778 | `c37a46f121067f9486bc286c3a554966a80c4cde5042c37c6338e9f4c599a565` |
| `work/res/resa/signet_matched.gexp` | 758906 | `100f101762608a8fa16b16e7c7eec34395ded3a1298b5acaab2791de43c6af95` |
| `work/res/resa/signet_new.Geno` | 1050533 | `0db4d2ac16bf2140f0f405acc52c2fb863793af035a2575ab1ac934d153db2ae` |
| `work/res/resa/signet_new.Geno.maf` | 20925 | `5fd4392b1df1811dd31909e4526f948afca2b8b0a6da9a30756c15cf35be0051` |
| `work/res/resa/signet_new.Geno.map` | 17760 | `fcc650ec57a1bd128a3dbca401362d1dd04e30be6961387c4a87d99b136a97a9` |

## Limits

This establishes engineering workflow behavior on example data, not biological validity or full sample-identity alignment. The successful `-a` retry used a labelled clinical compatibility fixture: source `sex_at_birth` values were copied unchanged into SIGNET's legacy `gender` column; five `Unknown` race values were mapped to `not reported`. The official R script subsequently treats `not reported` as white and assumes three race levels. That is not an approved scientific preprocessing policy. The original clinical input was preserved and its compatibility problem remains unresolved.

The precise scheduler-refusal/archive-overwrite failure and child-job boundary cases were exercised by controlled regression tests, not by forcing production scheduler rejection or overlapping analyses on HPC3. This run did not execute `-c`, `-n`, a chat-model tool-selection flow, or full-genome data. Earlier PR author reports of `-c`/`-n` are separate evidence.

Raw request/response, job/log, hash, timing, and provenance artifacts are retained locally by the operator. Credentials, ownership tokens, individual clinical rows, and analysis matrices are not committed with this report.
