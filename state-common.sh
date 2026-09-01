#!/system/bin/sh
# Zerion device-side state (state.json) helpers.
#
# /data/adb/zerion/state.json is a FLAT JSON object recording durable install
# facts plus action counters:
#
#   schema_version      state schema version
#   module_version      installed Zerion module version (from state.info)
#   generation_id       module generation identifier (from state.info)
#   preset              preset used to build the module (from state.info)
#   target_android      Android version the module was generated for
#   manager             ksu | apatch | magisk (installer env detection)
#   api                 SDK_INT (installer-provided $API or getprop)
#   android             Android major version (ro.build.version.release)
#   installed_at        install timestamp
#   originals_written   "true" once originals.json was snapshotted
#   apply_count         action.sh apply invocations
#   reset_count         action.sh reset invocations
#   last_action         last action name
#   last_action_at      last action timestamp
#
# This file is SOURCED by customize.sh (install time, inside the installer)
# and by action.sh (runtime). It must never call `exit`.

DATA_DIR=${ZERION_DATA_DIR:-/data/adb/zerion}
STATE_FILE="$DATA_DIR/state.json"

# json_escape is defined by customize.sh; provide a fallback for action.sh.
if ! command -v json_escape >/dev/null 2>&1; then
  json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
fi

# Extract a quoted-string "key": "value" from the flat JSON file.
state_str() {  # $1=file $2=key
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*$/\1/p" \
    "$1" 2>/dev/null | head -1
}

# Extract a numeric "key": N from the flat JSON file.
state_num() {  # $1=file $2=key
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*$/\1/p" \
    "$1" 2>/dev/null | head -1
}

# Manager detection: KernelSU sets KSU=true, APatch sets APATCH=true, Magisk
# sets neither (both KSU and APatch also fake MAGISK_VER, so check KSU first).
manager_name() {
  if [ "${KSU:-}" = "true" ]; then echo ksu
  elif [ "${APATCH:-}" = "true" ]; then echo apatch
  else echo magisk; fi
}

# Read the state.info shipped with the module (key=value) into state_info_* vars.
state_info_load() {  # $1 = state.info path
  state_info_module_version=""
  state_info_generation_id=""
  state_info_preset=""
  state_info_target_android=""
  [ -f "$1" ] || return 0
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in
      \#*) continue ;;
    esac
    case "$line" in
      module_version=*) state_info_module_version=${line#module_version=} ;;
      generation_id=*)  state_info_generation_id=${line#generation_id=} ;;
      preset=*)         state_info_preset=${line#preset=} ;;
      target_android=*) state_info_target_android=${line#target_android=} ;;
    esac
  done < "$1"
}

# Write/refresh state.json at INSTALL time. Static facts are re-read from
# state.info + the environment so a module update records the new version,
# generation and manager without losing the action counters.
write_install_state() {  # $1 = state.info path
  local info="$1" manager android api now applyc resetc last_action last_at
  state_info_load "$info"
  manager=$(manager_name)
  android=$(getprop ro.build.version.release 2>/dev/null | cut -d. -f1)
  api=${API:-$(getprop ro.build.version.sdk 2>/dev/null)}
  now=$(date +%Y-%m-%dT%H:%M:%S 2>/dev/null || date 2>/dev/null || echo unknown)

  applyc=0; resetc=0; last_action=""; last_at=""
  if [ -f "$STATE_FILE" ]; then
    applyc=$(state_num "$STATE_FILE" apply_count)
    resetc=$(state_num "$STATE_FILE" reset_count)
    last_action=$(state_str "$STATE_FILE" last_action)
    last_at=$(state_str "$STATE_FILE" last_action_at)
  fi
  mkdir -p "$DATA_DIR" || return 1
  {
    printf '{'
    printf '\n  "schema_version": 1,'
    printf '\n  "module_version": "%s",' "$(json_escape "$state_info_module_version")"
    printf '\n  "generation_id": "%s",' "$(json_escape "$state_info_generation_id")"
    printf '\n  "preset": "%s",' "$(json_escape "$state_info_preset")"
    printf '\n  "target_android": "%s",' "$(json_escape "$state_info_target_android")"
    printf '\n  "manager": "%s",' "$(json_escape "$manager")"
    printf '\n  "api": "%s",' "$(json_escape "$api")"
    printf '\n  "android": "%s",' "$(json_escape "$android")"
    printf '\n  "installed_at": "%s",' "$(json_escape "$now")"
    printf '\n  "originals_written": "true",'
    printf '\n  "apply_count": %d,' "$applyc"
    printf '\n  "reset_count": %d,' "$resetc"
    printf '\n  "last_action": "%s",' "$(json_escape "$last_action")"
    printf '\n  "last_action_at": "%s"' "$(json_escape "$last_at")"
    printf '\n}\n'
  } > "$STATE_FILE" || return 1
  return 0
}

# Refresh state.json after a runtime action: preserve every static field,
# bump the matching counter and stamp last_action/last_action_at.
#
# state.json is normally written at INSTALL time; if it is missing here (e.g.
# deleted by the user or a module update was interrupted), rebuild it from
# state.info first so runtime actions are never recorded into nothing.
refresh_state() {  # $1 = action name (apply|reset|collect|status)
  local action="$1" applyc resetc now
  if [ ! -f "$STATE_FILE" ]; then
    [ -n "${MODDIR:-}" ] || return 1
    write_install_state "$MODDIR/state.info" || return 1
  fi
  applyc=$(state_num "$STATE_FILE" apply_count)
  resetc=$(state_num "$STATE_FILE" reset_count)
  case "$action" in
    apply) applyc=$((applyc + 1)) ;;
    reset) resetc=$((resetc + 1)) ;;
  esac
  now=$(date +%Y-%m-%dT%H:%M:%S 2>/dev/null || date 2>/dev/null || echo unknown)
  {
    printf '{'
    printf '\n  "schema_version": 1,'
    printf '\n  "module_version": "%s",' "$(json_escape "$(state_str "$STATE_FILE" module_version)")"
    printf '\n  "generation_id": "%s",' "$(json_escape "$(state_str "$STATE_FILE" generation_id)")"
    printf '\n  "preset": "%s",' "$(json_escape "$(state_str "$STATE_FILE" preset)")"
    printf '\n  "target_android": "%s",' "$(json_escape "$(state_str "$STATE_FILE" target_android)")"
    printf '\n  "manager": "%s",' "$(json_escape "$(state_str "$STATE_FILE" manager)")"
    printf '\n  "api": "%s",' "$(json_escape "$(state_str "$STATE_FILE" api)")"
    printf '\n  "android": "%s",' "$(json_escape "$(state_str "$STATE_FILE" android)")"
    printf '\n  "installed_at": "%s",' "$(json_escape "$(state_str "$STATE_FILE" installed_at)")"
    printf '\n  "originals_written": "%s",' "$(json_escape "$(state_str "$STATE_FILE" originals_written)")"
    printf '\n  "apply_count": %d,' "$applyc"
    printf '\n  "reset_count": %d,' "$resetc"
    printf '\n  "last_action": "%s",' "$(json_escape "$action")"
    printf '\n  "last_action_at": "%s"' "$(json_escape "$now")"
    printf '\n}\n'
  } > "$STATE_FILE" || return 1
  return 0
}

# Emit the state: snapshot line (single-line JSON) for action.sh collect.
print_state_line() {
  [ -f "$STATE_FILE" ] || return 0
  printf 'state:%s=' "$STATE_FILE"
  tr -d '\n' < "$STATE_FILE"
  printf '\n'
}
