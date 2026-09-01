#!/system/bin/sh
# Zerion action.sh — on-device commands.
#
#   action.sh status        current vs expected vs original values
#   action.sh reset         restore original values captured at first install
#   action.sh apply         apply expected values immediately (best-effort)
#   action.sh collect       dump a device snapshot (props + state)
#   action.sh collect-oat <path>  emit an OAT/VDEX header as hex
#   action.sh log-event <type> [pkg] [detail] [result]
#                               append one line to events.jsonl (bounded)
#
# Runs as a child process, so `exit` is allowed here (unlike customize.sh).
# Every action refreshes /data/adb/zerion/state.json counters
# (apply_count/reset_count/last_action).

MODDIR=${0%/*}
EXPECTED="$MODDIR/expected.props"

# Shared state.json helpers (sourced; must not exit). state-common.sh sets
# DATA_DIR (honoring ZERION_DATA_DIR); ORIGINALS must be computed AFTER it is
# sourced so both follow the same location.
. "$MODDIR/state-common.sh"
ORIGINALS="$DATA_DIR/originals.json"

set_prop() {
  resetprop -n "$1" "$2" 2>/dev/null && return 0
  setprop "$1" "$2"
}
del_prop() {
  resetprop -n --delete "$1" 2>/dev/null && return 0
  resetprop -n -d "$1" 2>/dev/null && return 0
  setprop "$1" ""
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
  [ -f "$EXPECTED" ] || { echo "Zerion: expected.props missing at $EXPECTED" >&2; return 1; }
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
  local failed=0 kv name value
  # originals_lines reads $ORIGINALS via a pipe; materialize it so the loop
  # runs in this shell (POSIX sh has no process substitution) and `failed`
  # survives the loop.
  local tmp
  tmp=$(mktemp 2>/dev/null) || tmp="$DATA_DIR/.originals.tmp"
  originals_lines > "$tmp" || { rm -f "$tmp"; echo "Zerion: cannot read $ORIGINALS" >&2; return 1; }
  while IFS= read -r kv; do
    [ -z "$kv" ] && continue
    name=${kv%%=*}
    value=${kv#*=}
    value=$(json_unescape "$value")
    if [ -z "$value" ]; then
      if del_prop "$name"; then
        echo "Zerion: reset $name -> (unset)"
      else
        echo "Zerion: FAILED to reset $name -> (unset)" >&2
        failed=1
      fi
    else
      if set_prop "$name" "$value"; then
        echo "Zerion: reset $name -> $value"
      else
        echo "Zerion: FAILED to reset $name -> $value" >&2
        failed=1
      fi
    fi
  done < "$tmp"
  rm -f "$tmp"
  refresh_state reset
  log_event reset "" "" "$([ "$failed" -eq 1 ] && echo fail || echo ok)"
  if [ "$failed" -eq 1 ]; then
    echo "Zerion: some properties could not be restored" >&2
    return 1
  fi
  echo "Zerion: done. Values apply to future dexopt runs; reboot for full effect."
}

cmd_apply() {
  [ -f "$EXPECTED" ] || { echo "Zerion: expected.props missing at $EXPECTED" >&2; return 1; }
  local failed=0 name value
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    name=${line%%=*}
    value=${line#*=}
    if set_prop "$name" "$value"; then
      echo "Zerion: apply $name=$value"
    else
      echo "Zerion: FAILED to apply $name=$value" >&2
      failed=1
    fi
  done < "$EXPECTED"
  refresh_state apply
  log_event apply "" "" "$([ "$failed" -eq 1 ] && echo fail || echo ok)"
  if [ "$failed" -eq 1 ]; then
    echo "Zerion: some properties could not be applied" >&2
    return 1
  fi
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
  log-event)   log_event "$2" "$3" "$4" "$5" ;;
  *) echo "usage: $0 {status|reset|apply|collect|collect-oat <path>|log-event <type> [pkg] [detail] [result]}"; exit 1 ;;
esac
