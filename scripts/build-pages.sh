#!/usr/bin/env bash
# Build the static site for GitHub Pages: in-browser tracking, no API routes.
set -euo pipefail
cd "$(dirname "$0")/.."
export STATIC_EXPORT=1
export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH:-/traintime}"
npm run -s prepare:assets
# Route handlers cannot be statically exported; set them aside for this build only.
mv src/app/api .api-aside
trap 'mv .api-aside src/app/api' EXIT
rm -rf out
npx next build
touch out/.nojekyll
echo "static site in ./out (base path ${NEXT_PUBLIC_BASE_PATH})"
