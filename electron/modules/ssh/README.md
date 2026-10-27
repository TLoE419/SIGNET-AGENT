# Original SSH interaction design

Ported from `ssh-auth-key-management:desktop/modules/ssh` and its Electron host
components. The saved-key connection dialog, separate create/import registration
dialog, transient unlock prompt, and Luminous Glass + Halo status block retain
the original flow and appearance. CSS lives in `web/ssh.css`.

The current host mounts these components in the chat workspace top bar. Electron
Main owns the live SSH client and exposes only named configuration/authentication
methods to the renderer. Python remote work uses the separate private broker.
See `electron/README.md` for operation, storage compatibility and lifecycle.

Test doubles are confined to `electron/tests/fixtures`; production code has no
mock states or demo connections. The original UI and SSH tests run with `npm test
--prefix electron`, and the native smoke test checks the real page and dialogs.
