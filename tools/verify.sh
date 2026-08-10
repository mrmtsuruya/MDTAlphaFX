#!/usr/bin/env bash
# Linux verification harness for MDTAlphaFX.
# The repo lives on a Windows mount: node_modules holds win32 native bindings and
# some Windows-created files cannot be unlinked from Linux. So we build from a
# sandbox copy with per-entry symlinked node_modules and local build-cache dirs.
set -e
P="${MDT_REPO:-/sessions/exciting-kind-sagan/mnt/LovableMDTAlphaFX}"
B="${MDT_SANDBOX:-/tmp/mdt-build}"
rm -rf "$B"; mkdir -p "$B"
cd "$P"
tar --exclude='./node_modules' --exclude='./.git' --exclude='./.output' \
    --exclude='./.wrangler' --exclude='./.tanstack' --exclude='./.freebuff' \
    -cf - . | (cd "$B" && tar -xf -)
mkdir -p "$B/node_modules"
cd "$P/node_modules"
for e in * .[!.]*; do
  [ -e "$e" ] || continue
  case "$e" in .nitro|.vite|.cache) continue;; esac
  ln -sfn "$P/node_modules/$e" "$B/node_modules/$e"
done
mkdir -p "$B/node_modules/.nitro" "$B/node_modules/.vite" "$B/node_modules/.cache"
cd "$B"
echo "--- tests ---";     npm test --silent 2>&1 | grep -E '^# (tests|pass|fail)'
echo "--- typecheck ---"; npx tsc --noEmit && echo "clean"
echo "--- build ---";     npm run build 2>&1 | tail -3
