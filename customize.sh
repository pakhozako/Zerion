#!/system/bin/sh
# Zerion customize.sh — install-time setup (Magisk / KernelSU / APatch).
#
# IMPORTANT: this script is SOURCED by the module installer, not executed as
# a child process. Never call `exit` at the end: on failure call the
# installer-provided `abort`, on success let the script end naturally.
# Because it is sourced, `$0` is the installer, not this file; the module
# directory is `$MODPATH`, set by the installer before sourcing.
#
# What it does:
#   1. Validates expected.props values against an accepted compiler-filter
#      whitelist so an invalid value is never installed.
#   2. Snapshots the original property values once into
#      /data/adb/zerion/originals.json (kept across module updates).
#   3. Writes /data/adb/zerion/state.json with install facts.

MODDIR=${MODPATH:-${0%/*}}
DATA_DIR=/data/adb/zerion
EXPECTED="$MODDIR/expected.props"
ORIGINALS="$DATA_DIR/originals.json"

# Shared state.json helpers (sourced; must not exit).
. "$MODDIR/state-common.sh"

# abort() is provided by all three installers (Magisk util_functions.sh,
# KernelSU/APatch installer.sh). Define a fallback in case customize.sh is
# sourced in an environment that lacks it.
command -v abort >/dev/null 2>&1 || abort() { echo "[!] $1" >&2; exit 1; }

ui_print() { echo "$1"; }
ui_print_error() { echo "[!] $1"; }

# Accepted compiler-filter values for pm.dexopt.* properties:
#   * canonical names accepted by every AOSP version that reads them;
#   * obsolete names still accepted by ART's native parser
#     (CompilerFilter::ParseCompilerFilter) on every version, because some
#     versions ship obsolete defaults (e.g. pm.dexopt.install-bulk-secondary-
#     downgraded =extract on 12+);
#   * the no-op "skip" (PMS 12+ / ART Service 14+ only), gated on $API (31+):
#     on Android 9-11 a "skip" value for a reason that IS read makes PMS
#     throw "Value not valid" and crashes that dexopt path.
FILTER_WHITELIST="assume-verified verify space space-profile speed speed-profile \
everything everything-profile verify-none interpret-only verify-profile \
verify-at-runtime balanced time extract quicken"

is_filter() {
  case "$1" in
    pm.dexopt.*) return 0 ;;
    *) return 1 ;;
  esac
}

is_filter_value_ok() {
  # "skip" is special: only accepted where the framework reads it (API 31+).
  if [ "$1" = "skip" ]; then
    [ "${API:-0}" -ge 31 ]
    return $?
  fi
  case " $FILTER_WHITELIST " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}

validate_expected() {
  [ -f "$EXPECTED" ] || { ui_print_error "expected.props missing; refusing to install"; return 1; }
  local line name value rest
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
    esac
    name=${line%%=*}
    value=${line#*=}
    rest=${value#*=}
    # Reject extra '=' signs and empty names/values.
    if [ -z "$name" ] || [ -z "$value" ] || [ "$rest" != "$value" ]; then
      ui_print_error "malformed line in expected.props: '$line'"
      return 1
    fi
    case "$name" in
      *[!A-Za-z0-9._-]*)
        ui_print_error "illegal property name '$name'"; return 1 ;;
    esac
    # Filter-valued pm.dexopt.* properties must be on the whitelist.
    # pm.dexopt.<reason>.concurrency are integers, not filters — skip them.
    if is_filter "$name"; then
      case "$name" in
        *.concurrency) ;;
        *)
          if ! is_filter_value_ok "$value"; then
            ui_print_error "value '$value' for '$name' is not an accepted compiler filter"
            return 1
          fi
          ;;
      esac
    fi
  done < "$EXPECTED"
  return 0
}

# Minimal JSON string escaper for property values. Property names are already
# restricted to [A-Za-z0-9._-]; values only need \" and \\ handling for the
# JSON round-trip (dexopt property values are simple ASCII, no control chars).
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

snapshot_originals() {
  [ -f "$ORIGINALS" ] && return 0   # one-time snapshot; keep on updates
  mkdir -p "$DATA_DIR" || { ui_print_error "cannot create $DATA_DIR"; return 1; }
  local first=1 line name value cur
  {
    printf '{'
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      case "$line" in \#*) continue ;; esac
      name=${line%%=*}
      cur=$(getprop "$name" 2>/dev/null)
      if [ "$first" -eq 1 ]; then first=0; else printf ','; fi
      printf '\n  "%s": "%s"' "$(json_escape "$name")" "$(json_escape "$cur")"
    done < "$EXPECTED"
    printf '\n}\n'
  } > "$ORIGINALS"
  return 0
}

main() {
  ui_print "Zerion module @MODULE_VERSION@ (preset @PRESET@, target Android @TARGET_ANDROID@)"
  validate_expected || { ui_print_error "expected.props validation failed"; return 1; }
  snapshot_originals || { ui_print_error "failed to snapshot original property values"; return 1; }
  write_install_state "$MODDIR/state.info" || {
    ui_print_error "failed to write device state to $DATA_DIR/state.json"; return 1; }
  ui_print "Original property values snapshot at $ORIGINALS"
  ui_print "Device state recorded at $DATA_DIR/state.json"
  ui_print "Reboot for the properties in system.prop to take effect."
  return 0
}

main || abort "Zerion install aborted"
