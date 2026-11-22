"""Model-callable HPC3 preparation tools. Execution stays in agent.runtime.hpc."""
import json

from agent.paths import PROJECT_ROOT
from agent.runtime import hpc
from agent.tools.ui import UI_CHANNEL

INVENTORY = json.loads((PROJECT_ROOT / 'signet_inventory.json').read_text())
REVISION = INVENTORY['revision']


def check_hpc_environment() -> dict:
    """Read-only check of whether HPC3 is ready for SIGNET: workspace folder, Slurm, Apptainer, pinned SIGNET source and container.

    Use it when the user asks whether they are ready, what is missing, or how a
    setup step is progressing. Requires the app's SSH connection to HPC3. Reports
    existence, image size and the app's own setup states. Source integrity is
    verified by the desktop environment settings check. Dataset inputs and
    references are checked separately in the corresponding stage review.
    Items whose status is not "ok" still need preparation; "in_progress" means a
    setup step is still running in the background.
    """
    return hpc.check_environment(REVISION)


def create_hpc_workspace() -> dict:
    """Explain how to prepare the configured workspace through the desktop HPC3 settings. No separate workspace is created."""
    return hpc.start_step('workspace')


def _show_progress(result):
    """When the assistant starts a setup step, open the Workflow panel so its row shows the progress."""
    channel = UI_CHANNEL.get()
    if channel is not None and result.get('executed'):
        channel({'panel': 'workflow', 'visible': True, 'refresh': True})
    return result



def install_signet_source() -> dict:
    """Install the pinned SIGNET source with its example data on HPC3. Call only when the user's own message asks for it or agrees to it.

    Runs in the background and returns immediately. Keeps files only if every
    hash matches; never replaces an existing installation. Use
    check_hpc_environment later.
    """
    return _show_progress(hpc.start_step('signet', INVENTORY['repository'], REVISION))


def download_signet_container() -> dict:
    """Submit a Slurm job that downloads the SIGNET container into the configured environment. Call only when the user's own message asks for it or agrees to it.

    Publishes the image only after its size and checksum match, never replaces an
    existing image and never starts a second download. Returns immediately with
    the job ID; use check_hpc_environment later.
    """
    return _show_progress(hpc.start_step('container'))


def read_hpc_setup_log(step: str) -> dict:
    """Classify the private log for one HPC3 setup step: "workspace", "signet" or "container".

    Use it when check_hpc_environment reports that a setup step failed, to
    obtain fixed diagnostic codes. Model dispatch never returns the log lines;
    unknown causes require the user to inspect private diagnostics. Read-only.
    """
    return hpc.read_log(step)


HPC_TOOLS = [check_hpc_environment, create_hpc_workspace, install_signet_source,
             download_signet_container, read_hpc_setup_log]
