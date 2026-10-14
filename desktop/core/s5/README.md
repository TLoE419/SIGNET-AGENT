# A5 bounded result-package module — v1

This is a standalone preparation module, not desktop wiring. Base: `6dcffcea0d736a9dbf16d11ad8b45f3c04d57f43`. Only this `core/s5/` directory is new. No main/preload/Service/Store/results/formal/S1–S4 changes. S4's pending independent acceptance is not inherited as product acceptance.

## Public interfaces

`parseNetwork({frequencyText, coefficientText, positionsText, direction, axes})` validates bounded matrix text and returns rectangular shape, positions-linked genes, directed edges, `nboots:null`, `scientificStatus:'unknown'`, `executeEnabled:false`. Direction must be the exact `column/source->row/target` string. `axes` must be null or `{sources,targets}` matching the first p positions and all n positions exactly. A 95×86 pair is supported as 95 targets and the first 86 source positions; no columns/labels/metadata are fabricated.

This implements finite data validation using the existing `results.cjs` contract, not new inference or visualization. The synthetic 95×86 test cross-checks all edges against unchanged `results.network`. It adds explicit safe integer coordinates and optional axis equality beyond that reader. Source evidence: official `bed55b3e121de0edf5fd43da683dc59850ff82d3`, README Afreq/coef/vis.genepos descriptions and `script/netvis/extract_edges.R` target=row/source=column mapping. No R or official script is executed.

`new PackageIndex({stateRoot, roots, resolveSource, attestRun?, now?})` is a **trusted core-only constructor**. These options are not frontend parameters. `roots` is a finite array of `{rootId,path}` selected by the future approved host. `resolveSource(sourceToken)` returns the current grant below or null; there is no default filesystem authority or root search. `attestRun` is absent by default. No remote, shell, generic file-read or R evaluator port exists.

| Public method | Exact argument keys | Result |
| --- | --- | --- |
| inspect | sourceToken | Fresh bounded manifest/file/structure snapshot; no index write |
| register | sourceToken, requestId | Durable immutable package identity and request dedup |
| get | packageId | Fresh revalidated package; stale grants/files refuse |
| select | packageId, packageHash, artifactId | Current permitted artifact metadata, never a path |
| importPlan | packageId, packageHash, requestId | New import-record proposal; never creates a completed run |
| exportPlan | packageId, packageHash, artifactIds, requestId | Selected verified-byte artifact proposal for a future newly authorized destination |

All plans return `overwrite:false`, `preserveOriginal:true`, `actualFilesWritten:false`, `executeEnabled:false`. They write **only** their own bounded plan/index metadata. No input/result/derived/session/export file is written. Plan import is not a native import, download or product-ready analysis. Destination is a fixed type, never a caller path. Import only selects the three network files. Export can select a ready matrix while a declared optional derived artifact is missing; the absent artifact itself cannot be exported.

## Source grant and manifest

Grant exact shape:

```
{rootId, sourceRef:{sourceId,batchId,revision},
 kind:'external'|'synthetic'|'simulated-reference'|'internal',
 complete:boolean, manifest}
```

`complete` is the trusted transfer/source boundary's current completion evidence, not a claim read from a result file. The grant must be re-resolved and equal after asynchronous evidence checks. Root identity, opaque source handle hash and the entire grant are included in the immutable package fingerprint. A changed root mapping cannot replace the source under an old package identity.

Manifest exact shape:

```
{schemaVersion:1, sourceRef, direction, axes:null|{sources,targets},
 claims:null|{status?,jobIds?,nboots?,analysisId?,sourceCommit?,containerSha256?},
 visualization:null|{revision,freq,ntop,networkHashes:{frequency,coefficient,positions},
                     sessionArtifactId,manifestArtifactId},
 artifacts:[{artifactId,role,relativePath,bytes,sha256,sourceRef}]}
```

Every artifact sourceRef must equal both package and grant. Artifact IDs and paths are unique. Roles are finite: `matrix-frequency`, `matrix-coefficient`, `gene-positions`, `derived-json`, `derived-csv`, `derived-html`, `evidence`, `official-session`, `official-edgelist`, `verified-visualization`. Network roles/session/visualization manifest cannot duplicate. Package hash binds the normalized artifact entries, their **actual** bytes/hash or missing state, network hashes, provenance proof and session binding. Display snapshots have a fresh checkedAt outside the immutable content hash. Expected versus actual bytes/hash are separate; missing is not zero-byte verified content.

`claims` are validated but **never** used to grant authority, infer nboots or set scientific success. Fake `COMPLETED`, `verified_actual_run` and job numbers stay claims. Synthetic always stays `synthetic-contract`; official simulated-reference/external data can become `external-structure`, never internal-run by metadata alone. Internal source without a trusted complete proof stays scientifically unknown.

Optional `attestRun({sourceRef,networkHashes,artifactSetHash})` must return null or this exact core attestation:

```
{sourceRef,networkHashes,artifactSetHash,analysisId,attemptId,owner,
 sourceCommit,containerSha256,runManifestHash,verifiedAt,expiresAt,
 checks:['bootstrap-matrices','completed-commands','owned-scheduler','source-and-container'],
 synthetic:false}
```

Proof must match current immutable source/artifact hashes and be fresh (not future, expired or more than one hour wide). The future **accepted trusted provider** must independently read the actual full run/bootstrap/completion/scheduler ownership/source/container evidence; this module does not execute/reimplement `R.verify` or authenticate forged files. A synthetic provider test of this seam proves binding/rejection only, not actual execution. Even a valid trusted attestation says `network-run-verified`, not all stages succeeded or visualization loaded. There is no installed production provider in this module.

## Completeness, sessions and safety

`completeness`, `networkState`, `verification.level`, `scientificStatus` and `visualization.loadState` are separate. Missing declared files or an unfinished transfer produce partial; complete three-file structure does not prove original-run lineage. Missing optional derived files does not erase matrix validation. Changed byte count/hash refuses validation. New grants require a new package/request identity; old records are not overwritten to follow new source versions.

Session/RData bytes are only bounded and hashed. A matching network hash and parameter revision is labelled `hash-bound-untrusted`; loadState stays `not-tested`, with missing trusted generation/load evidence. Even JSON that declares loaded/COMPLETED is opaque evidence data. No RData deserialize/load, R object inspection or automatic official-session preparation is attempted. Source hash mismatch, wrong role/reference or network binding rejects the session proposal. A different freq/ntop/revision changes the manifest/package identity; it cannot silently replace an existing session plan.

Only enumerated grant files are read; no directory search or private runtime scan. Paths are restricted relative segments, bounded length/depth, no absolute/empty/dot/parent/control characters. Roots and ancestors must be real directories, no symlinks. Non-regular files refuse before opening; files use O_NOFOLLOW/O_NONBLOCK, bounded stat-before/open/read/stat-after identity checks, fatal UTF-8 for matrix text and full hash/size verification. All bounded artifacts and grants are checked again after an awaited run-proof callback. Any source mutation/grant drift refuses promotion before index commit. Host must retain control of approved roots against hostile concurrent rename/reparent attacks; this is a Node local-file boundary, not an OS sandbox/openat capability service.

State root must be separate from read roots, never original SIGNET or stage-source clones. State envelope hashes catch accidental corruption, **not malicious-authenticity proof**. Exclusive index.lock prevents competing writers, never steals locks. Updates use exclusive temporary file, fsync/rename/directory fsync; no change means get/select leave index bytes/mtime unchanged. Failed snapshots do not create an index. Crash leftovers require explicit owner review; no background process or implicit cleanup of another owner's lock.

Limits: 8 trusted roots, 32 artifacts, 4 MiB/file, 16 MiB total, 1024 rows/columns and at most 1,048,576 cells/matrix, depth16/path1024 bytes, 128 indexed packages, 256 request identities and 2 MiB state envelope. Missing files still count against declared total. Excess refuses; nothing silently truncates. Memory work is bounded by these limits; matrix conversion/edge generation is local validation, not scientific inference. Only finite fixed error codes leave the module; raw provider exceptions become source_unavailable.

## Verification and integration remaining

Run `node --test desktop/core/s5/test-package.cjs`. Set `SIGNET_S5_TEST_ROOT` only to a new owned evidence runtime if retaining synthetic fixtures. Test helpers never read private data, public sample matrices, RData objects or old shared runtime.

Independent review remains separate. S5 desktop integration, S3 actual download/marker provider, S4 accepted run attestation, actual native import/export, derived rendering/atomic artifact manifest, clone-to-new-S1-draft and trusted S6 session preparation/loading are not implemented here. They require a later card and an accepted S4 integration baseline. Source-generation scientific metadata/axes beyond the specified files cannot be inferred from numeric matrices.
