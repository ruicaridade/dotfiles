package pkgmgr_test

import (
	"reflect"
	"testing"

	"github.com/ruicaridade/dotfiles/internal/pkgmgr"
	"github.com/ruicaridade/dotfiles/internal/plan"
)

func TestCommandsPerPlatform(t *testing.T) {
	tests := []struct {
		name string
		goos string
		pkgs plan.Packages
		want [][]string
	}{
		{
			name: "arch splits official and aur",
			goos: "linux",
			pkgs: plan.Packages{Pacman: []string{"foot", "tmux"}, AUR: []string{"niri"}},
			want: [][]string{
				{"sudo", "pacman", "-S", "--needed", "--noconfirm", "foot", "tmux"},
				{"yay", "-S", "--needed", "--noconfirm", "niri"},
			},
		},
		{
			name: "macos splits formulas and casks",
			goos: "darwin",
			pkgs: plan.Packages{Brew: []string{"tmux"}, Cask: []string{"ghostty"}},
			want: [][]string{
				{"brew", "install", "tmux"},
				{"brew", "install", "--cask", "ghostty"},
			},
		},
		{
			name: "an empty source produces no command",
			goos: "linux",
			pkgs: plan.Packages{Pacman: []string{"zsh"}},
			want: [][]string{
				{"sudo", "pacman", "-S", "--needed", "--noconfirm", "zsh"},
			},
		},
		{
			name: "nothing selected runs nothing",
			goos: "linux",
			pkgs: plan.Packages{},
			want: nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := pkgmgr.Commands(tc.pkgs, tc.goos)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("Commands() =\n  %v\nwant\n  %v", got, tc.want)
			}
		})
	}
}
