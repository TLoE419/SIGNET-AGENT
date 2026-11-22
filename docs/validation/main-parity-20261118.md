# Workspace parity with main

Compared main `537928f` with new UI baseline `567b99b`, on
`codex/signet-workspace-ui`. The global dataset/run workspace, pane geometry,
manual scientific submission and retained original records remain authoritative.

| Area | Implemented behavior |
| --- | --- |
| Clinical download | Required sex/gender columns, old-column detection, explicit upgrade preserving originals. |
| Input preflight | Collapsed uncompressed GTF validation on every expression submit; adjustment FAM prerequisite. |
| Visualization delay | Clean exit can wait 120 seconds for delayed outputs without resubmitting. |
| Data locality | New Stage 1–4 outputs remain on HPC3; old local archives remain readable. |
| Private views | Counts/histograms, matching/correction aggregates and raster PCA, Stage 4 associations. No sample IDs, matrices or score arrays are transferred. |
| Clinical decisions | Explicit unknown-race choices, review token bound to source/upstream bytes, immutable per-run copy and recoverable conflicts. |
| Preparation | Source-content freshness, explicit shared background installation, progress/logs and 90-second verification deadline. |
| Model reports | Safe counts and recognized failure explanations; personal files, snapshots and raw logs refused. |
| Progress | Measured completed/total work units for all six stages, without elapsed-time estimates. |
| Rerun history | Same-dataset provenance, original/rerun numbers, evidenced latest label and recorded parameter/resource/clinical-choice differences. |
| Original results | Widgets/subnetworks, retained PNG/PDF figures, threshold chart/table, linked table search/sort, scoped PDF/ZIP downloads. Missing exports show unavailable. |

Inherited results resolve the exact source job/attempt rather than assuming a
new child has scheduler markers. Explicit fork staging preserves reused control
evidence for later manual stages. Reading results never submits scientific work.

## Export contract

- Authenticated `GET /signet/history/{history_id}/stage6/assets` takes `identity`
  and optional `revision`; the workspace supplies both.
- Authenticated `POST /signet/history/{history_id}/stage6/assets/download` takes
  `{identity, revision}` for ZIP, plus an exact listed `asset` for a PDF.
- Previews expire after 300 seconds; downloads after 60 seconds and successful
  use. History revision and artifact identity are rechecked on use.
- Only exact listed outputs/dependencies are served. Links, nonregular/changed
  files, traversal and arbitrary filesystem paths are refused.
- Original HTML uses `sandbox="allow-scripts"`, without same-origin privileges,
  desktop bridge, Node or authenticated API access. Electron permits only the
  specific local preview/download routes; parent and meta CSP retain these limits.

## Validation scope

Tests use disposable profiles, fake schedulers, mock providers and local fixture
trees. No real SSH connection, installation, model request, analysis rerun, or
restart of the user's application is performed. Software checks do not establish
scientific validity or human acceptance.

Final verification:

- Complete backend discovery: **655 passed** in 178.586 seconds.
- `npm test --prefix electron`: build, typecheck and **275 desktop checks passed**
  (159 controller/renderer, 56 typed runtime, 60 React checks).
- Native environment, six-stage saved timeline, cross-feature/context actions,
  original result delivery and an actual retained official visNetwork widget all
  passed in disposable profiles. The original widget contained 95 genes and
  731 edges; trusted pointer selection, isolated scripts and dependency loading
  were exercised without running SIGNET again.
- PDF/ZIP completion and one-use replay refusal passed. Missing/expired/changed
  exports, cross-source identities, unsafe dependencies and opaque-frame API
  access are covered by focused regressions.
- Canonical state baseline: **32 files checked, zero changed or missing**.
- `git diff --check`: passed.

Reproduce without real cluster or model calls:

```sh
SIGNET_SOURCE="$PWD/.dependencies/official-signet" PYTHONPATH=tests \
  .venv/bin/python -m unittest discover -s tests -p 'test_*.py' -q
npm test --prefix electron
electron/node_modules/.bin/electron electron/tests/environment.cjs
electron/node_modules/.bin/electron electron/tests/stage-timeline.cjs
electron/node_modules/.bin/electron electron/tests/parallel-native.cjs
electron/node_modules/.bin/electron electron/tests/result-assets-native.cjs
```

Only retained allowlisted exports are exposed. Missing original figures are not
fabricated, and unsafe/nonstandard export filenames remain excluded. The actual
user application was not restarted and no branch push was performed.

Native geometry remains 1650 × 894, navigation 53 px, left pane 542 px, retaining
the graph/table widths and selected MEGF6 connections.
