#!/usr/bin/env bash

set -euo pipefail

IMAGE_APP="org.gnome.Loupe.desktop"
VIDEO_APP="mpv.desktop"

image_mimes=(
    image/png
    image/jpeg
    image/gif
    image/webp
    image/bmp
    image/tiff
    image/svg+xml
)

video_mimes=(
    video/mp4
    video/x-matroska
    video/webm
    video/quicktime
    video/x-msvideo
    video/mpeg
    video/ogg
)

for mime in "${image_mimes[@]}"; do
    xdg-mime default "$IMAGE_APP" "$mime"
done

for mime in "${video_mimes[@]}"; do
    xdg-mime default "$VIDEO_APP" "$mime"
done

echo "Default image handler: $(xdg-mime query default image/png)"
echo "Default video handler: $(xdg-mime query default video/mp4)"
