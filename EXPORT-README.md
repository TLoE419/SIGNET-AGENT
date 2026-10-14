# A5 finite physical export module

Core-only addition on accepted S5 `d0859cd45dfa5b6621dc3e41a477522d8dfe08db`. No main/service/preload/renderer wiring, native dialog, external source discovery, derived output generation, download, import draft, network, R or scientific execution. Existing `PackageIndex.exportPlan` remains unchanged.

## Trusted host contract

```js
const {Exporter}=require('./desktop/core/s5/exporter.cjs');
const exporter=new Exporter({
  stateRoot: '/absolute/private/owned-export-journal',
  packageIndex, // existing PackageIndex, bound to trusted source roots
  owner: 'host-owner-id',
  now: Date.now,
  resolveDestination: async ({destinationToken,packageId,packageHash}) => {
    // Resolve the host's own opaque, owner/frame/formal-mode-bound capability.
    // Return null when cancelled. Never accept this grant or path from renderer input.
    return trustedCapabilityStore.resolve(destinationToken,packageId,packageHash);
  }
});
const result=await exporter.execute({packageId,packageHash,
  artifactIds:['frequency','positions'],destinationToken,requestId});
const recorded=exporter.status({requestId});
```

Every option and request has exact keys; paths/grants in a request are rejected. Constructor does not create state. `resolveDestination` is a trusted injected boundary, not an authentication service. The host must validate user consent, sender/frame, current formal mode, token ownership and current destination authorization **on every resolution**, including cold reopen. Reusing a token string alone proves none of these.

A destination grant has exactly:

```js
{grantId,owner,packageId,packageHash,root,
 identity:{dev,ino},parentIdentity:{dev,ino},expiresAt,
 files:[{artifactId,name}]}
```

The root and every ancestor must be canonical real directories. The parent and root identities must match the approved existing directories. `name` is one simple ASCII filename (maximum 128 characters), never a relative path. Names and artifact IDs are unique. Expiry is a safe integer, in the future and at most one hour away. Refreshing expiry preserves the same fixed grant identity; changing root, owner, package/hash, file set or grant ID conflicts with an existing intent. Source, package index, export state and destination trees must not overlap. Destination equality, ancestry and descendants are rejected against `PackageIndex.stateRoot`, every source root and export state, before acquiring the package transaction lock, creating an export intent or staging bytes. Comparisons use canonical paths and directory-separator boundaries; similarly prefixed adjacent directories are allowed. The host owns and protects the state directory and approved parent directories from concurrent/untrusted mutation.

## Execution and evidence

1. Resolve destination; cancellation before intent creation produces zero export-state/destination writes. Existing intent cancellation is blocked and returns prior historical receipts honestly.
2. Revalidate the registered package plus the additional resolved source grant against its frozen grant hash. Each selected original artifact must be ready, including from a partial package; scientific verification is never promoted.
3. Create an exclusive owner/token/inode-checked lock and durable checksummed request intent. Refuse all existing final targets before staging. Limit 128 intents, 64 KiB each and 2 MiB total, with a bounded directory scan. The host must explicitly manage retention; the executor does not delete history to bypass limits.
4. Read original files through non-following descriptors with bounded bytes, hash and stat checks. Create exclusive same-filesystem temporary files, write and count actual bytes, fsync, read back the whole file and recheck the source. Revalidate the complete bounded package before publishing.
5. Publish with `fs.linkSync(temp, final)`; this does not replace an existing destination. Unsupported hard links/filesystems are rejected without a fallback rename. Fsync the destination directory, read back hash/bytes and verify the final inode equals this intent's staged inode, then persist that file's receipt and clean its owned temp. Publication is atomic per filename only; the selected set is **not** a multi-file transaction.
6. Recheck source and destination at completion. Any final verification error returns partial if receipts exist. A failed link acknowledgement may have produced a file: it retains `publishing` and reports unknown, never false zero-write. A later instance reauthorizes, revalidates and reconciles only the same intent's inode/hash. Identical foreign bytes are not ownership evidence.

`actualFilesWritten` is true when at least one verified historical receipt exists, null if publication is uncertain with no receipt, otherwise false. `temporaryBytesWritten` counts known successful writes including discarded retries. Receipts identify artifact/name/bytes/SHA256/inode/time. They describe historical confirmed publication, not a promise the file is still present. `status` reads historical state only; `execute` performs current authorization and reconciliation. Missing or replaced published targets block rather than silently recreate them. Unknown publishing and root-race states require ownership review if safe reconciliation is impossible. Unknown stale locks are never stolen. Failed safe staging temps are removed; staged/uncertain temps can remain for recovery and are not foreign-cleaned. A foreign/replaced lock remains and prevents a complete claim.

## Concurrency limit

**This is path-based Node I/O, not OS `openat` directory-descriptor isolation.** Root and parent identity, non-symlink ancestor identity, and immediate-parent change time are checked around each phase; unrelated shared ancestor activity is allowed. Detected replacement/revocation stops publication. The machine probe found `/dev/fd/<directory-fd>/child` and `/proc/self/fd/<directory-fd>/child` unavailable (`ENOENT`). A swap within an OS call cannot be prevented by these checks. Post-publication mismatch is reported as uncertain; no unsafe rollback or foreign deletion occurs. A swap and restore may evade observation. Therefore this module is for host-protected approved parent directories; adversarially mutable destination ancestry is unsupported and must be refused by the host. No claim of race-free security or crash/power-loss durability across unsupported filesystems is made. A native anchored implementation would be required for stronger isolation.

## Bounds and tests

Inherit PackageIndex limits: maximum 32 artifacts, 4 MiB/file, 16 MiB/package. Exact 16 KiB request, 80-character tokens. Original source/index files are unchanged by export. No 200-edge preview is copied as a complete derived network; this version only copies selected originals byte for byte. All scientific status remains unknown.

```sh
SIGNET_EXPORT_TEST_ROOT=/absolute/owned/evidence/runtime node --test desktop/core/s5/test-exporter.cjs
```

Tests create only their own synthetic directories and retain evidence. Fault injection covers lost acknowledgements, journal failure, partial publication/collision, ENOSPC/partial bytes, expiry, source/grant drift, source/destination/state/target symlinks, root/parent replacement, request and journal bounds, cold reconciliation, equal foreign bytes, lock ownership, complete 4 MiB copying, original/index preservation and zero external calls. Deliberate faults and natural refusals are retained separately in the task evidence. Existing PackageIndex's strict stat rejection remains intact; a successful run does not explain a prior natural rejection. Independent verification and polish precede any formal UI adoption.
