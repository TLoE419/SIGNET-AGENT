# PR #30: control-job-ended cancellation fix

Recorded across 2026-11-09/10 (America/Los_Angeles). This is author-side validation evidence, not an independent review verdict.

## Version and defect

- Before: `bc79eb391c5588c9d49059805b9c00aeb6c6f070`.
- After runtime source: `855b8d1abe53809c84ae9b5ada99b97895665f22`.
- `agent/runtime/signet_jobs.py` SHA-256: `b95934b053fba1b85e569e3a74d97087cc3a9a99d72c83bbd06a35409bc12554`.

The previous independent review found that `POST .../network/cancel` only persisted cancellation intent if the control job still appeared in the queue. In the `not_queued` branch it could report `cancelled` and allow settings changes while children were still `COMPLETING`.

The correction retains cancellation intent for a step with child jobs even when the parent already left the queue. Status polling also checks child quiescence independently of an earlier cancel request. A successful queue check is required before publishing a terminal state or releasing the run lock:

- cancelled parent / explicit cancellation: keep `cancelling` while relevant jobs remain or the queue check fails;
- completed or failed parent: keep `validating` while its children drain, then preserve the actual completed/failed outcome;
- no remote result download occurs while child quiescence is unconfirmed.

The existing job-name and child-working-directory checks still limit which jobs may be cancelled. An unrelated run's jobs do not block this run or get cancelled.

## Regression checks

Three new test functions cover:

1. cancellation after a network parent already left the queue: child cancellation, no `finished_at`, settings/retry refused, release only after child termination;
2. direct status polling with cancelled, failed and completed parents, plus unsuccessful queue lookups: stay active until confirmed quiescent, then preserve the parent's actual outcome;
3. the real HTTP route and persistent record: cancellation returns active state, settings/retry each return 409, then settings return 200 after children stop.

The tests first failed on the before version (five failing assertions across the three functions/subtests). After the fix, **374 Python tests, 116 Electron tests, and four renderer logic checks passed**. These offline service tests run the real login-node scripts against isolated fake Slurm/filesystem boundaries; the HTTP test uses a real local server. They are separate from real HPC3 evidence below.

```sh
SIGNET_SOURCE=<audited-source> python -m unittest discover -s tests -v
SIGNET_PYTHON=<project-python> SIGNET_SOURCE=<audited-source> npm test --prefix electron
node tests/test_markdown.cjs
node tests/test_i18n.cjs
node tests/test_stage6_graph.cjs
node tests/test_chat_progress.cjs
```

## Real HPC3 before/after

Separate pinned-before and fixed-after ChatServer instances used the existing authenticated desktop broker, partition `standard`, and unique new test run directories. Each case submitted two tiny real Slurm jobs (1 CPU, 1 GiB, five-minute limit). The child had a delayed termination handler to make its cleanup window observable. A controlled local network step record and official-format child submit log identified these jobs; **no scientific network calculation, existing analysis, or original input was changed**.

Steps: wait until both jobs are running, cancel the parent through Slurm, confirm the parent terminal, then call either the actual cancellation endpoint or just status refresh. While the child is still running/completing, check the response plus settings/retry behavior. After both jobs stop, refresh and check settings are released.

| Case | Parent, child jobs | API state while child active | Settings HTTP during → after |
| --- | --- | --- | --- |
| before_cancel | 59419411, 59419412 | `cancelled` | 200 → 200 |
| after_cancel | 59419414, 59419415 | `cancelling` | 409 → 200 |
| after_poll | 59419422, 59419423 | `cancelling` | 409 → 200 |

- Before: actual API returned `cancelled` while the real child was still `COMPLETING`; settings were accepted (200). This reproduced the reviewed defect.
- After cancellation: API stayed `cancelling`; settings and retry each returned 409. Only after both jobs were absent from the queue did it become `cancelled` and accept settings (200).
- After direct polling: without first calling the cancellation endpoint, status also stayed `cancelling` while the child drained, with settings/retry each 409; after termination settings were accepted.
- All six jobs were independently checked in `sacct` and confirmed cancelled, with no queued test jobs left.

Raw request/response and scheduler events, before/after logs, code hashes and regression logs are retained locally by the operator. Broker credentials and individual analysis data are not included in this document.

## Scope

This verifies the P2 lifecycle invariant on actual HPC3 service/queue interactions. Failed/completed parent outcomes and queue-query failure are additionally covered by deterministic offline regressions. It does not rerun `-g/-t/-a`, scientific `-c/-n`, full-genome data, biological validation, or production scheduler-policy rejection. Previous whole-chain evidence remains separately recorded in `pr30-retry-safety-20261109.md`.
