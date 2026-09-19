#!/usr/bin/env bash
set -euo pipefail

# macOS displays the full icon canvas in the Dock and app switcher. Keep the
# existing artwork at 82% of the canvas so it matches other macOS app icons.
desktop_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_icon="$desktop_dir/src-tauri/icons/icon.png"
output_icon="$desktop_dir/src-tauri/icons/icon.icns"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

magick "$source_icon" -resize 82% -background none -gravity center \
  -extent 512x512 -depth 8 "PNG32:$work_dir/mac-icon.png"
(cd "$desktop_dir" && bunx --no-install tauri icon "$work_dir/mac-icon.png" --output "$work_dir/generated")
cp "$work_dir/generated/icon.icns" "$output_icon"
