# Optional Electron shell

Electron is the only supported UI. `renderer/` owns the application shell,
styles, translations, chat and Stage 6 controllers. One React entry renders the
shell and SSH controls. Existing chat/graph DOM controllers remain isolated in
`workspace.js` to preserve their behavior during integration.
Python remains a separate API service and can be developed without Electron.

## Run

First follow the root Python setup and model sign-in instructions. Then, from the
repository root (Node.js 22.12+ and npm are required):

```sh
npm ci --prefix electron
npm start --prefix electron
# Optional model provider; uses the existing .env configuration:
npm start --prefix electron -- --provider groq
```

The launcher prefers `.venv/bin/python`, then `python3` on PATH. To choose another
interpreter, set `SIGNET_PYTHON` to its executable path (not a shell command):

```sh
SIGNET_PYTHON=/absolute/path/to/python npm start --prefix electron
```

macOS and Linux are supported by this launcher; Windows process management and
packaged installers are not implemented. This is a source checkout launcher:
Python, its dependencies, Codex CLI when selected, and scientific prerequisites
must still be installed. No scientific data, Python runtime or model credentials
are bundled.

## Development terminal

Start explicitly in development mode from the repository root:

```sh
npm run dev --prefix electron
# Or choose a provider:
npm run dev --prefix electron -- --provider groq
```

Quit an already-running SIGNET instance first; a second launch focuses the
existing instance and does not change its mode. Before signing in, click
**Dev terminal → Connection diagnostics** at the bottom right. Then use the
normal SSH controls to Connect; dev login/unlock dialogs also show the live log.

- **Connection diagnostics** monitors local key unlock, system OpenSSH startup,
  authentication, Duo challenge waiting, remote health, failure and disconnect.
  The opening event states the exact `username@host:port` target before
  authentication.
  It works before authentication. The last 300
  events stay in Electron Main memory across panel close, failure and page reload,
  until app exit. Only fixed allowlisted protocol messages and sanitized error
  codes are recorded; raw PTY output, banners, challenge text/responses,
  passwords, passphrases and private keys are never forwarded to this log.
- **Raw SSH log** shows text received through the system OpenSSH PTY, including
  server banners and keyboard-interactive prompts. This is the place to inspect
  the exact Duo menu and login text returned by HPC3.
  Server-provided text can contain account or device details, so the view is
  available only in dev mode and is rendered as inert escaped text rather than
  being executed by the interactive terminal. Passwords, passphrases and private
  keys submitted by the app are not logged; OpenSSH may echo a non-secret menu
  choice such as `2`. The
  latest 2 MiB / 2,000 entries stay only in Electron Main memory until app exit;
  attempts made before this feature was running cannot be recovered afterward.
- When HPC3 returns a keyboard-interactive challenge, the complete server name,
  instructions and prompts are forwarded to the active login dialog. Numbered
  choices such as `1. Duo Push ...` are rendered as buttons; selecting one sends
  that exact option back to the pending SSH challenge, whether the server placed
  the option in its instructions or in a prompt. Manual Duo passcodes remain
  available through the prompt field. Prompt contents are displayed transiently
  and are never added to diagnostics or persisted.
- **Execution activity** previews Python SSH broker commands, stdout/stderr,
  start/end times, exit status and the current running count. It follows output
  while scrolled to the bottom. It is a bounded, in-memory preview: 128 KiB per
  command and the last 200,000 characters in the panel; it is not a durable log.
  Local Python processes, LLM output and previously submitted scheduler jobs
  are not automatically attached to this view.
- **Interactive shell → Attach terminal** attaches xterm to the primary
  xterm-256color login PTY already owned by Electron. Input, Ctrl-C, ANSI output
  and resizing affect that real login shell. Detaching or closing the panel only
  removes the renderer view; it does not close SSH. Python commands use separate
  channels through the same OpenSSH control connection.
- Authentication success alone is not treated as connected. Electron immediately
  starts `/usr/bin/ssh` in a foreground xterm-256color PTY with an app-private
  ControlMaster socket and `ControlPersist=no`, then runs a fixed,
  input-free identity probe that verifies the selected username and confirms
  `sbatch` exists. It publishes the connected state only after all checks pass.
  This mirrors HPC3's native SSH
  login flow, keeps the transport tied to the app lifecycle, and captures the
  server MOTD and prompt in **Raw SSH log**. The optional developer terminal
  attaches to that primary PTY; Python commands open sibling channels through
  its private control socket. Closing the primary process closes the connection.
- The connection snapshot includes the current phase, the verified remote
  hostname/account, Slurm availability, check steps, and timestamp. **Check
  again**, window focus, and return from background run the same health check;
  results are cached for 15 seconds to avoid unnecessary HPC3 traffic. Python
  broker work also requires a recent healthy result. A failed forced/proactive
  check closes the stale transport and reports whether identity, Slurm, timeout,
  DNS/network, or session health failed. No ASKPASS, polling web API, detached
  `ssh -f`, long-lived `ControlPersist`, or second SSH owner is introduced.
- **Detach terminal**, **Close panel** or page reload detaches the renderer while
  preserving the Electron-owned primary PTY. SSH disconnect/app shutdown first
  requests `ssh -O exit`, then terminates the owned PTY if needed and removes its
  private control directory. Reconnecting never replays input.

`npm start` have no terminal UI or terminal bridge. Main only
registers the dev IPC handlers for an explicit `--dev` in an unpackaged app;
packaged apps ignore the flag. Dev IPC checks the owning window/main-frame
origin, caps input and dimensions, and bounds unacknowledged terminal output.
Terminal history and activity are not saved. xterm generates layout/theme CSS,
so only the dev window permits inline styles; script and network restrictions
remain in force, and production CSP remains unchanged.

Validate the real terminal against an isolated localhost SSH test server with
`npm run test:dev --prefix electron`. This test covers real renderer input,
Ctrl-C, broker activity, a single shared transport, and panel/reload cleanup.

## SSH connection

The top bar reuses the original `ssh-auth-key-management` status control: click
its identity or LED to edit the connection; use the switch to connect, disconnect,
or cancel. Connect first checks the selected authentication method and only then
opens the required temporary credential prompt.

The connection dialog offers **Duo** and **SSH key**. With no saved key, the SSH
key block offers key creation/import. Host and port are preset to UCI HPC3 under **Advanced connection
settings**. **Save** only saves the profile; **Connect** saves and connects.
Neither account passwords nor private-key passphrases appear in this dialog.
Duo sign-in requests the account password and forwards server-provided keyboard
challenges. Both methods use an Electron-owned SSH session for Python commands.

**Add SSH key…** opens **Generate SSH key**, which requests a key name and a new
passphrase with confirmation, without UCInetID. It creates an encrypted RSA 4096
key locally. Only afterwards does **Set up SSH key** request UCInetID and account
password, complete Duo challenges, install the public key, and verify a fresh
key-authenticated session before selecting the profile. Account association is
saved only after verification succeeds. The public key is available there for
manual setup. Cancelling retains the encrypted key but clears the temporary
passphrase and cancels temporary authentication sessions.
**Use Existing SSH Key** uses the native picker and offline inspection, also
without account fields; the username is entered in connection settings later.
Passwords and passphrases are never persisted.
Existing private keys must be passphrase-protected OpenSSH keys owned by the
current user with owner-only permissions (normally `0600`).
As in the original design, inspection accepts one RSA, Ed25519 or NIST ECDSA
key in an OpenSSH container using `aes256-ctr` with bcrypt (16-byte salt,
1–100 rounds). Other formats, ciphers and excessive KDF costs are rejected
before local unlock; inspection and decryption run in bounded worker threads.

The first connection to a host is blocked and shows its SHA-256 host-key
fingerprint. Verify that value through an independent administrator-provided
channel before trusting it. A changed saved identity is always blocked and cannot
be replaced in the UI. Profiles, encrypted app-managed keys and host trust are
stored below Electron's `userData/ssh` directory with owner-only permissions.
Passwords and passphrases are not persisted.

Once connected, Python scientific commands use a per-launch private Unix socket
to ask Electron Main to open command channels through the owned OpenSSH
ControlMaster. The broker socket is
placed in a random owner-private short directory, requires a random token passed
only to the owned Python child, and transfers command input/output as binary data.
Standalone Python has no broker variables and continues to use its configured
system OpenSSH transport.

SSH UI lives in `renderer/features/ssh`, native SSH services in `main/ssh`,
and their contracts in `shared/ssh`. Chat and Stage 6 retain their existing
JavaScript controllers under `renderer/features`.
`npm start` builds the renderer and SSH Main/worker bundles automatically. A missing or corrupt SSH
configuration is reported by the SSH controls without preventing chat startup.
The earlier integration's flat version-1 profiles and host pins are read without
rewriting them. Private-key-only edits retain their existing version (1 or 3).
Saving a Duo profile upgrades profiles.json to version 4 and first writes an
owner-private profiles.before-duo-<uuid>.json backup. New installations use
version 4. Earlier app versions cannot read version 4: quit the app and restore
the pre-Duo backup before rolling back; preserve the current profiles.json too.
Private key files and host pins are not migrated.

## Architecture and ownership

- Electron Main spawns `main/backend/server.py` with an anonymous control pipe. The wrapper
  calls the independently usable `create_server` API factory.
- Python binds an OS-assigned loopback port, reports readiness over stdout, and
  sends existing application diagnostics to stderr. Main never adopts another
  server or assumes that an occupied fixed port belongs to SIGNET.
- Electron serves an allowlisted local renderer build through its session protocol handler. API requests are forwarded unchanged to the owned Python origin. Python serves no HTML or frontend assets. Node integration is off,
  context isolation and sandboxing are on. A narrow preload exposes only named SSH
  profile, key-picker, trust, registration and connection methods. Normal mode
  exposes no generic IPC, filesystem, shell or remote-exec method; explicit dev
  mode adds the bounded PTY operations described above. Requests are restricted to the owned origin, permissions are denied,
  subframe navigation and popup windows are blocked. Existing Host, Origin, token
  and CSP protections remain in effect (with dev-only inline styles for xterm). Only the two official RCIC login/key guidance links open in the system browser.
- Result downloads from `/stage6/file` retain the native save dialog. No generic
  filesystem or local shell API is exposed to the page.
- Closing the window, quitting, or losing the renderer requests backend shutdown.
  Python stops accepting requests, lets existing request/Stage 6 workers finish
  and save, then exits. After five seconds the native dialog offers waiting or
  explicit force quit. No tool is automatically replayed or retried.
- If Main crashes, the Python control pipe reaches EOF and follows the same
  graceful drain. An active or stuck operation can keep Python alive; there is
  deliberately no promise of immediate termination. Explicit force quit kills the
  owned local process group. Tools which create separate sessions and remote jobs
  may outlive that group; inspect run records before retrying. This does not cancel
  VM/SLURM jobs and does not automatically cancel remote scheduler jobs.
- Main owns the foreground SSH PTY and its private control socket. Normal quit
  first drains and checkpoints Python work, then sends `ssh -O exit`, applies a
  bounded TERM/KILL fallback, and removes both SSH and broker socket directories.
  A Main crash closes the PTY file descriptors and releases the SSH TCP
  connection; already-submitted remote jobs may continue independently.
- A backend crash closes the desktop session with an error instead of restarting
  it and risking replay. A single-instance lock prevents a second desktop host
  using the same state directory.

## State

Desktop chat and Stage 6 session files live under `state/` within Electron's
`SIGNET Research Assistant` userData directory (normally
`~/Library/Application Support/SIGNET Research Assistant/state/` on macOS).
The last viewed saved conversation is restored on startup. Use the Saved conversations
selector to reopen older chats, or New chat to start a blank conversation. Older
state files without an active-session preference resume the most recently created
saved chat. Restoring a conversation displays its saved messages and work records;
it never repeats a model request or scientific operation. The previous 32-chat hard
limit is removed. Histories are retained without automatic eviction, so the local
state file grows with usage.

Standalone backend development still uses project-local state by default. No
existing history is moved, overwritten, or automatically imported. The desktop
and standalone backend share scientific files; do not run concurrent scientific
work through separate processes (the turn lock is per process).

## Renderer integration migration

- Removed: root `web/`, the browser UI at Python `/`, and Python static-asset routes.
- Frontend sources now live in `electron/renderer/`; generated assets are in
  `electron/build/renderer/` (not tracked). Run `npm ci --prefix electron`, then
  `npm start --prefix electron`.
- `python chat_ui.py` still starts a standalone API. `/bootstrap` returns JSON with
  `token`, `model`, and `initial`; it replaces the former HTML bootstrap response.
  `/chat`, `/stage6`, and file downloads retain their contracts and protections.
- No stored-data migration is required. Preserve existing state files when
  switching revisions; returning to the previous revision restores its browser
  launcher without requiring a data conversion.

## Checks

```sh
npm test --prefix electron
npm run test:smoke --prefix electron
npm run test:startup --prefix electron
.venv/bin/python -m unittest discover -s tests -p 'test_desktop_server.py' -v
```

The Node suite starts the real Python service in disposable state directories,
checks HTTP boundaries, startup failures, owner-crash cleanup, key inspection,
registration/Duo challenges, live SSH execution and saved-file compatibility.
The restored UI tests check the original separate-dialog interaction flow. The native smoke
test loads the actual UI without a model call, checks sandboxing, workspace access,
language switching, blocked external navigation and service shutdown. It writes a
screenshot to the OS temporary directory. The startup regression test executes the
package entry and verifies that it creates a visible window containing the chat UI;
it uses disposable state with 32 legacy conversations, exercises history selection
and explicit new-chat navigation, verifies retained messages/events, and closes the
window afterward. This catches
entry-point failures that a direct call to `launch()` in the smoke test bypasses.
On Linux run both native checks with a display, or prefix each command with
`xvfb-run -a`. GitHub Actions runs all three Electron checks on macOS.

### SSH key management

Selecting **SSH key** reveals the key management block, including when no keys
are saved. The block contains the saved-key selector, **Add SSH key…**,
a details icon that opens key information and actions in a separate dialog.
**Edit key** (name and optional account) and **Delete key** each open their own
dialog; confirmation and errors stay in that dialog.
Duo mode hides this block. Deleting removes the saved metadata entry and changes
profiles referencing that key to Duo. It preserves private-key files and remote
authorized_keys entries; it does not revoke remote access. Disconnect before
changing keys. After changing the desktop bridge, restart Electron to load it.

## Source layout and ownership

```text
electron/
  main/
    app/          Application entry, windows and lifecycle
    backend/      Python process supervision and server.py
    security/     Navigation and origin policy
    renderer/     Allowlisted assets and API forwarding
    ssh/          Service coordinator; connection/, keys/, storage/, ipc/
    devtools/     Developer terminal service and IPC
  preload/        Explicit, restricted desktop bridge
  renderer/
    app/          React root, application shell and feature composition
    features/
      chat/       Chat, streaming progress and Markdown controller
      stage6/     Parameters, network graphs and comparisons
      ssh/        connection/, auth/, keys/, state/ and feature composition
      devtools/   Diagnostics and interactive terminal UI
    components/   Shared modal, confirmation, actions and icons
    styles/       Application styles and SSH color/layout tokens
    i18n/         English and Traditional Chinese translations
    vendor/       Third-party assets and licenses
  shared/ssh/     Contracts and pure validation shared across processes
  scripts/        Build and native dependency preparation
  tests/          Unit, protocol, lifecycle and native application tests
  build/          Generated renderer and Main/worker bundles (ignored)
```

Renderer and shared code must not import Main or native Node APIs. Main owns
processes, filesystem access and private credentials. Renderer accesses desktop
capabilities only through preload. `scripts/build.mjs` builds the entire app;
`npm start`, `npm test` and the generated `build/ssh`/`build/renderer` locations
remain stable. Source paths changed from the former `src/ssh`, `modules/ssh`,
and root launcher files; no stored data or wire protocol changed.

## Remote environment setup

After SSH connects, the status block shows environment checks and installation
progress. Click its environment row to choose a shared installation root/partition,
review missing prerequisites, confirm installation, or retry a failed check.
SSH stays connected when the scientific environment is unavailable. In development
mode, the setup dialog and developer panel show step diagnostics.
See [environment setup](main/environment/README.md) for behavior and limitations.

Run `npm run test:environment --prefix electron` for the localhost SSH mock flow;
it never connects to HPC3 or downloads the real image.

SSH readiness is detected through a bounded local OpenSSH ControlMaster check,
independent of the user's prompt. Authentication text is parsed only before the
transport becomes ready. Upload pipe failures are handled as command failures,
including broken input pipes, without terminating the application.

## Integration with baseline monitoring and the earlier login proposal

The standalone monitoring scripts in `hpc/baseline/` run on HPC3; they do not add
a second connection or a monitoring screen to the desktop. Their fixtures and
local account settings remain separate from Electron's private connection state.

The desktop keeps one SSH owner and one login entry point. The useful network,
VPN, DNS and reconnect guidance from the earlier browser login proposal is
incorporated into the existing connection dialog and errors. That proposal's
`/hpc3` polling API, detached shared master, ASKPASS helper and sidebar card are
not imported. Existing desktop cancellation, three-minute authentication timeout,
health checks, host trust and owned-connection cleanup continue to apply.

This integration does not verify a real HPC3 login or scientific job. Localhost
SSH fixtures exercise desktop behavior; actual remote acceptance remains separate.
