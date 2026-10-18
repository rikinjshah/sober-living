#!/bin/sh
# Builds the full static site for upload: web/ (intake, operator console)
# plus site/ (home page, sign-in, portal, residents, privacy). site/ wins on
# name clashes, so site/index.html replaces the old redirect to /apply.
# Output: sober-living-site.zip, uploaded to Cloudflare the same way as before.
set -e
cd "$(dirname "$0")"
rm -rf dist && mkdir dist
cp web/* dist/
cp -R site/. dist/
rm -f sober-living-site.zip
(cd dist && zip -qr ../sober-living-site.zip .)
rm -rf dist
echo "Built sober-living-site.zip"
