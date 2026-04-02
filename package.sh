#!/bin/sh

set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DIST_DIR="$ROOT_DIR/dist"
OUTPUT_FILE="$DIST_DIR/video-arrow-key-rebind.zip"

mkdir -p "$DIST_DIR"
rm -f "$OUTPUT_FILE"

cd "$ROOT_DIR"
zip -r "$OUTPUT_FILE" manifest.json src README.md -x '*/.DS_Store'

printf 'Created %s\n' "$OUTPUT_FILE"