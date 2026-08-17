#!/usr/bin/env bash
#
# Builds the dots installer and hands over to it. This is the only step that
# has to work on a machine with nothing set up yet, so it stays small and
# stays bash. Everything after this lives in Go.
#
# Go is installed through mise rather than the system package manager, so the
# toolchain is managed in exactly one place. mise is the single bootstrap
# dependency; dots links its config and installs the rest of the runtimes.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${DOTS_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/dots"
GO_VERSION="${DOTS_GO_VERSION:-latest}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[INFO]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

if [[ $EUID -eq 0 ]]; then
    error "Do not run this as root"
    exit 1
fi

install_mise() {
    if command -v mise >/dev/null 2>&1; then
        return
    fi
    info "mise is not installed, installing it first..."
    case "$(uname -s)" in
        Linux)
            if ! command -v pacman >/dev/null 2>&1; then
                error "Expected an Arch system with pacman; install mise manually and re-run"
                exit 1
            fi
            sudo pacman -S --needed --noconfirm mise
            ;;
        Darwin)
            if ! command -v brew >/dev/null 2>&1; then
                error "Homebrew is required to bootstrap on macOS"
                exit 1
            fi
            brew install mise
            ;;
        *)
            error "Unsupported operating system: $(uname -s)"
            exit 1
            ;;
    esac
}

install_mise

# mise exec fetches the toolchain if needed and puts it on PATH for one
# command, so nothing has to be activated in this shell. The download is
# cached, which makes the later `mise install` a no-op for Go.
info "Building dots with Go $GO_VERSION via mise..."
mkdir -p "$BIN_DIR"
(cd "$REPO_DIR" && mise exec "go@$GO_VERSION" -- \
    go build -ldflags "-X main.repoRoot=$REPO_DIR" -o "$BIN" ./cmd/dots)

info "Installed $BIN"
if ! command -v dots >/dev/null 2>&1; then
    warn "$BIN_DIR is not on your PATH; add it to your shell profile"
fi

info "Handing over to dots..."
exec "$BIN" "$@"
