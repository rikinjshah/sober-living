#!/bin/sh
# Assembles the static site into dist/ for Cloudflare: web/ (intake, operator
# console) plus site/ (home, sign-in, portal, residents, privacy); site/ wins on clashes.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp web/* dist/
cp site/* dist/
