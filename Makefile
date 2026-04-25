LINUX_PACKAGES := discord fuzzel ghostty mise niri nvim tmux waybar zsh
MACOS_PACKAGES := ghostty mise nvim tmux zsh

UNAME_S := $(shell uname -s)

ifeq ($(UNAME_S),Darwin)
PACKAGES ?= $(MACOS_PACKAGES)
else
PACKAGES ?= $(LINUX_PACKAGES)
endif

ALL_PACKAGES := $(LINUX_PACKAGES)

.PHONY: bootstrap install stow uninstall $(ALL_PACKAGES) pi

bootstrap:
	./install.sh

install: $(PACKAGES) pi

stow: install

$(PACKAGES):
	stow $@

# pi uses a custom symlink instead of stow because the target path
# is ~/.pi/agent rather than a direct home-directory mapping
pi:
	@mkdir -p ~/.pi
	@if [ -d ~/.pi/agent ] && [ ! -L ~/.pi/agent ]; then \
		echo "Error: ~/.pi/agent exists as a directory, not a symlink. Remove it manually first." >&2; \
		exit 1; \
	fi
	@ln -sf $(CURDIR)/pi ~/.pi/agent

uninstall:
	@rm -f ~/.pi/agent
	stow -D $(PACKAGES)
