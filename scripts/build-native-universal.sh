#!/bin/sh
# Builds the native input helper for Apple Silicon and Intel Macs in one binary, for the npm package.
set -e
tmp=$(mktemp -d)
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13" native/Desktop.swift -o "$tmp/$arch" \
    -framework Cocoa -framework ApplicationServices -framework Vision
done
lipo -create "$tmp/arm64" "$tmp/x86_64" -output native/desktop-helper
rm -rf "$tmp"
lipo -info native/desktop-helper
