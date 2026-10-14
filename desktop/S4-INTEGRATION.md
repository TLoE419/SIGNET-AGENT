# S4 local graph integration

Base: accepted S3 `4e5e735d20686014a4761d4fb5cc115d294a5128`. Pure graph module adopted byte for byte from `5177db10e9116e4173853e4081690b0fe90713a8`. Neither source is edited. This source is an isolated feature branch; it is not deployed to the user's checkout.

## Closed public interface

All eight names are explicit in main, preload, Service and worker. Main requires the owning top frame at `signet://app/index.html`; review mode refuses every operation. Service caps S4 arguments at 16 KiB; core rejects unknown fields. No caller can supply authority, plans, scheduler keys, manifests, scripts, file paths, ports or shell commands.

| Method | Exact input |
| --- | --- |
| stagePlanPrepare | draftId, stage, mode, requestId |
| stagePlanList | draftId |
| stagePlanStatus | operationId |
| stageGraphExpand | operationId, revision, expectedGraphRevision |
| stageReserve | operationId, revision, expectedGraphRevision, nodeId, requestId |
| stageReconcile | operationId, revision |
| stageCancellation | operationId, revision, confirmed |
| stageRetry | operationId, revision, requestId |

Formal settings/review pages show saved operations, six stages with saved input boundary/dependencies, mutually exclusive layouts, immutable prerequisites, graph revision/batches, approved budget, resource generation/application/observation and separate local versus unknown scheduler/scientific states. Save/reload S1 first; edit S3 resources/bindings through existing controls. Stage planning accepts selectors only. Hidden test scripts use synthetic DOM interaction, not native user input.

## Persistent identities and boundaries

O2 remains schema 2, adding discriminated `kind: s4-plan`, `analysisId: null`, frozen `SIGNET-J4-O2-adapter-v1` and bounded mutable `local`. Existing monitor and S3 records are unchanged. Stage records have their own operation/attempt/owner. Pure planning uses a logical `draft-<draftId>` namespace, explicitly not a created scientific analysis. `refs.o2.commit` denotes the accepted O2 baseline above, not a claim that it is this branch's later HEAD.

Prepare resolves exact saved draft, selected input fingerprints/validation, current sidecar/profile/resource/cap references. Same request returns the persisted identity after source revalidation; different selection conflicts. A shared S3 adapter mutex serializes configuration changes/archive against stage planning. No stale-lock stealing. O2's short lock guards its own registration/CAS. A blocked plan is still a real durable local operation, never a fake submitted job.

Graph state is core-owned `runtime/s4/<attemptId>/graph.json` using the adopted bounded/fsynced/CAS ledger. Status reads preserve graph bytes/mtime. Graph changes are committed before O2 summaries: after interruption, status reads authoritative graph revision/intents and never resubmits. Local reservations are `submission-unknown`, not submitted jobs. There is no effect executor anywhere in this adapter. O2 frozen record <=80 KiB; local summary <=24 KiB/32 observed scheduler keys (larger histories refuse with record-limit, never silently truncate); max128 S4 records within O2's max512 scan; ledger <=4 MiB/256 batches/512 intents; list <=100. History is finite.

Trusted ports may only be installed in the core constructor by future accepted integrations. The production worker supplies none. Synthetic tests install offline providers. Preflight must match S1 validation/manifest, S3 independently validated endpoint authority/current capability/root access/artifact hashes, official commit, every exact resource ref and numeric allocation, explicit CPU layout and full approval budget. P3 memory uses per-node MiB; this adapter conservatively refuses per-CPU reinterpretation. Children must reference the same current capability snapshot and exact selected profile. The existing fixed module hashes all preflight times and performs its one-clock reserve check; it is unchanged.

Generated manifests, phase-one completion proof, scheduler snapshots and owned cancellation keys come only from core ports. Recheck source/capability after awaited manifest/proof/observation before state change. Phase two needs the complete generated phase-one seal. Reconciliation binds graph kind, attempt, owner, node, phase and hashes before strict batch/step parsing. Completed scheduler exit zero remains verifying without trusted outputs. Unknown/duplicate observations never resubmit. Successful strict reconciliation accumulates immutable scheduler keys in the persisted O2 record. Cancellation first stops local expansion, then builds a plan against that independently persisted complete known-key set (an omitted known child cannot claim all stopped); it does not issue cancellation. A running child keeps the cancellation plan in cancelling. Retry only creates a new full-stage plan/attempt with purge false and old outputs preserved; unknown prior status adds an explicit prerequisite.

## Deliberate unavailable production capabilities

No trusted preflight/manifest/output/observation/cancellation provider, accepted Slurm/SSH executor, real submit approval, R/container/scientific execution or model is installed here. Missing binding, validation, prior-stage output, authority, placement, resource mapping and budget stay concrete blocked prerequisites. Plan/resource generation, reservation, reconciliation proposals and retry proposals all retain executeEnabled false. Nothing is submitted, uploaded, computed or cancelled remotely. No job ID or scientific product is fabricated.

## Checks

`npm test` covers inherited suites and S4 integration. Also run the unmodified S3 and S4 module suites with an explicitly isolated runtime redirect as described in the delivery evidence. `test-s4-integration.cjs` tests real Service/worker IPC, persistence/restart/dedup, source drift and drift during producer await, CAS, budgets/barriers, all layouts, missing dependencies, time expiry/future observations, strict identity, cancellation/new attempts, main/preload review rejection, status read-only behavior, and guarded-worker zero external-effect attempts.

No native desktop/user, real station, university HPC or scientific acceptance is asserted. Independent verification remains separate.

## S4-I-V01 selection restoration repair

The selected persisted operation is authoritative for the displayed stage/layout. Loading or opening it copies `frozen.selection.stage/mode`, clears transient node/confirmation selection, and never rewrites the record. Refresh keeps an explicitly selected operation when it remains in the returned list; otherwise it chooses the latest available operation. Draft defaults apply only when no saved operation is selected. Preparing or retrying a new operation also synchronizes its saved selection. A manual save after reload therefore uses the restored mode, including network-allocation-steps.

Run `node --test test-s4-mode-restore.cjs` from desktop for the focused renderer-factory regressions. Owned hidden Electron coverage separately saves steps/controller/single-stage operations, reloads and switches them, preserves old records, then verifies an entirely new process restores the same steps operation/attempt/stopped state and saves again in steps mode. These are synthetic DOM/IPC checks, not native or remote scientific acceptance. Backend stage graph, authority and execution guards are unchanged.
