#!/system/bin/sh
# Zerion action.sh — on-device commands.
#
#   action.sh status        current vs expected vs original values
#   action.sh reset         restore original values captured at first install
#   action.sh apply         apply expected values immediately (best-effort)
#   action.sh collect       dump a device snapshot (props + state)
#   action.sh collect-oat <path>  emit an OAT/VDEX header as hex
#
# Runs as a child process, so `exit` is allowed here (unlike customize.sh).
# Every action refreshes /data/adb/zerion/state.json counters
# (apply_count/reset_count/last_action).

MODDIR=${0%/*}
DATA_DIR=/data/adb/zerion
EXPECTED="$MODDIR/expected.props"
ORIGINALS="$DATA_DIR/originals.json"

# Shared state.json helpers (sourced; must not exit).
. "$MODDIR/state-common.sh"

set_prop() { resetprop -n "$1" "$2" 2>/dev/null || setprop "$1" "$2"; }
del_prop() {
  resetprop -n --delete "$1" 2>/dev/null || resetprop -n -d "$1" 2>/dev/null \
    || setprop "$1" ""
}

# Emit "name=value" lines from originals.json (flat JSON object).
originals_lines() {
  sed -n 's/^[[:space:]]*"\([^"]*\)"[[:space:]]*:[[:space:]]*"\(.*\)",*[[:space:]]*$/\1=\2/p' \
    "$ORIGINALS" 2>/dev/null
}

json_unescape() {
  printf '%s' "$1" | sed 's/\\\\/\\/g; s/\\"/"/g; s/\\\//\//g'
}

read_original() {
  originals_lines | while IFS= read -r kv; do
    [ -z "$kv" ] && continue
    name=${kv%%=*}
    if [ "$name" = "$1" ]; then
      value=${kv#*=}
      json_unescape "$value"
      return 0
    fi
  done
}

cmd_status() {
  refresh_state status
  printf '%-46s %-9s %-16s %-16s %-16s\n' "PROPERTY" "STATUS" "CURRENT" "EXPECTED" "ORIGINAL"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    name=${line%%=*}
    expected=${line#*=}
    current=$(getprop "$name" 2>/dev/null)
    original=$(read_original "$name")
    [ -z "$original" ] && original="(unset)"
    [ -z "$current" ] && current="(unset)"
    status="other"
    if [ "$current" = "$expected" ] && [ "$expected" != "$original" ]; then
      status="applied"
    elif [ "$current" = "$expected" ] && [ "$expected" = "$original" ]; then
      status="noop"
    elif [ "$current" = "$original" ]; then
      status="original"
    elif [ "$current" = "(unset)" ]; then
      status="missing"
    fi
    printf '%-46s %-9s %-16s %-16s %-16s\n' "$name" "$status" "$current" "$expected" "$original"
  done < "$EXPECTED"
}

cmd_reset() {
  [ -f "$ORIGINALS" ] || { echo "Zerion: no originals snapshot at $ORIGINALS"; exit 1; }
  originals_lines | while IFS= read -r kv; do
    [ -z "$kv" ] && continue
    name=${kv%%=*}
    value=${kv#*=}
    value=$(json_unescape "$value")
    if [ -z "$value" ]; then
      del_prop "$name"
      echo "Zerion: reset $name -> (unset)"
    else
      set_prop "$name" "$value"
      echo "Zerion: reset $name -> $value"
    fi
  done
  refresh_state reset
  echo "Zerion: done. Values apply to future dexopt runs; reboot for full effect."
}

cmd_apply() {
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    name=${line%%=*}
    value=${line#*=}
    set_prop "$name" "$value"
    echo "Zerion: apply $name=$value"
  done < "$EXPECTED"
  refresh_state apply
  echo "Zerion: done. Values apply to future dexopt runs; reboot for full effect."
}

cmd_collect() {
  refresh_state collect
  echo "# zerion snapshot (target Android @TARGET_ANDROID@, preset @PRESET@)"
  android=$(getprop ro.build.version.release 2>/dev/null | cut -d. -f1)
  sdk=$(getprop ro.build.version.sdk 2>/dev/null)
  [ -n "$android" ] && echo "android=$android"
  [ -n "$sdk" ] && echo "sdk=$sdk"
  echo "props:dalvik.vm.useartservice=$(getprop dalvik.vm.useartservice 2>/dev/null)"
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    name=${line%%=*}
    echo "props:$name=$(getprop "$name" 2>/dev/null)"
  done < "$EXPECTED"
  print_state_line
  echo "# end snapshot"
}

cmd_collect_oat() {
    # $1 = absolute path to an OAT/VDEX artifact on device.
  # Only the header (magic + version + fixed fields + key-value store) is
  # needed; 64 KiB covers every known layout's KV store without pulling tens
  # of MB. Output is `oathex:<path>=<hex>`.
  local path="$1" hex
  [ -n "$path" ] || { echo "usage: $0 collect-oat <path-to-oat-or-vdex>"; return 1; }
  [ -f "$path" ] || { echo "Zerion: no such file: $path" >&2; return 1; }
  if command -v od >/dev/null 2>&1; then
    hex=$(head -c 65536 "$path" 2>/dev/null | od -An -tx1 -v 2>/dev/null | tr -d ' \n')
  else
    hex=$(head -c 65536 "$path" 2>/dev/null | hexdump -v -e '1/1 "%02x"' 2>/dev/null)
  fi
  [ -n "$hex" ] || { echo "Zerion: could not read $path" >&2; return 1; }
  refresh_state collect
  echo "oathex:$path=$hex"
}

case "${1:-status}" in
  status)      cmd_status ;;
  reset)       cmd_reset ;;
  apply)       cmd_apply ;;
  collect)     cmd_collect ;;
  collect-oat) cmd_collect_oat "$2" ;;
  *) echo "usage: $0 {status|reset|apply|collect|collect-oat <path>}"; exit 1 ;;
esac
