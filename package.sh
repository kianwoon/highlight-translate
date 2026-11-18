#!/usr/bin/env bash
# Package the extension for a Chrome Web Store submission.
#
# Ships ONLY the files the extension loads at runtime: everything the manifest
# references, plus the options and privacy pages it links. Repo material (docs,
# README, logos, design assets, earlier zips, tooling state) is deliberately
# left out — the store rejects nothing for it, but every extra byte is reviewed.
#
# The version is read from manifest.json, so the archive name always matches
# what the store will see. Usage: ./package.sh  (override with DIST_DIR=…)
set -euo pipefail

cd "$(dirname "$0")"

DIST_DIR="${DIST_DIR:-dist}"
MANIFEST="manifest.json"

VERSION="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).version)")"
NAME="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$MANIFEST','utf8')).name.toLowerCase().replace(/[^a-z0-9]+/g,'-'))")"

# Runtime file set. Keep in sync with manifest.json: content_scripts,
# web_accessible_resources, options_ui, icons.
FILES=(
  "$MANIFEST"
  background.js
  content.js
  content-main.js
  content.css
  options.html
  options.js
  privacy-policy.html
  icons/icon16.png
  icons/icon32.png
  icons/icon48.png
  icons/icon128.png
)

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "package.sh: missing $f" >&2; exit 1; }
done

# Every content script and the manifest must parse before anything is shipped.
for js in background.js content.js content-main.js options.js; do
  node --check "$js" >/dev/null
done
node -e "JSON.parse(require('fs').readFileSync('$MANIFEST','utf8'))" >/dev/null

mkdir -p "$DIST_DIR"
ARCHIVE="$DIST_DIR/$NAME-$VERSION-cws.zip"
rm -f "$ARCHIVE"
zip -q -X "$ARCHIVE" "${FILES[@]}"

echo "packaged $ARCHIVE ($(unzip -l "$ARCHIVE" | tail -1 | awk '{print $2}') files, $(wc -c <"$ARCHIVE" | tr -d ' ') bytes)"
