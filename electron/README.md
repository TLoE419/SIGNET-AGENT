# Optional Electron shell

This source-run desktop host displays the existing `web/` UI from an owned
`chat_ui.ChatServer`. Browser startup, HTTP routes, model providers, scientific
tools, VM transport and the Web UI remain available. Electron Main owns the
optional SSH connection used by the Python scientific runtime; the renderer never
receives a socket or private-key contents. Normal mode exposes no command API;
explicit development mode adds a restricted interactive SSH terminal.

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

`npm start` and browser mode have no terminal UI or terminal bridge. Main only
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

The connection dialog offers **Duo** and **SSH key**. With no saved key, only Duo
is enabled. Host and port are preset to UCI HPC3 under **Advanced connection
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
The browser launcher has no broker variables and continues to use its configured
system OpenSSH transport.

The original React/TypeScript SSH components are isolated in `modules/ssh` and
`src/ssh`; the chat and Stage 6 UI retain their existing JavaScript implementation.
`npm start` builds the SSH bundles automatically. A missing or corrupt SSH
configuration is reported by the SSH controls without preventing chat startup.
The earlier integration's flat version-1 profiles and host pins are read without
rewriting them. Private-key-only edits retain their existing version (1 or 3).
Saving a Duo profile upgrades profiles.json to version 4 and first writes an
owner-private profiles.before-duo-<uuid>.json backup. New installations use
version 4. Earlier app versions cannot read version 4: quit the app and restore
the pre-Duo backup before rolling back; preserve the current profiles.json too.
Private key files and host pins are not migrated.

## Architecture and ownership

- Electron Main spawns `server.py` with an anonymous control pipe. The wrapper
  calls the same `create_server` factory as the original browser CLI.
- Python binds an OS-assigned loopback port, reports readiness over stdout, and
  sends existing application diagnostics to stderr. Main never adopts another
  server or assumes that an occupied fixed port belongs to SIGNET.
- Renderer loads the same HTML, scripts and HTTP APIs. Node integration is off,
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

The browser CLI still uses its original project-local files. No existing history
is moved, overwritten or automatically imported. Both interfaces share the same
project `data/`, `runs/`, `.env`, and configured scientific runtime. Use only one
interface at a time to run scientific work: the existing turn lock is per process,
not a cross-process scientific lock.

Switching back to browser mode requires only closing Electron and running the
original `.venv/bin/python chat_ui.py` command. Desktop state stays available for
the next desktop launch.

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
