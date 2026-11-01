#!/bin/sh
# Packages the extension for upload to addons.mozilla.org, leaving out the tests.
set -e
cd "$(dirname "$0")"
version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json | head -1)
mkdir -p dist
rm -f "dist/zoho-mail-checker-$version.zip"
zip -qr "dist/zoho-mail-checker-$version.zip" manifest.json background.js icons lib options popup -x '*.DS_Store'
echo "dist/zoho-mail-checker-$version.zip"
