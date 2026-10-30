# SSH renderer feature

```text
ssh/
  SshControls.tsx              Feature composition and dialog flow
  index.ts                    Public feature exports
  connection/                 Settings, status block and credential/endpoint labels
  auth/                       Duo login, key unlock and host verification steps
  keys/                       Create/import, details, edit and deletion dialogs
  state/                       Preload adapters and connection state hook
```

`SshControls` coordinates the feature. `connection` owns the selected connection
and its status display; `auth` owns transient credential prompts; `keys` owns
saved-key interaction. `state` accesses the restricted preload API and subscribes
to connection snapshots. Shared contracts and validation live in
`electron/shared/ssh`, and native transport/storage live in `electron/main/ssh`.

Dialogs use `renderer/components/Modal.tsx`; CSS tokens and SSH styles live in
`renderer/styles/ssh.css`. Developer UI belongs to the sibling `devtools` feature.
The renderer never owns native processes or a generic local command API.

Run `npm test --prefix electron` for unit checks and
`npm run test:dev --prefix electron` for the native SSH/terminal flow.
