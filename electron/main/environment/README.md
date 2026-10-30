# Remote SIGNET environment

`EnvironmentService` observes each successful SSH session. Automatic checks probe
capabilities and look for the pinned SIGNET source/image under the configured
root (default `$HOME/.local/share/signet-agent`). SSH identity verification remains
independent: missing Slurm or software blocks environment readiness, not SSH login.

The user chooses a writable root accessible to compute jobs and a Slurm partition.
When missing software is detected, `EnvironmentModal` opens a separate installation
confirmation. Source installation fetches the inventory commit and archives only
its audited scripts/support files plus licenses, verifying SHA-256 hashes. Container
installation pulls official `library://jiang548/signet/signet:0.0.6`, tests basic tools,
and publishes the image without replacing an existing file. No study data or shell
startup files are changed. Existing invalid installations require another root;
there is no destructive repair operation.

Verification runs SIGNET settings in a disposable source copy, checks R/data.table,
ParaFly/getopt and partition visibility, and creates the isolated run parent. It
does not submit jobs, guarantee scheduler allocation, or validate study inputs.
Additional stage-specific checks remain in Python. Runtime/module tools must be
available to noninteractive SSH commands; this module does not install cluster
software or load site-specific modules automatically.

Preferences (root and partition only) are stored owner-private under
`userData/environment/settings.json`, keyed by SSH account/endpoint. Readiness is
never trusted across sessions: every connection is checked again. Connection
changes invalidate pending results. Remote temporary installation directories may
need inspection after a lost connection; they are never treated as a ready install.

Diagnostics use `environment:<step>` stages in the existing dev-only history,
recording transitions, duration, exit code and bounded stderr. The status block
shows the current phase and opens setup details; the endpoint line remains visible.

The authenticated Python broker exposes `environment` only when verification is
ready. Python uses its image, executor, work root and partition; it continues to
upload audited per-run scripts and inputs. `network_worker` accepts this shared
work root and uses the account's environment instead of root/VM-specific defaults.

Validation: `npm run test:environment --prefix electron` starts a local SSH server
on 127.0.0.1 and simulates remote installation (no HPC3/VPN/image download). It
checks confirmation, failure/retry, status, logs and Python broker configuration.
Real container retrieval and cluster compute-node access still need validation on
the target cluster after VPN access is available.
