#!/usr/bin/env bash
#
# Slice a 1024x1024 PNG into the 10 macOS AppIcon sizes and drop them into
# desktop/macos/Assets.xcassets/AppIcon.appiconset/.
#
# Usage:
#   scripts/update-app-icon.sh [path-to-1024.png]
#
# Defaults to ~/Documents/verso-icon.png — the path Icon Composer's
# File → Export… is configured to write to in our workflow.
#
# After running, do Clean Build Folder + Run in Xcode (⇧⌘K, ⌘R).
set -euo pipefail

SRC="${1:-$HOME/Documents/verso-icon.png}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DST="$ROOT/desktop/macos/Assets.xcassets/AppIcon.appiconset"

if [[ ! -f "$SRC" ]]; then
  echo "error: source PNG not found at $SRC" >&2
  echo "export from Icon Composer (File → Export → PNG, 1024x1024) first." >&2
  exit 1
fi

read -r W H < <(sips -g pixelWidth -g pixelHeight "$SRC" | awk '/pixel(Width|Height)/ {print $2}' | xargs)
if [[ "$W" != "1024" || "$H" != "1024" ]]; then
  echo "warning: expected a 1024x1024 PNG, got ${W}x${H} — slicing will still work but quality may suffer." >&2
fi

mkdir -p "$DST"

# 10 macOS slot sizes — kept as (pixel-dimension filename) pairs.
slot () {
  local size="$1"; local name="$2"
  sips -z "$size" "$size" "$SRC" --out "$DST/$name" >/dev/null
}

slot 16   icon_16x16.png
slot 32   icon_16x16@2x.png
slot 32   icon_32x32.png
slot 64   icon_32x32@2x.png
slot 128  icon_128x128.png
slot 256  icon_128x128@2x.png
slot 256  icon_256x256.png
slot 512  icon_256x256@2x.png
slot 512  icon_512x512.png
cp "$SRC" "$DST/icon_512x512@2x.png"

cat > "$DST/Contents.json" <<'JSON'
{
  "images" : [
    { "idiom" : "mac", "scale" : "1x", "size" : "16x16",   "filename" : "icon_16x16.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "16x16",   "filename" : "icon_16x16@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "32x32",   "filename" : "icon_32x32.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "32x32",   "filename" : "icon_32x32@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "128x128", "filename" : "icon_128x128.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "128x128", "filename" : "icon_128x128@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "256x256", "filename" : "icon_256x256.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "256x256", "filename" : "icon_256x256@2x.png" },
    { "idiom" : "mac", "scale" : "1x", "size" : "512x512", "filename" : "icon_512x512.png" },
    { "idiom" : "mac", "scale" : "2x", "size" : "512x512", "filename" : "icon_512x512@2x.png" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

echo "wrote 10 PNGs + Contents.json to $DST"
echo "next: in Xcode, Clean Build Folder (⇧⌘K) then Run (⌘R)."
