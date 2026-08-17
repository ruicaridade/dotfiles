// Package hooks holds the one-off setup steps a module can ask for after its
// files are linked. Every hook checks the world before acting, so running the
// installer twice is harmless.
package hooks

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// Context is what a hook is allowed to know about the machine.
type Context struct {
	Repo string
	Home string
	GOOS string
}

// Hook is a named post-link step.
type Hook struct {
	Name    string
	Summary string
	Run     func(ctx Context) error
}

var registry = map[string]Hook{
	"omz": {
		Name:    "omz",
		Summary: "clone oh-my-zsh",
		Run: func(ctx Context) error {
			return cloneOnce(
				filepath.Join(ctx.Home, ".oh-my-zsh"),
				"https://github.com/ohmyzsh/ohmyzsh.git",
			)
		},
	},
	"tpm": {
		Name:    "tpm",
		Summary: "clone the tmux plugin manager",
		Run: func(ctx Context) error {
			return cloneOnce(
				filepath.Join(ctx.Home, ".tmux/plugins/tpm"),
				"https://github.com/tmux-plugins/tpm",
			)
		},
	},
	"mise": {
		Name:    "mise",
		Summary: "install mise runtimes",
		Run: func(ctx Context) error {
			if _, err := exec.LookPath("mise"); err != nil {
				fmt.Println("  mise is not on PATH yet, skipping runtime install")
				return nil
			}
			return stream(ctx, "mise", "install")
		},
	},
	"chsh": {
		Name:    "chsh",
		Summary: "make zsh the login shell",
		Run:     changeShell,
	},
	"default-apps": {
		Name:    "default-apps",
		Summary: "set default image and video handlers",
		Run: func(ctx Context) error {
			if ctx.GOOS != "linux" {
				return nil
			}
			script := filepath.Join(ctx.Repo, "scripts/set-default-apps.sh")
			if _, err := os.Stat(script); err != nil {
				return nil
			}
			return stream(ctx, "bash", script)
		},
	},
}

// Lookup finds a hook by the name used in dots.toml.
func Lookup(name string) (Hook, bool) {
	h, ok := registry[name]
	return h, ok
}

// Names lists every known hook.
func Names() []string {
	out := make([]string, 0, len(registry))
	for name := range registry {
		out = append(out, name)
	}
	return out
}

// Run executes the named hooks in order, skipping duplicates. A hook that
// fails is reported but does not stop the others: they are independent, and a
// missing oh-my-zsh should not block the shell change.
func Run(names []string, ctx Context) error {
	seen := map[string]bool{}
	var failed []string
	for _, name := range names {
		if seen[name] {
			continue
		}
		seen[name] = true

		hook, ok := Lookup(name)
		if !ok {
			return fmt.Errorf("unknown hook %q (known: %s)", name, strings.Join(Names(), ", "))
		}
		fmt.Printf("\n→ %s: %s\n", hook.Name, hook.Summary)
		if err := hook.Run(ctx); err != nil {
			fmt.Printf("  failed: %v\n", err)
			failed = append(failed, hook.Name)
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("hooks failed: %s", strings.Join(failed, ", "))
	}
	return nil
}

func cloneOnce(dest, url string) error {
	if _, err := os.Stat(dest); err == nil {
		fmt.Printf("  already present at %s\n", dest)
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	cmd := exec.Command("git", "clone", "--depth", "1", url, dest)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func changeShell(ctx Context) error {
	zsh, err := exec.LookPath("zsh")
	if err != nil {
		fmt.Println("  zsh is not installed yet, skipping")
		return nil
	}
	if strings.Contains(os.Getenv("SHELL"), "zsh") {
		fmt.Println("  zsh is already the login shell")
		return nil
	}
	if runtime.GOOS == "darwin" || ctx.GOOS == "darwin" {
		if !listedInEtcShells(zsh) {
			fmt.Printf("  %s is not in /etc/shells, skipping\n", zsh)
			return nil
		}
	}
	if err := stream(ctx, "chsh", "-s", zsh); err != nil {
		return err
	}
	fmt.Println("  log out and back in for the shell change to take effect")
	return nil
}

func listedInEtcShells(shell string) bool {
	body, err := os.ReadFile("/etc/shells")
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == shell {
			return true
		}
	}
	return false
}

func stream(ctx Context, name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Dir = ctx.Repo
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
