#!/system/bin/sh
# Zerion service.sh — intentionally empty.
#
# Properties are applied by the root framework (Magisk post-fs-data /
# KernelSU & APatch late_load) from system.prop BEFORE zygote starts, which is
# the correct timing for pm.dexopt.* and dalvik.vm.*. A late_start service
# script runs AFTER boot-time dexopt decisions and is therefore not useful for
# this module's current scope. Reserved for future on-device logic.
# Runs as a child process, so `exit` is fine here.
exit 0
