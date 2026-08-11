#!/usr/bin/env bash
#
# Collects the web layer into ios/Generated/, which is what the Xcode target
# actually bundles. The twin of Gradle's `bundleWebAssets` task, and it exists
# for the same reason: the shell, the injected content scripts and the shared
# core all live where the extension and the tests can see them, and copying is
# the only way to get them into an .ipa without forking them.
#
# Run before every build (project.yml wires it as a pre-build script). It is a
# clean sync, not a merge: a file deleted upstream must disappear from the app
# too, or a stale script keeps being injected long after it stopped existing.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="$repo/ios/Generated"

rm -rf "$out"
mkdir -p "$out/www" "$out/inject" "$out/rules"

# The app itself: library, folders, search, account. Same files the Android
# shell loads, and the same ones a browser can open directly for debugging.
cp -R "$repo/mobile/www/." "$out/www/"

# What gets injected into scan sites. chrome-shim.js first because it is what
# makes the rest of these run unchanged; everything after it is copied verbatim
# out of the extension, no mobile fork.
cp "$repo/mobile/inject/chrome-shim.js" "$out/inject/"
cp "$repo/shared/series-match.js"       "$out/inject/"
cp "$repo/shared/site-rules.js"         "$out/inject/"
for f in popup-guard.js detect.js library-modal.js reader.js reader.css; do
  cp "$repo/extension/content/$f" "$out/inject/"
done

# Ad blocking. Both files are generated from shared/adblock-list.json by
# scripts/build-adblock.mjs — blocker-rules.json is the WKContentRuleList input,
# adblock.json the extension's declarativeNetRequest list, and Android parses
# hostnames back out of the latter. Edit the list, not these.
cp "$repo/ios/Resources/blocker-rules.json" "$out/"
cp "$repo/extension/rules/adblock.json"     "$out/rules/"
cp "$repo/shared/detection-rules.json"      "$out/rules/"

echo "bundled web assets -> $out"
