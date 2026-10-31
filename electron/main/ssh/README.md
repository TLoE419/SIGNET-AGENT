# SSH Main services

```text
ssh/
  SshConnectionService.ts    Coordinates connection lifecycle and operations
  index.ts                  Public service exports used by the app build
  connection/
    OpenSshTransport.ts     Owns system OpenSSH PTY and command channels
  keys/
    AppManagedKeyStore.ts   Saved-key metadata and generated-key files
    PrivateKeyInspector.ts Validates supported encrypted private keys
    PrivateKeyUnlocker.ts  Unlocks keys using transient credentials
    keyWorkerClient.ts     Bounded worker requests and timeouts
    key-worker.ts          Worker entry for inspection, unlock and generation
  storage/
    stores.ts              Profiles, host trust and atomic JSON persistence
  ipc/
    sshIpcHandlers.ts      Authorized renderer requests and snapshot events
    broker.cjs            Private authenticated Python command transport
```

The service coordinates these modules; the renderer interacts through preload
and IPC. Developer-terminal services live in `main/devtools`. Shared contracts
and validation live in `shared/ssh` and contain no native process ownership.

The build retains `build/ssh/index.cjs` and `build/ssh/key-worker.cjs`. The worker
client resolves the worker beside the generated bundle, independent of source
folder layout. Stored data, IPC channels and Python broker messages are unchanged.
