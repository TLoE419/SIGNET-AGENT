# Optional Electron shell

This source-run desktop host displays the existing `web/` UI from an owned
`chat_ui.ChatServer`. Browser startup, HTTP routes, model providers, scientific
tools, VM transport and the Web UI remain available unchanged. SSH authentication
from the separate SSH branch is not included.

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

## Architecture and ownership

- Electron Main spawns `server.py` with an anonymous control pipe. The wrapper
  calls the same `create_server` factory as the original browser CLI.
- Python binds an OS-assigned loopback port, reports readiness over stdout, and
  sends existing application diagnostics to stderr. Main never adopts another
  server or assumes that an occupied fixed port belongs to SIGNET.
- Renderer loads the same HTML, scripts and HTTP APIs. Node integration is off,
  context isolation and sandboxing are on, and no preload/privileged renderer API
  is exposed. Requests are restricted to the owned origin, permissions are denied,
  subframe navigation and popup windows are blocked. Existing Host, Origin, token
  and CSP protections remain in effect. External links are blocked in this phase.
- Result downloads from `/stage6/file` retain the native save dialog. No generic
  filesystem or shell API is exposed to the page.
- Closing the window, quitting, or losing the renderer requests backend shutdown.
  Python stops accepting requests, lets existing request/Stage 6 workers finish
  and save, then exits. After five seconds the native dialog offers waiting or
  explicit force quit. No tool is automatically replayed or retried.
- If Main crashes, the Python control pipe reaches EOF and follows the same
  graceful drain. An active or stuck operation can keep Python alive; there is
  deliberately no promise of immediate termination. Explicit force quit kills the
  owned local process group. Tools which create separate sessions and remote jobs
  may outlive that group; inspect run records before retrying. This does not cancel
  VM/SLURM jobs and does not establish future HPC3 connection ownership.
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
checks HTTP boundaries, startup failures and owner-crash cleanup. The native smoke
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

## HPC3 popup login lifecycle

Popup authentication has a three-minute deadline. Closing the browser server or
Electron backend cancels its pending SSH attempt and native dialog subprocesses,
then closes the shared connection if this app instance opened it. A connection
that was already open and reused is left running. Explicit Log out still closes
the selected shared connection. No password or Duo response is stored.

The login card remains available in compact windows, including Electron's minimum
760-pixel width. Offline lifecycle tests use inert local subprocesses and a fake
SSH service; they do not establish real HPC3 authentication or Duo acceptance.
