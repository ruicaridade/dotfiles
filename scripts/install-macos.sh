#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

if [[ $EUID -eq 0 ]]; then
    error "This script should not be run as root"
    exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
    error "macOS install requires Homebrew"
    exit 1
fi

BREW_FORMULAS=(
    zsh
    tmux
    neovim
    stow
    mise
)

BREW_CASKS=(
    ghostty
)

info "Updating Homebrew..."
brew update

info "Installing brew formulas..."
brew install "${BREW_FORMULAS[@]}"

info "Installing brew casks..."
brew install --cask "${BREW_CASKS[@]}"

if [[ ! -d "$HOME/.oh-my-zsh" ]]; then
    info "Installing oh-my-zsh..."
    git clone https://github.com/ohmyzsh/ohmyzsh.git "$HOME/.oh-my-zsh"
fi

if [[ -d "$HOME/.tmux/plugins/tpm" ]]; then
    info "Tmux Plugin Manager already installed"
else
    info "Installing Tmux Plugin Manager..."
    git clone https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
fi

if command -v mise >/dev/null 2>&1; then
    info "Installing mise runtimes (bun, node, python)..."
    mise install
fi

info "Stowing macOS dotfiles..."
make -C "$ROOT_DIR" stow

if [[ "$SHELL" != *"zsh"* ]]; then
    target_shell="$(command -v zsh)"
    if grep -qx "$target_shell" /etc/shells; then
        info "Changing default shell to zsh..."
        chsh -s "$target_shell"
        warn "Please log out and back in for shell change to take effect"
    else
        warn "Skipping shell change because $target_shell is not in /etc/shells"
    fi
fi

warn "Ghostty config expects the JetBrains Mono Nerd Font to be available on macOS"

echo ""
info "macOS installation complete!"
info "Next steps:"
echo "  1. Start tmux and press 'prefix + I' to install tmux plugins"
echo "  2. Open neovim to let lazy.nvim install plugins"
echo "  3. Run 'mise install' if runtimes weren't installed"
