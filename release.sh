#!/bin/sh
# Publishes a Mozilla-signed .xpi as a GitHub release and lists it in updates.json,
# so copies of 1.2 and later update themselves. Run it on main once Mozilla has signed the zip:
#   sh release.sh path/to/signed.xpi
set -e
repo=davidkeatscroft/zoho-mail-checker
[ -f "$1" ] || { echo "Usage: sh release.sh path/to/signed.xpi" >&2; exit 1; }
xpi=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd "$(dirname "$0")"

version=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' manifest.json | head -1)
signed_version=$(unzip -p "$xpi" manifest.json | sed -n 's/.*"version": "\(.*\)".*/\1/p' | head -1)
[ "$signed_version" = "$version" ] || { echo "The .xpi is version $signed_version but manifest.json says $version." >&2; exit 1; }
unzip -l "$xpi" | grep -q 'META-INF/mozilla.rsa' || { echo "The .xpi is not signed by Mozilla." >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "Switch to main first." >&2; exit 1; }
git diff --quiet HEAD || { echo "Commit or stash your changes first." >&2; exit 1; }

name="inbox-peek-for-zoho-mail-$version.xpi"
staging=$(mktemp -d)
cp "$xpi" "$staging/$name"
gh release create "v$version" "$staging/$name" --repo "$repo" --target main --title "$version" \
  --notes "Signed by Mozilla. Install this file in Firefox, or wait for Firefox to update an existing copy of 1.2 or later."

hash=$(shasum -a 256 "$xpi" | cut -d' ' -f1)
link="https://github.com/$repo/releases/download/v$version/$name"
perl -MJSON::PP -0777 -e '
  my ($version, $link, $hash) = splice @ARGV, 0, 3;
  my $json = JSON::PP->new->pretty->canonical->indent_length(2);
  my $data = $json->decode(<>);
  my ($id) = keys %{ $data->{addons} };
  push @{ $data->{addons}{$id}{updates} }, { version => $version, update_link => $link, update_hash => "sha256:$hash" };
  print $json->encode($data);
' "$version" "$link" "$hash" updates.json > "$staging/updates.json"
grep -q "\"version\" : \"$version\"" "$staging/updates.json" || { echo "Could not add $version to updates.json." >&2; exit 1; }
mv "$staging/updates.json" updates.json
git commit -q -m "List $version in updates.json" updates.json
git push -q origin main
echo "Released $version: $link"
