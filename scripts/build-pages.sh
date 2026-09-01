#!/usr/bin/env bash
# Build the static site: no API routes, so it can be served by any static host.
set -euo pipefail
cd "$(dirname "$0")/.."
export STATIC_EXPORT=1
# Only defaulted when unset, not when set to empty: the Railway site is served from the root of
# its own domain and has no base path, while a project page needs one.
export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH-/traintime}"
npm run -s prepare:assets
# Route handlers cannot be statically exported; set them aside for this build only.
mv src/app/api .api-aside
trap 'mv .api-aside src/app/api' EXIT
rm -rf out
npx next build
touch out/.nojekyll
echo "static site in ./out (base path ${NEXT_PUBLIC_BASE_PATH})"
