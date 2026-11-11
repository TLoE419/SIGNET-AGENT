# Remote SIGNET environment

`EnvironmentService` observes each successful SSH session. Automatic checks probe
capabilities and look for the pinned SIGNET source/image under the configured
root (default `/pub/<user>/signet-agent` when writable, otherwise
`$HOME/.local/share/signet-agent`). SSH identity verification remains
independent: missing Slurm or software blocks environment readiness, not SSH login.

The user chooses a writable root accessible to compute jobs and a Slurm partition.
Missing components are offered in the Workflow panel, each with its own confirmation.
The source installation also extracts the official `example/` data listed under
`example_files` in the inventory, verified by hash; an installation made before
that is offered the example data alone, without replacing anything. Source installation fetches the inventory commit and archives only
its audited scripts/support files plus licenses, verifying SHA-256 hashes. The
container is downloaded by a Slurm job (`agent/runtime/hpc.py`), not on the login node,
and is published only after its size and checksum match, without replacing an existing
file; the next check then verifies it. No study data or shell
startup files are changed. Existing invalid installations require another root;
there is no destructive repair operation.

Verification runs SIGNET settings in a disposable source copy, checks R/data.table,
ParaFly/getopt and partition visibility, and creates the isolated run parent. It
initializes a missing `config.ini` from `config.ini.default` in that copy only;
an existing configuration is preserved. Missing/empty configurations and unsafe
configuration links fail verification. Because upstream SIGNET can exit zero
after a failed settings read, verification compares its nonblank output with the
copied configuration instead of trusting the exit status alone. Failures keep the
environment out of the ready state and do not persist a successful check.
It does not submit jobs, guarantee scheduler allocation, or validate study inputs.
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
ready; `setup-environment` returns the configured paths earlier, for read-only checks
and reference downloads that do not use the container. Python uses its image, executor, work root and partition; it continues to
upload audited per-run scripts and inputs. Workflow checks rehash the scripts and
support files using the same `signet_inventory.json` manifest. An archive needs no
`.git` directory; missing or modified audited files and revision mismatches still
block source readiness. Extra files, including user `config.ini`, are preserved. `network_worker` accepts this shared
work root and uses the account's environment instead of root/VM-specific defaults.

Validation: `npm run test:environment --prefix electron` starts a local SSH server
on 127.0.0.1 and simulates remote installation (no HPC3/VPN/image download). It
checks confirmation, failure/retry, status, logs and Python broker configuration.
Real container retrieval and cluster compute-node access still need validation on
the target cluster after VPN access is available.
