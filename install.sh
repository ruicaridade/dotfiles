#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
    Darwin)
        exec bash "$SCRIPT_DIR/scripts/install-macos.sh"
        ;;
    Linux)
        exec bash "$SCRIPT_DIR/scripts/install-arch.sh"
        ;;
    *)
        printf 'Unsupported operating system: %s\n' "$(uname -s)" >&2
        exit 1
        ;;
esac
