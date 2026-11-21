# Workspace items 13–24 integration

Local integration branch: `codex/signet-workspace-ui`.
Baseline: `d93d1e49757a064733cbb55d798441530d7ff697`.
Backup: `codex/before-parallel-integration-d93d1e4`.

## Integrated scope

| Item | Implemented behavior | Integration commits |
| --- | --- | --- |
| 13 | Reviewed uncertain-submission recovery, non-replayable ambiguous receipts, confirmed owned-job adoption and atomic missing-marker repair | `9f1fa85`, `099b86f`, `788d1ad` |
| 14 | Reviewed new linked runs, compatible upstream reuse, separate manual submission, fresh failed genotype-fork retry namespace | `333db31`, `b8a4beb` |
| 15 | Secure Gemini settings and current model, visible from either Settings or the composer | `9271b37`, `493cd61` |
| 16 | Agent reads and proposes the same reviewed stage services; no model scientific submission/cancel/retry tools | `8d3c79b`, `4166499` |
| 17 | Validated per-request dataset/run/stage/gene context in the actual workspace composer | `6290639`, `4166499` |
| 18 | Structured source-bound chat navigation into stage and linked gene/table selections | `b470e64`, `4166499` |
| 19 | Durable per-tool public activity, timings and honest tool outcomes | `ff55a6e`, `4166499` |
| 20 | Failed/needs-review chat outcomes with partial responses and saved replay | `2da708d`, `4166499` |
| 21 | Saved stage summaries and bounded PCA/network thumbnails bound to selected source/run/revision | `972d10d`, `16a3c96` |
| 22 | Network node dragging, panning, zoom and numerical edge inspection | `3ea0313` |
| 23 | Working model toolbar entry, removed unsupported decorative controls | `4873ed6` |
| 24 | Explicit advanced terminal entry using the existing trusted broker and lifecycle | `eb610c4` |

## Integration corrections

- Kept both rerun and submission-recovery history controls and delegated handlers.
- Separated the toolbar button ID from the model-settings React mount. Portalled
  the existing modal into the document body so hidden Settings cannot hide a
  dialog opened from Analysis; reused existing dialog action/close styling.
- Connected workspace chat context, overall status and proposal navigation to
  the actual workspace transport, rather than only the legacy chat renderer.
- Preserved blocking after ambiguous scheduler-client failures. An empty queue
  or accounting result is not proof that submission never happened. Confirmed
  adoption atomically repairs only a missing, owned exact-job marker; stale or
  conflicting evidence remains unresolved and cannot replay.
- Serialized upstream reuse against source-run changes and preserved fresh
  attempt directories for a failed linked Stage 1 run. Originals remain intact.
- Replaced raw parameter JSON editing with labelled stage/resource fields and
  read-only retained input identities, without changing pane geometry.
- Updated obsolete provider and log fixtures to the restricted model tools and
  conservative unknown-submission contract. Unknown attempts cannot read generic
  remote logs without attributable job evidence; saved local errors and previous
  attributable attempts remain available.

## Validation

- `npm test --prefix electron`: build, TypeScript and **263 desktop checks passed**
  (145 Node renderer/controller checks, 58 typed runtime checks, 60 React checks).
  Includes eight cross-item workspace/chat/model/terminal integration checks.
- Native Electron acceptance passed for workspace, archived workspace, scoped
  history, all-six-stage timeline, custom dataset, genotype retry, cancellation,
  execution logs, output revalidation, and the new parallel-feature acceptance
  harness (**10 suites**). Each uses a separate temporary profile and fixtures.
- `git diff --check`: passed.
- Complete backend discovery: **565 tests passed** in 158.903 seconds. Includes
  submission recovery/adoption, linked reruns, all stage services, source/attempt
  isolation, validated workspace chat context/navigation/activity/outcomes,
  providers, existing legacy runtime behavior and model-dispatch blocking.

Reproduction:

```sh
SIGNET_SOURCE="$PWD/.dependencies/official-signet" PYTHONPATH=tests \
  .venv/bin/python -m unittest discover -s tests -p 'test_*.py' -q
npm test --prefix electron
# Run native suites individually with the installed Electron executable.
electron/node_modules/.bin/electron electron/tests/parallel-native.cjs
electron/node_modules/.bin/electron electron/tests/stage-timeline.cjs
```

The integrated desktop was reopened from this checkout, and its backend working
folder was independently confirmed as `/private/tmp/signet-workspace-ui`.
The existing selected run and conversation remain present. The composer model
button opens the visible settings dialog; cancelling leaves the saved key and
provider unchanged. Remote compute remains disconnected.

Initial integration failures were fixed rather than ignored: stale 33-tool
provider expectations, synthetic adoption-route proof, old ambiguous-submission
log attribution, and legacy model-dispatch execution expectations. Trusted
legacy runtime coverage now calls retained Python functions directly while new
assertions prove the model dispatcher cannot execute those paths. The native
cancellation fixture now owns its explicit simulated connection context even
when history/log mounts request current context; real disconnection guards and
all exact-target/attempt/cancel assertions remain active.

All execution fixtures use isolated local temporary data, fake schedulers and
mock model responses. No real SSH/HPC connection, Slurm submission/cancellation,
model-key validation, paid model request, scientific rerun or installation was
performed. These tests establish software behavior, not biological validity.

The actual dataset/run metadata and configuration baseline covers 28 files.
SHA-256 comparison after testing: zero changed, added or removed files.

Geometry remains 1650 × 894, with a 53 px navigation rail and 542 px left pane.
Native fixtures check the actual rendered dimensions, English/Traditional Chinese
model dialog visibility, stage history restoration and linked gene filtering.
