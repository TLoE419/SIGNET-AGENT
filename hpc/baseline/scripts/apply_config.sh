#!/bin/bash
# Reset SIGNET's config.ini to config/baseline.overrides through SIGNET's own `signet -s`.
# Usage: apply_config.sh            (reads BASELINE_DIR / SIGNET_DIR from env.sh)
set -u
BASELINE_DIR=${BASELINE_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
# shellcheck source=/dev/null
[[ -n "${SIGNET_DIR:-}" ]] || source "$BASELINE_DIR/env.sh"
: "${SIGNET_DIR:?SIGNET_DIR is not set; copy env.sh.example to env.sh}"
OVERRIDES=${OVERRIDES:-$BASELINE_DIR/config/baseline.overrides}
ALLOWED_VARS=" SIGNET_REF_PREFIX SIGNET_GMAP_PREFIX SIGNET_GTF SIGNET_CLINICAL SIGNET_SIF "

cd "$SIGNET_DIR" || { echo "[apply_config] cannot cd to $SIGNET_DIR" >&2; exit 1; }
# Keep the user's original config once; never overwrite that backup.
[[ -e config.ini.pre-baseline ]] || cp config.ini config.ini.pre-baseline

status=0
while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%%#*}
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
    ./signet -s --"$key" "$value" > /dev/null
    actual=$(./signet -s --"$key" | sed -e '/^[[:space:]]*$/d' -e 's/[[:space:]]*$//')
    if [[ "$actual" != "$value" ]]; then
        echo "[apply_config] $key: expected '$value', config.ini has '$actual'" >&2; status=1
    else
        echo "[apply_config] $key = $value"
    fi
done < "$OVERRIDES"
exit $status
