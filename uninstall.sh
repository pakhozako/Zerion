#!/system/bin/sh
# Zerion uninstall.sh — restore original property values before the module is
# removed. Runs as a child process (busybox sh) via the module manager, so
# `exit` is allowed here (unlike customize.sh).
#
# The one-time originals snapshot lives in /data/adb/zerion/originals.json and
# is kept across module updates. We restore EVERY property in the snapshot
# (not just the current expected.props), which is exactly "the state from
# before Zerion was first installed".
#
# state.json (module version / generation / manager / action counters) is
# current-session metadata, not ROM state: it is removed here and recreated by
# customize.sh on the next install. originals.json is deliberately KEPT so a
# reinstall still restores the pre-Zerion ROM values (one-time snapshot).

DATA_DIR=/data/adb/zerion
ORIGINALS="$DATA_DIR/originals.json"
STATE_FILE="$DATA_DIR/state.json"

set_prop() { resetprop -n "$1" "$2" 2>/dev/null || setprop "$1" "$2"; }
del_prop() {
  resetprop -n --delete "$1" 2>/dev/null || resetprop -n -d "$1" 2>/dev/null \
    || setprop "$1" ""
}

# Emit "name=value" lines from the flat JSON object originals.json.
# Values are JSON-escaped; keys are safe (validated at install time).
originals_lines() {
  sed -n 's/^[[:space:]]*"\([^"]*\)"[[:space:]]*:[[:space:]]*"\(.*\)",*[[:space:]]*$/\1=\2/p' \
    "$ORIGINALS" 2>/dev/null
}

# JSON unescape for the values produced by customize.sh (\\ and \" only).
json_unescape() {
  printf '%s' "$1" | sed 's/\\\\/\\/g; s/\\"/"/g; s/\\\//\//g'
}

[ -f "$ORIGINALS" ] || {
  echo "Zerion: no originals snapshot at $ORIGINALS; nothing to restore"
  rm -f "$STATE_FILE"
  exit 0
}

originals_lines | while IFS= read -r kv; do
  [ -z "$kv" ] && continue
  name=${kv%%=*}
  value=${kv#*=}
  value=$(json_unescape "$value")
  if [ -z "$value" ]; then
    del_prop "$name"
    echo "Zerion: restored $name -> (unset)"
  else
    set_prop "$name" "$value"
    echo "Zerion: restored $name -> $value"
  fi
done

# Remove current-session state metadata (never the originals snapshot).
rm -f "$STATE_FILE"

echo "Zerion: uninstall restore complete. Changes apply to future dexopt runs; reboot for full effect."
exit 0
