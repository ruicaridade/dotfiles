LINUX_PACKAGES := discord fuzzel ghostty mise niri nvim tmux waybar zsh
MACOS_PACKAGES := ghostty mise nvim tmux zsh

UNAME_S := $(shell uname -s)

ifeq ($(UNAME_S),Darwin)
PACKAGES ?= $(MACOS_PACKAGES)
else
PACKAGES ?= $(LINUX_PACKAGES)
endif

ALL_PACKAGES := $(LINUX_PACKAGES)

.PHONY: bootstrap install stow uninstall $(ALL_PACKAGES)

bootstrap:
	./install.sh

install: $(PACKAGES)

stow: install

$(PACKAGES):
	stow $@

uninstall:
	stow -D $(PACKAGES)
