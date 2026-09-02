#!/usr/bin/env bash
# Build the static site: no API routes, so it can be served by any static host.
set -euo pipefail
cd "$(dirname "$0")/.."
export STATIC_EXPORT=1
# Only defaulted when unset, not when set to empty: the Railway site is served from the root of
# its own domain and has no base path, while a project page needs one.
export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH-/traintime}"
npm run -s prepare:assets

# Route handlers cannot be statically exported, so they are set aside for this build only — which
# means there is a window where the tree is missing a directory. A full disk closed that window on
# the wrong side once: the build failed, the trap fired, and the rename back failed too, leaving
# the repository without its API route and nothing said so. So: refuse to start without room, and
# if the restore ever does fail, say exactly what to run.
free_kb=$(df -k . | awk 'NR==2 {print $4}')
if [ "$free_kb" -lt 524288 ]; then
  echo "only $((free_kb / 1024)) MB free — a static export needs more room than that." >&2
  echo "free some space first; this build moves src/app/api aside and must be able to move it back." >&2
  exit 1
fi
restore() {
  [ -d .api-aside ] || return 0
  mv .api-aside src/app/api && return 0
  echo "COULD NOT RESTORE src/app/api — run: mv .api-aside src/app/api" >&2
  return 1
}
trap restore EXIT
mv src/app/api .api-aside
rm -rf out
npx next build
touch out/.nojekyll
echo "static site in ./out (base path ${NEXT_PUBLIC_BASE_PATH})"
