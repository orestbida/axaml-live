#!/bin/bash
# Packages the extension (run build.sh first). Usage: package.sh [output directory]
set -e
out="${1:-../../output/}"
mkdir -p "$out"
npx --yes @vscode/vsce package -o "$out"
