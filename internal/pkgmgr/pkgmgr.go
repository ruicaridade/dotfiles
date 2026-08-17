// Package pkgmgr turns a resolved package set into the commands that install
// it, and runs them with their output streamed to the terminal.
package pkgmgr

import (
	"fmt"
	"os"
	"os/exec"

	"github.com/ruicaridade/dotfiles/internal/plan"
)

// Commands returns the install commands for goos, skipping any empty source.
// Order matters: official repositories before the AUR, formulas before casks.
func Commands(pkgs plan.Packages, goos string) [][]string {
	var out [][]string
	add := func(prefix []string, names []string) {
		if len(names) == 0 {
			return
		}
		out = append(out, append(append([]string{}, prefix...), names...))
	}

	switch goos {
	case "darwin":
		add([]string{"brew", "install"}, pkgs.Brew)
		add([]string{"brew", "install", "--cask"}, pkgs.Cask)
	default:
		add([]string{"sudo", "pacman", "-S", "--needed", "--noconfirm"}, pkgs.Pacman)
		add([]string{"yay", "-S", "--needed", "--noconfirm"}, pkgs.AUR)
	}
	return out
}

// Missing reports which of the tools the commands need are not on PATH.
func Missing(cmds [][]string) []string {
	var missing []string
	seen := map[string]bool{}
	for _, cmd := range cmds {
		tool := cmd[0]
		if tool == "sudo" && len(cmd) > 1 {
			tool = cmd[1]
		}
		if seen[tool] {
			continue
		}
		seen[tool] = true
		if _, err := exec.LookPath(tool); err != nil {
			missing = append(missing, tool)
		}
	}
	return missing
}

// Run executes the commands in order, streaming their output. It stops at the
// first failure, since a later step usually depends on an earlier one.
func Run(cmds [][]string) error {
	for _, args := range cmds {
		fmt.Printf("\n→ %s\n", join(args))
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("%s: %w", join(args), err)
		}
	}
	return nil
}

func join(args []string) string {
	out := ""
	for i, a := range args {
		if i > 0 {
			out += " "
		}
		out += a
	}
	return out
}
