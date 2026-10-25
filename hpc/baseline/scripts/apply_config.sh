#!/bin/bash
# apply_config.sh - reset SIGNET's config.ini to config/baseline.overrides (Monitor Spec 01).
#
# Every template calls this before running SIGNET. SIGNET's step flags (e.g. `signet -t --g X`)
# write themselves into config.ini permanently, so without a reset one experiment's
# settings would leak into the next.
#
# Values are set through SIGNET's own `signet -s --KEY VALUE`, never by editing config.ini
# directly, and each one is read back to confirm it took effect. @NAME@ placeholders are
# filled from env.sh; an empty variable skips that key and prints SKIPPED, which marks the
# step that needs it as blocked.
#
# Usage:   apply_config.sh               (BASELINE_DIR / SIGNET_DIR come from env.sh)
# Env:     OVERRIDES=path                (optional; default config/baseline.overrides)
# Output:  one "[apply_config] key = value" or "SKIPPED" line per key on stdout
# Exit:    0 if every key was applied or skipped, 1 if any line was rejected or mismatched
# Side effect: backs up the original config.ini once as config.ini.pre-baseline.
set -u
BASELINE_DIR=${BASELINE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
# shellcheck source=/dev/null
[[ -n "${SIGNET_DIR:-}" ]] || source "$BASELINE_DIR/env.sh"
: "${SIGNET_DIR:?SIGNET_DIR is not set; copy env.sh.example to env.sh}"
OVERRIDES=${OVERRIDES:-$BASELINE_DIR/config/baseline.overrides}
# Only these env.sh variables may fill @NAME@ placeholders.
ALLOWED_VARS=" SIGNET_REF_PREFIX SIGNET_GMAP_PREFIX SIGNET_GTF SIGNET_CLINICAL SIGNET_SIF "

cd "$SIGNET_DIR" || { echo "[apply_config] cannot cd to $SIGNET_DIR" >&2; exit 1; }
# Keep the user's original config once; never overwrite that backup.
[[ -e config.ini.pre-baseline ]] || cp config.ini config.ini.pre-baseline

status=0
# Read the overrides file line by line; "|| [[ -n $line ]]" keeps a last line without newline.
while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%%#*}                       # drop comments
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ ! "$line" =~ ^[[:space:]]*([A-Za-z0-9_.]+)[[:space:]]*=[[:space:]]*([^[:space:]]+)[[:space:]]*$ ]]; then
        echo "[apply_config] malformed line: $line" >&2; status=1; continue
    fi
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    if [[ "$value" =~ ^@([A-Z_]+)@$ ]]; then
        var=${BASH_REMATCH[1]}
        if [[ "$ALLOWED_VARS" != *" $var "* ]]; then
            echo "[apply_config] $key: placeholder @$var@ is not allowed" >&2; status=1; continue
        fi
        value=${!var:-}
        if [[ -z "$value" ]]; then
            echo "[apply_config] SKIPPED $key: $var is empty in env.sh (step needing it is blocked)"
            continue
        fi
    fi
    # signet -s builds a sed expression with '@' delimiters and splits on spaces.
    if [[ "$value" == *@* || "$value" =~ [[:space:]] ]]; then
        echo "[apply_config] $key: value must not contain '@' or spaces" >&2; status=1; continue
    fi
    # Set, then read back: signet -s prints the stored value when given only the key.
    ./signet -s --"$key" "$value" > /dev/null
    actual=$(./signet -s --"$key" | sed -e '/^[[:space:]]*$/d' -e 's/[[:space:]]*$//')
    if [[ "$actual" != "$value" ]]; then
        echo "[apply_config] $key: expected '$value', config.ini has '$actual'" >&2; status=1
    else
        echo "[apply_config] $key = $value"
    fi
done < "$OVERRIDES"
exit $status
