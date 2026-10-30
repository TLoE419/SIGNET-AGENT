"""Model-callable HPC3 preparation tools. Execution stays in agent.runtime.hpc."""
import json

from agent.paths import PROJECT_ROOT
from agent.runtime import hpc

INVENTORY = json.loads((PROJECT_ROOT / 'signet_inventory.json').read_text())
REVISION = INVENTORY['revision']


def check_hpc_environment() -> dict:
    """Read-only check of whether HPC3 is ready for SIGNET: workspace folder, Slurm, Apptainer, pinned SIGNET source, container and Phase 2 reference files.

    Use it when the user asks whether they are ready, what is missing, or how a
    setup step is progressing. Requires the app's SSH connection to HPC3. Reports
    only existence, file sizes, the SIGNET git version and the app's own setup
    states; it never reads file contents and never changes anything on HPC3.
    Items whose status is not "ok" still need preparation; "in_progress" means a
    setup step is still running in the background.
    """
    return hpc.check_environment(REVISION)


def create_hpc_workspace() -> dict:
    """Create the app's workspace folder on HPC3 (/pub/<user>/signet-agent with containers, refdata and runs). Call only when the user's own message asks for it or agrees to it.

    Does only this one step and returns immediately; the folders are created in
    the background. Never modifies an existing folder. Use check_hpc_environment
    afterwards to confirm.
    """
    return hpc.start_step('workspace')


def install_signet_source() -> dict:
    """Clone SIGNET into the HPC3 workspace and check out the pinned commit. Call only when the user's own message asks for it or agrees to it.

    Does only this one step and returns immediately; cloning runs in the
    background. Creates the workspace folder first if it is missing; never
    replaces an existing signet folder. Use check_hpc_environment afterwards.
    """
    return hpc.start_step('signet', INVENTORY['repository'], REVISION)


def download_signet_container() -> dict:
    """Submit a Slurm job that downloads the official SIGNET container (several GB) into the HPC3 workspace. Call only when the user's own message asks for it or agrees to it.

    Does only this one step and returns immediately with the job ID. Creates
    the workspace folder first if it is missing; never replaces an existing
    container or starts a second download while one is running. Use
    check_hpc_environment to see when it finishes.
    """
    return hpc.start_step('container')


def download_reference_file(file: str) -> dict:
    """Submit a Slurm job that downloads one public Phase 2 reference file into the HPC3 workspace: "ref" (1000 Genomes GRCh38 chr1 genotypes, about 950 MB), "gmap" (GRCh38 genetic map), "gtf" (GENCODE v22 gene annotation) or "clinical" (TCGA-LUAD race by case). Call only for the files the user's own message asks for or agrees to.

    Downloads only the raw file from a fixed source and records its URL, size
    and checksum in refdata/SOURCES.tsv; matching ref and gmap to a study
    happens later in data preprocessing. Returns immediately with the job ID;
    creates the workspace first if missing; never replaces an existing file or
    starts a second download of the same file. Use check_hpc_environment later.
    """
    if file not in hpc.REFERENCES:
        return {'status': 'invalid', 'executed': False, 'error': f'file must be one of {", ".join(hpc.REFERENCES)}.'}
    return hpc.start_step(file)


def prepare_imputation_reference() -> dict:
    """Submit a Slurm job that turns the downloaded ref and gmap into SIGNET's IMPUTE2 inputs for the SIGNET example study (TCGA-LUAD, chromosome 1). Call only when the user's own message asks for it or agrees to it.

    Detects each file's format first and converts only when needed (VCF to .gen,
    "pos chr cM" to IMPUTE2's map); files already in SIGNET's format are used as
    is. Keeps only study markers whose position and alleles match the reference,
    in a copy; the original study is never changed. Needs SIGNET (for the example
    study), ref and gmap first. Returns immediately with the job ID; the log then
    shows a counts-only summary with the match rate, and a warning when the rate
    is low enough to suggest different genome builds.
    """
    return hpc.start_step('prepare')


def read_hpc_setup_log(step: str) -> dict:
    """Show the last lines of the app's own log for one HPC3 setup step: "workspace", "signet", "container", "ref", "gmap", "gtf", "clinical" or "prepare".

    Use it when check_hpc_environment reports that a setup step failed, to
    explain why. These logs are written by the app's setup commands only and
    contain no research data. Read-only.
    """
    return hpc.read_log(step)


HPC_TOOLS = [check_hpc_environment, create_hpc_workspace, install_signet_source,
             download_signet_container, download_reference_file, prepare_imputation_reference, read_hpc_setup_log]
