# Shared by desktop setup scripts and uploaded scientific command wrappers.
# Loading stays inside the current command/job; shell startup files are never edited.
signet_init_modules() {
    local signet_restore_u='' signet_init_status=0 signet_init
    case $- in *u*) signet_restore_u=yes; set +u;; esac
    if [ -z "${USER:-}" ]; then USER=$(id -un); export USER; fi
    if ! type module >/dev/null 2>&1; then
        for signet_init in /etc/profile.d/modules.sh /usr/share/Modules/init/bash; do
            if [ -r "$signet_init" ]; then
                . "$signet_init" >/dev/null
                type module >/dev/null 2>&1 && break
            fi
        done
    fi
    # A clean Slurm/worker environment also needs HPC3's category search paths.
    case "${MODULEPATH:-}" in
        */opt/rcic/Modules/modulefiles/*) ;;
        *) if [ -r /etc/profile.d/rcic-modules.sh ]; then . /etc/profile.d/rcic-modules.sh >/dev/null; fi;;
    esac
    type module >/dev/null 2>&1 || signet_init_status=1
    [ -z "$signet_restore_u" ] || set -u
    return "$signet_init_status"
}

signet_load_module() {
    [[ ${1:-} =~ ^(singularity|apptainer)/[0-9][A-Za-z0-9_.+-]*$ ]] || return 1
    signet_init_modules || return 1
    local signet_restore_u='' signet_load_status
    case $- in *u*) signet_restore_u=yes; set +u;; esac
    if module load "$1" >&2; then signet_load_status=0; else signet_load_status=$?; fi
    [ -z "$signet_restore_u" ] || set -u
    return "$signet_load_status"
}

signet_runtime_executable() {
    local signet_runtime signet_executable
    for signet_runtime in singularity apptainer; do
        signet_executable=$(command -v "$signet_runtime" || true)
        if [ -n "$signet_executable" ] && "$signet_executable" --version >/dev/null 2>&1; then
            printf '%s\n' "$signet_executable"
            return 0
        fi
    done
    return 1
}

signet_find_runtime() {
    executor=$(signet_runtime_executable || true)
    runtime_module=''
    [ -z "$executor" ] || return 0
    signet_init_modules || return 0
    local signet_modules signet_candidate
    signet_modules=$({ module -t avail singularity 2>&1 || true; module -t avail apptainer 2>&1 || true; } |
        sed 's/([^)]*)//g; s/^[[:space:]]*//; s/[[:space:]]*$//' |
        grep -E '^(singularity|apptainer)/[0-9][A-Za-z0-9_.+-]*$' | LC_ALL=C sort -u || true)
    # Prefer the exact version documented by RCIC when it is actually available.
    if printf '%s\n' "$signet_modules" | grep -Fxq singularity/3.9.4; then
        signet_modules=$(printf '%s\n' singularity/3.9.4; printf '%s\n' "$signet_modules" | grep -Fxv singularity/3.9.4 || true)
    fi
    for signet_candidate in $signet_modules; do
        if signet_load_module "$signet_candidate"; then
            executor=$(signet_runtime_executable || true)
            if [ -n "$executor" ]; then runtime_module=$signet_candidate; return 0; fi
        fi
    done
}
