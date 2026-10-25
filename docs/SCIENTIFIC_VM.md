# Prepare a New Local Scientific VM

This is a manual, administrator-assisted recipe for a **new, disposable Ubuntu 22.04 x86_64 guest**. It is separate from the chat installation and from the old recovery script. Do not run the guest administration commands on your Mac, normal workstation, or a shared cluster. No existing developer VM, private disk, SSH key, or container image is supplied by this project.

The recipe describes how to satisfy the current Stage 4–6 adapter's interface. A VM that boots, an image that downloads, and a passing runtime preflight are different milestones. A fresh VM built with every command in this recipe has not yet been accepted end to end by this project; upstream image availability and its installed R packages must be checked on your machine. Stop at a failed check. Do not describe an unverified environment as analysis-ready.

For a small downloadable demonstration, [INSTALL.md](INSTALL.md) is sufficient. This optional procedure requires administrator access, substantial downloads, your own scientific inputs, and ongoing VM maintenance.

## 1. Create the Guest and Loopback SSH Forward

On macOS, install [UTM](https://mac.getutm.app/) and obtain an **amd64 / x86_64 Ubuntu Server 22.04 ISO** from [Ubuntu's official releases](https://releases.ubuntu.com/22.04/). Check the downloaded ISO against Ubuntu's published checksum before installation.

Create a new QEMU-backed VM. Use **Emulate → Linux** for an x86_64 guest on Apple Silicon; use x86_64 virtualization on an Intel host. Do not select an ARM guest for the x86 scientific image. Follow the [UTM system settings](https://docs.getutm.app/settings-qemu/system/) and [Ubuntu installation guide](https://docs.getutm.app/guides/ubuntu/) while retaining the architecture specified here. Emulation on Apple Silicon can be slow.

Allocate 4 virtual CPUs, at least 6 GB of guest RAM, and at least 40 GB of disk as an initial setup budget. These are not capacity estimates for real datasets; leave resources for the host and increase storage before importing data. Install Ubuntu with a regular administrator user and OpenSSH server. Keep access to the VM console.

Configure **Emulated VLAN** networking and this [port forward](https://docs.getutm.app/settings-qemu/devices/network/port-forwarding/): TCP, host address `127.0.0.1`, host port `2226`, guest port `22`. Do not bind to all host interfaces or expose this root-access guest to the LAN. For another VM manager on Linux, provide the same loopback-only SSH forward; that manager's creation procedure is not covered here.

The adapter connects to `root@127.0.0.1`, not an arbitrary SSH host or user. It transfers each run to the guest; a host-folder share and the historical `/work` mount are not required by this recipe.

## 2. Create Your Own Key on the Host

In the **host project's root**, not the guest console:

```sh
mkdir -p .dependencies/scientific-runtime/vm
# Run only if this new key path does not already exist.
ssh-keygen -t ed25519 -f .dependencies/scientific-runtime/vm/id_ed25519 -N ''
chmod 600 .dependencies/scientific-runtime/vm/id_ed25519
cat .dependencies/scientific-runtime/vm/id_ed25519.pub
```

The unattended adapter uses BatchMode and has no passphrase prompt. This dedicated local key is intentionally generated without a passphrase. Protect the host account and key file. Never overwrite an existing key or copy a developer's private key. Only the printed **public** key goes into the guest.

## 3. Configure the Dedicated Guest

In the **guest console**, sign in as the administrator created during Ubuntu installation:

```sh
sudo apt-get update
sudo apt-get install -y openssh-server curl ca-certificates python3 perl slurm-wlm munge squashfs-tools fuse2fs fuse-overlayfs uidmap libfuse2
sudo hostnamectl set-hostname signet-local
sudo -i
```

All remaining commands in this section run in that guest root shell. Add `127.0.1.1 signet-local` to `/etc/hosts` if the hostname does not resolve. Use your editor to create `/root/.ssh/authorized_keys` containing the public key printed in section 2, on one line:

```sh
install -d -m 700 /root/.ssh
# After entering the public key in /root/.ssh/authorized_keys:
chmod 600 /root/.ssh/authorized_keys
```

Create `/etc/ssh/sshd_config.d/00-signet-local.conf` with:

```text
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
```

Then validate the effective configuration and restart SSH:

```sh
sshd -t
sshd -T | grep -E 'permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication'
systemctl restart ssh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Require public-key authentication, root key login, and disabled password/keyboard-interactive login. If an earlier setting overrides these values, correct it before continuing. Keep this console open until host SSH works. Record the displayed host-key fingerprint for the next step.

### Verify the Host Identity from the Host

Back in the **host project root**:

```sh
ssh-keyscan -p 2226 -t ed25519 127.0.0.1 > .dependencies/scientific-runtime/vm/known_hosts.candidate
ssh-keygen -lf .dependencies/scientific-runtime/vm/known_hosts.candidate
```

Compare the fingerprint with the one displayed directly in the guest console. `ssh-keyscan` alone does not authenticate a server. Only if they match, and no existing `known_hosts` is being replaced, rename the candidate file:

```sh
mv -n .dependencies/scientific-runtime/vm/known_hosts.candidate .dependencies/scientific-runtime/vm/known_hosts
ssh -F /dev/null -i .dependencies/scientific-runtime/vm/id_ed25519 -p 2226 -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=.dependencies/scientific-runtime/vm/known_hosts root@127.0.0.1 'uname -m'
```

Expected: `x86_64` without a password or trust prompt. Never disable strict host-key checking. A changed host key requires checking the guest console again, not blindly deleting the saved key.

## 4. Install the Guest Container Runtime and Obtain the Image

Return to the **guest root console**. Install Apptainer using the [official 1.3 installation instructions](https://apptainer.org/docs/admin/1.3/installation.html). The following explicit package matches the historical runtime's version and x86_64 architecture; it is a compatibility baseline, not a claim that it is the newest security release:

```sh
curl -fL https://github.com/apptainer/apptainer/releases/download/v1.3.6/apptainer_1.3.6_amd64.deb -o /tmp/signet-apptainer.deb
apt-get install -y /tmp/signet-apptainer.deb
# Only on this fresh guest, if /usr/local/bin/singularity is absent:
ln -s /usr/bin/apptainer /usr/local/bin/singularity
singularity --version
```

Use an actual executable/symlink named `singularity`, not a shell alias: the assistant invokes noninteractive commands. Review the release's provenance and your institution's maintenance policy before installing downloaded packages.

The pinned [official SIGNET installation instructions](https://github.com/signet4grn/SIGNET/blob/bed55b3e121de0edf5fd43da683dc59850ff82d3/README.md#installation-of-required-packages) identify image `library://jiang548/signet/signet:0.0.6`. Configure a Library API endpoint as described in [Apptainer's endpoint guide](https://apptainer.org/docs/user/1.3/endpoint.html), then pull it to a **new** path:

```sh
mkdir -p /opt/signet
singularity remote add --no-login signet https://cloud.sylabs.io
singularity remote use signet
singularity pull /opt/signet/signet-0.0.6.sif library://jiang548/signet/signet:0.0.6
sha256sum /opt/signet/signet-0.0.6.sif
singularity exec --cleanenv --no-home /opt/signet/signet-0.0.6.sif sh -c 'uname -m; command -v Rscript; command -v ParaFly; command -v getopt'
```

Record the checksum and image origin privately with your environment notes; a locally computed checksum is not an upstream signature. The project pins scientific source files but does not publish a verified digest for this external image. If the registry needs authentication, is unavailable, or the image is missing, obtain access or a verified compatible image from the scientific maintainer. The project has no bundled fallback. Do not substitute an unrelated image or assume the image contains every Stage 6 package.

## 5. Configure a Single-Node Local Scheduler

Still in the **new guest root shell**, configure only this disposable guest. The adapter requires an idle `local` partition with at least 4 cores and 4096 MB available. Do not apply this local configuration to an institutional cluster.

```sh
systemctl stop slurmctld slurmd
install -d /var/lib/slurm/slurmctld /var/lib/slurm/slurmd /var/log/slurm
```

Create `/etc/slurm/slurm.conf` containing:

```text
ClusterName=signet-local
SlurmctldHost=signet-local
SlurmUser=root
SlurmdUser=root
AuthType=auth/munge
StateSaveLocation=/var/lib/slurm/slurmctld
SlurmdSpoolDir=/var/lib/slurm/slurmd
SlurmctldLogFile=/var/log/slurm/slurmctld.log
SlurmdLogFile=/var/log/slurm/slurmd.log
ProctrackType=proctrack/linuxproc
TaskPlugin=task/none
SelectType=select/cons_tres
SelectTypeParameters=CR_Core_Memory
SchedulerType=sched/backfill
AccountingStorageType=accounting_storage/none
JobAcctGatherType=jobacct_gather/none
MinJobAge=3600
ReturnToService=2
MpiDefault=none
NodeName=signet-local CPUs=4 RealMemory=5000 State=UNKNOWN
PartitionName=local Nodes=signet-local Default=YES MaxTime=01:00:00 State=UP
```

Check `/usr/sbin/slurmd -C` before starting. The NodeName line must match the actual guest CPU topology. Replace the example NodeName line with the reported NodeName/topology, remove `UpTime`, set `RealMemory` to 5000 only if the guest reports more than that, and append `State=UNKNOWN`. Ensure the hostname and partition's node name agree. At least 4096 MB must remain allocatable; increase guest RAM if necessary.

Ubuntu's munge package initializes its own private key; do not copy one from another installation. Start and test the services:

```sh
systemctl enable --now munge
systemctl enable --now slurmctld slurmd
scontrol ping
sinfo -h -p local -o '%t %c %m'
sbatch --wait --partition=local --cpus-per-task=4 --mem=4G --wrap='/bin/true'
squeue -h
```

Expected: controller `UP`, an `idle` node with at least 4 CPUs and 4096 MB, a successful trivial batch job, and an empty queue after it completes. This job checks scheduling without research data. If a node is down or invalid, inspect `journalctl -u slurmd -u slurmctld` and correct the configuration; do not force it to resume without resolving the cause. The current adapter also relies on recent completed-job records retained by `MinJobAge`.

## 6. Point the Assistant at the New Guest

In the **host project root**, create `.env` from `.env.example` only if it is absent. Preserve any model keys already there. Set these fields in your editor:

```dotenv
SIGNET_RUNTIME_PROJECT=.dependencies/scientific-runtime
SIGNET_SSH_PORT=2226
SIGNET_CONTAINER_IMAGE=/opt/signet/signet-0.0.6.sif
```

`SIGNET_CONTAINER_IMAGE` is a path **inside the guest**, not a host file. This guide stores the image in the guest disk; it does not need the historical `/work/evidence/` location. Prepare the source with INSTALL.md section 8, then run the application's real preflights from the host:

```sh
.venv/bin/python - <<'PY'
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(Path('.env'))
import signet_runtime, network_runtime, visualization_runtime
for label, module in [('Stage 4', signet_runtime), ('Stage 5', network_runtime), ('Stage 6', visualization_runtime)]:
    print(label, 'ready' if module.preflight() else 'unavailable')
PY
```

These checks contact your configured guest but do not submit an analysis. **Require the corresponding stage to report `ready` before requesting it.** For Stage 5 the queue must be idle. Restart the chat service after changing `.env`; an already-running process retains its previous environment.

For a failed check, first repeat the strict SSH command from section 3. Inside the guest, check image execution and the scheduler separately. Stage 4 requires `timeout`, Rscript, ParaFly, getopt, and R package `data.table`. Stage 5 additionally requires Python 3, setsid, and the R packages `MASS`, `data.table`, `dataPreparation`, `parcor`, `matrixcalc`, and `chron`. Stage 6 checks `igraph`, `dnet`, `visNetwork`, `STRINGdb`, `TFutils`, `shiny`, `shinyfullscreen`, `shinycustomloader`, `shinydashboard`, `plotly`, `DT`, `circlize`, `ggthemes`, and `fmsb`.

Those packages must be visible **inside the image under `--cleanenv --no-home`**. Installing R packages only on the host or in the guest user's home does not satisfy this. If the supplied image lacks them, obtain a compatible image or have the scientific maintainer build and verify a derived image with the missing packages. This repository does not currently provide that image build recipe or guarantee that archived scientific packages install from current repositories. Keep the stage unavailable until it passes; do not weaken the preflight.

## 7. Know What This Enables

This adapter handles Stage 4 on macOS and Stage 5–6 through the local guest connection. It does **not** redirect all host preprocessing into that guest. Stages 1–3 still run their selected tools on a compatible Linux host and require cohort-specific dependencies and inputs; see [ADVANCED.md](ADVANCED.md#native-linux-preprocessing). An external cluster is not automatically connected by these SSH settings.

After each stage's runtime check succeeds, use your own input files, check sample/coordinate alignment, and create a fresh run. No reference datasets, baseline IDs, or example outputs are supplied. A preflight pass does not establish data validity, successful scientific execution, or biological correctness. Use the application to query status before retrying an interrupted job.

Shut down this dedicated guest with `sudo shutdown -h now` only after checking for active work. Keep its disk, your keys, and environment notes locally for later use. Do not upload any of these assets. The historical `scripts/advanced/start_scientific_vm.sh` is a recovery-only entry point and should not be used to boot this newly created VM.
