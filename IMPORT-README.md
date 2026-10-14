# A5 core-only package import into a new S1 draft

Base: accepted S5 `d0859cd45dfa5b6621dc3e41a477522d8dfe08db`. Only importer, its tests and this document are new. Existing Drafts schema1, fields, input references, hashes, workflow support and scientific creation/start remain unchanged. No renderer/main/service/preload wiring, picker, network, R, analysis, download or original artifact copying.

## Trusted interface

```js
const {Importer}=require('./desktop/core/s5/importer.cjs');
const importer=new Importer({
  stateRoot: '/absolute/private/import-state',
  packageIndex, // real existing PackageIndex, trusted source resolver/roots
  drafts,       // real existing Drafts, canonical host-owned workspace
  owner: 'host-owner', now: Date.now,
  resolveImport: async request => trustedHost.resolveImport(request)
});
const result=await importer.execute({
  packageId,packageHash,sourceRef:{sourceId,batchId,revision},
  requestId,authorizationToken,confirmed:true,
  label:'Imported result',notes:'',cohort:null,
  parameters:{freq:0.5,ntop:2}
});
const current=await importer.inspect({requestId});
```

All fields are exact; paths, shell commands, arbitrary draft IDs, raw source grants and raw scientific input mappings are rejected. Request IDs/tokens are at most 80 characters and requests at most 16 KiB. Label/notes use the original 80/2000-character contract. Visualization parameters must satisfy original S1 limits. The trusted resolver returns null to cancel, or exactly:

```js
{grantId,owner,packageId,packageHash,sourceRef,expiresAt}
```

Expiry must be a future safe timestamp no more than one hour ahead. The host must check user consent, current sender/frame/formal mode, opaque token owner and current package authorization **on every resolution**, including cold reopen. `confirmed` alone is not an authorization boundary. This module only validates the injected grant; no native approval UI is supplied. A new unconfirmed/cancelled request does not create import state or drafts. Previously created draft history is never erased on cancellation/revocation.

## Draft semantics and schema compatibility

Import requires a current registered package with complete source transfer and ready original frequency/coefficient/positions matrices. Missing optional derived/session files and unknown scientific provenance do not prevent creation. The package and its additional source grant are revalidated before materialization and completion, binding package hash, exact source/batch/revision, manifest/grant hashes, original artifact IDs/relative paths/roles/bytes/hash/state, network hashes, original visualization parameters/revision and session evidence.

The created schema1 content has workflow `import`, entryStage/finishAfter `visualization`, user label/notes, empty species/assembly and **empty inputs**. Frequency/coefficient are never mislabeled as expression/genotype. `cohort:'TCGA'|'GTEx'` is an explicit user choice. Null cohort uses the schema-required `TCGA` compatibility value, with sidecar `declaredCohort:null` and `cohortMeaning:'schema-compatibility-only'`; it does not assert TCGA origin. Remaining numeric/tissue values are original S1 schema defaults, not inferred facts about the source; sidecar parameterMeaning explicitly identifies only freq/ntop as requested visualization settings. Existing source visualization refs remain separate from requested new settings.

### Required public import projection (V-A5-IMPORT-01)

**Formal import wiring MUST consume `result.importView` from `Importer.execute` or a fresh `Importer.inspect`; it MUST NOT expose bare `Drafts.load`/`Drafts.list` as the official imported-package API.** Those legacy methods remain internal schema readers, including their TCGA/Lung defaults. Do not cache a view as proof of current authorization; call inspect on cold reopen and before use.

A successful currently verified binding returns:

```js
result.importView = {
  draftRef: {draftId, revision, contentHash},
  draft, // exact checked original Drafts.load(...).draft, not a modified schema
  declaredCohort: null, // or explicitly selected 'TCGA'/'GTEx'
  cohortMeaning: 'schema-compatibility-only', // or 'user-selected'
  schemaCohort: 'TCGA',
  parameterMeaning: 'schema-defaults-except-requested-freq-ntop'
};
```

Render the draft and these semantics together. Unknown declared cohort must be displayed as unknown; `draft.cohort`/`schemaCohort` TCGA is only schema compatibility in that case. For an explicit cohort the meaning is user selection, **not verified dataset provenance**. All parameters other than requested freq/ntop, notably `draft.parameters.tissue === 'Lung'`, are schema defaults, never evidence of source tissue (even for selected GTEx/TCGA). Source visualization evidence remains separate in the bound sidecar. The draftRef hash covers unchanged stored schema content, not an annotated or rewritten draft.

The projection is constructed only after rechecking actual draft identity/content and exact checksummed sidecar, on top of current source/authorization checks. Bad/missing sidecar, source drift, cancellation, revocation or incomplete operation returns `importView:null`, with bindingReady false. A historical draftRef/actualDraftCreated may remain; neither is a current trusted view. Inspect never repairs a missing sidecar; explicit execute may reconcile it against the same intent/draft and then revalidate. Do not fall back to a legacy schema load when the view is null. This is a checked snapshot under the existing protected-ancestry assumption, not an atomic filesystem/source transaction.

`bindingReady` and `validation.kind:'package-import-binding'` describe the importer adapter's current package/draft/sidecar binding only. `Drafts.validate` remains the original legacy validator and returns workflow-unavailable. This avoids sending result matrices through the network workflow's eight raw-input fields. `executeEnabled`, computeReady and sessionStartEnabled remain false, scientificStatus is unknown. Future formal adoption must explicitly route the package binding adapter, then separately provide trusted session generation/load and S6 execution authority; it must not enable all legacy import drafts.

## Persistent intent and recovery

1. Allocate a core draft ID and persist a checksummed bounded request intent before any schema draft materialization.
2. Original Drafts.save cannot create a caller-preallocated new ID: passing an ID means updating an existing draft. Therefore the importer uses **unchanged real Drafts.save** in a deterministic private staging workspace to generate valid schema1 content, parameters, timestamps and content hash. On recovery it loads that one staged record rather than creating multiple final drafts. It then changes only the generated envelope ID to the already persisted core ID; content/hash/schema/revision remain original. This distinction is intentional: materialization into the actual Drafts folder uses exclusive publication, while real Drafts.save supplies schema construction in private staging. No Drafts schema or method was patched.
3. Save the exact target schema record, expected identity and phase before final publication. Write an exclusive same-folder temp, fsync/read back, publish using non-overwriting hard link, sync the directory and verify via real Drafts.load. Real Drafts.list and a fresh Drafts instance see the new ID. Existing records are untouched.
4. Persist an external checksummed sidecar under import-state/sidecars, binding draft ID/revision/contentHash to the frozen package/source refs. Sidecar publication does not overwrite an existing file; a mismatched or corrupt record is blocked.
5. Revalidate source/authority and save completion. A cold request with the same request payload reconciles the same target inode and record, then completes missing sidecar work. Same ID with changed payload conflicts. Missing/replaced/edited drafts or bad sidecars block; no old draft is deleted, rewritten or silently recreated.

These files are not a cross-file atomic transaction. `actualDraftCreated:true` means this intent's verified draft was actually materialized, including historical creation after subsequent drift/removal. Sidecar/journal failure after draft publication reports partial and true, not false. Publishing without proof reports null/incomplete. A corrupt/unreadable request journal reports unknown/null rather than a false zero-draft assertion. Source drift blocks readiness but preserves created draft history. `actualFilesWritten` follows the same draft materialization flag, not source artifact copying; private staging/journal writes can precede a false draft flag. `inspect` revalidates without creating/resuming drafts, and can confirm a complete binding after a lost completion acknowledgement.

Unknown stale/replaced locks are never stolen. A real process exit after target publication leaves its intent, file and lock. The test proves the product refuses that lock; only the test harness, after confirming its own child exit, releases its own known lock, then a separate process recovers the same ID. This is **not automatic stale-lock recovery**. A host/operator must independently establish ownership before resolving a stale lock. Incomplete temp/staging evidence is retained when safe automatic recovery is not possible. State must be protected and retained: deleting an intent outside the protocol destroys idempotence evidence.

## Bounds and filesystem limits

At most 128 intent records, 64 KiB each and 2 MiB combined; bounded top-level scan. Target draft folder scan stops after 384 entries, and new creation is conservatively refused at 128 entries (validation/temp records count as entries). Staging allows at most one schema record and four directory entries; unexpected/partial stage contents can require review. PackageIndex retains 32 artifacts, 4 MiB/file and 16 MiB/package bounds. Metadata limits and before/open/after identity/size/time checks occur **before buffer allocation**. Capacity refusal never deletes old history.

Import state, target Drafts folder, package index state and source trees cannot overlap in either direction. All ancestor paths must be canonical non-symlink directories; state/host/draft directory identity and owned lock inode/content are rechecked. Original production workspace and old S2–S5 source runtime paths are refused. These are Node path guards, **not OS openat/anchored descriptor isolation**. The host must protect approved state and draft ancestry from concurrent/untrusted mutation; syscall-internal swap-and-restore races are not eliminated. A detected race reports blocked/incomplete/unknown without deleting foreign files. Hard-link-unsupported filesystems refuse operation; no overwrite fallback. Actual power loss, arbitrary filesystem semantics and malicious writable ancestry remain unverified/unsupported.

## Reproduction and evidence limits

```sh
SIGNET_IMPORT_TEST_ROOT=/absolute/owned/evidence/runtime node --test desktop/core/s5/test-importer.cjs
```

Tests use only new synthetic source/destination roots, real Drafts.save/load/list and PackageIndex. They cover cold same-ID recovery, request conflict/cancellation, source/ref/grant drift, sidecar corruption/hash/replacement, path/schema/capacity limits, original records/index/source preservation, missing sessions, partial draft/journal errors, unknown/replaced lock, directory races, buffer growth bound and zero external calls in normal import. A separate owned Node child deliberately exits after real target publication; no other process is stopped. Controlled fault injection is not actual disk exhaustion/power-loss certification. Strict inherited source time/hash guards are not relaxed and no automatic retry masks natural refusals. Independent verify then polish is required before any formal UI adoption.
