// Command dots installs dotfiles: pick the modules you want, look over what
// that changes, then let it link the files and install the packages.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ruicaridade/dotfiles/internal/hooks"
	"github.com/ruicaridade/dotfiles/internal/manifest"
	"github.com/ruicaridade/dotfiles/internal/pkgmgr"
	"github.com/ruicaridade/dotfiles/internal/plan"
	"github.com/ruicaridade/dotfiles/internal/ui"
)

// repoRoot is baked in at build time by bootstrap.sh:
//
//	go build -ldflags "-X main.repoRoot=$PWD"
//
// so dots works from any directory. DOTS_REPO overrides it.
var repoRoot = ""

type options struct {
	all          bool
	dryRun       bool
	linksOnly    bool
	packagesOnly bool
	list         bool
	modules      string
}

func main() {
	if err := run(); err != nil {
		if errors.Is(err, ui.ErrAborted) {
			fmt.Println("nothing changed")
			return
		}
		fmt.Fprintf(os.Stderr, "dots: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var opts options
	flag.BoolVar(&opts.all, "all", false, "select every module for this platform, no prompts")
	flag.BoolVar(&opts.dryRun, "dry-run", false, "report what would change and exit")
	flag.BoolVar(&opts.linksOnly, "links-only", false, "skip package installation and hooks")
	flag.BoolVar(&opts.packagesOnly, "packages-only", false, "install packages, do not touch symlinks")
	flag.BoolVar(&opts.list, "list", false, "list modules and their link status")
	flag.StringVar(&opts.modules, "modules", "", "comma-separated modules to link, no prompts")
	flag.Usage = usage
	flag.Parse()

	repo, err := resolveRepo()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	m, err := manifest.Load(filepath.Join(repo, "dots.toml"))
	if err != nil {
		return err
	}

	goos := runtime.GOOS
	cfg := plan.Config{
		Repo:     repo,
		Home:     home,
		GOOS:     goos,
		Stamp:    time.Now().Format("20060102-150405"),
		Manifest: m,
	}

	mods := m.For(goos)
	if len(mods) == 0 {
		return fmt.Errorf("no modules apply to %s", goos)
	}

	linked, err := plan.Linked(cfg)
	if err != nil {
		return err
	}

	if opts.list {
		return listModules(mods, linked, goos)
	}

	if flag.NArg() > 0 {
		return unlinkCommand(cfg, flag.Args())
	}

	selection, err := chooseModules(opts, mods, linked, goos)
	if err != nil {
		return err
	}

	cfg.Selection = selection
	// Naming modules on the command line is additive. Only the picker, where
	// the boxes show what is linked right now, treats a missing module as a
	// request to remove it.
	cfg.NoUnlink = opts.modules != ""

	p, err := plan.Build(cfg)
	if err != nil {
		return err
	}

	if opts.dryRun {
		return report(p, home)
	}

	// Packages first: linking a config for a tool that is not installed is
	// harmless, but hooks like `mise install` need their binary present.
	if !opts.linksOnly {
		if err := installPackages(p, goos); err != nil {
			return err
		}
	}
	if opts.packagesOnly {
		return nil
	}

	if len(p.Submodules) > 0 {
		if err := initSubmodules(repo, p.Submodules); err != nil {
			return err
		}
		// The submodule trees now exist, so re-plan against reality.
		if p, err = plan.Build(cfg); err != nil {
			return err
		}
	}

	if !opts.all && opts.modules == "" {
		if err := ui.ReviewChanges(p, home); err != nil {
			return err
		}
	}

	res, err := p.Apply()
	if err != nil {
		return err
	}
	fmt.Printf("\n%s\n", describe(res))

	if !opts.linksOnly && len(p.Posts) > 0 {
		if err := hooks.Run(p.Posts, hooks.Context{Repo: repo, Home: home, GOOS: goos}); err != nil {
			return err
		}
	}
	return nil
}

func usage() {
	fmt.Fprint(os.Stderr, `dots — interactive dotfile installer

usage:
  dots                        pick modules, review changes, apply
  dots --all                  select everything for this platform
  dots --modules foot,nvim    link named modules, leave the rest alone
  dots --dry-run              report what would change
  dots --list                 show modules and link status
  dots unlink <module>...     remove a module's symlinks
  dots unlink --all           remove every symlink this repo owns

Unchecking a module in the picker removes its symlinks, since the boxes
reflect what is linked right now. --modules is additive and never removes.

flags:
`)
	flag.PrintDefaults()
}

// resolveRepo finds the dotfiles checkout: DOTS_REPO wins, then the path baked
// in at build time, then the working directory if it holds a manifest.
func resolveRepo() (string, error) {
	candidates := []string{os.Getenv("DOTS_REPO"), repoRoot}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	for _, dir := range candidates {
		if dir == "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, "dots.toml")); err == nil {
			return filepath.Abs(dir)
		}
	}
	return "", fmt.Errorf("cannot find dots.toml; set DOTS_REPO to your dotfiles checkout")
}

func chooseModules(opts options, mods []manifest.Module, linked map[string]bool, goos string) ([]string, error) {
	if opts.modules != "" {
		known := map[string]bool{}
		for _, mod := range mods {
			known[mod.Name] = true
		}
		var out []string
		for _, name := range strings.Split(opts.modules, ",") {
			name = strings.TrimSpace(name)
			if name == "" {
				continue
			}
			if !known[name] {
				return nil, fmt.Errorf("unknown module %q for %s", name, goos)
			}
			out = append(out, name)
		}
		return out, nil
	}

	if opts.all {
		var out []string
		for _, mod := range mods {
			out = append(out, mod.Name)
		}
		return out, nil
	}

	return ui.SelectModules(mods, linked, goos)
}

// unlinkCommand handles `dots unlink <module>...` and `dots unlink --all`.
func unlinkCommand(cfg plan.Config, args []string) error {
	if args[0] != "unlink" {
		return fmt.Errorf("unknown command %q", args[0])
	}
	targets := args[1:]
	if len(targets) == 0 {
		return fmt.Errorf("unlink needs a module name, or --all")
	}

	mods := cfg.Manifest.For(cfg.GOOS)
	keep := map[string]bool{}
	if targets[0] != "--all" && targets[0] != "-all" {
		for _, mod := range mods {
			keep[mod.Name] = true
		}
		for _, name := range targets {
			if !keep[name] {
				return fmt.Errorf("unknown module %q", name)
			}
			keep[name] = false
		}
	}

	// Selecting everything except the targets makes them the unlink set.
	for _, mod := range mods {
		if keep[mod.Name] {
			cfg.Selection = append(cfg.Selection, mod.Name)
		}
	}

	p, err := plan.Build(cfg)
	if err != nil {
		return err
	}
	// Only removals are wanted here, never new links.
	kept := p.Items[:0]
	for _, item := range p.Items {
		if item.Action == plan.ActionUnlink {
			kept = append(kept, item)
		}
	}
	p.Items = kept

	if len(p.Items) == 0 {
		fmt.Println("nothing to unlink")
		return nil
	}

	res, err := p.Apply()
	if err != nil {
		return err
	}
	fmt.Printf("removed %d symlink(s)\n", res.Unlinked)
	return nil
}

func listModules(mods []manifest.Module, linked map[string]bool, goos string) error {
	fmt.Printf("modules for %s\n\n", goos)
	for _, mod := range mods {
		mark := " "
		if linked[mod.Name] {
			mark = "✓"
		}
		fmt.Printf("  %s %-10s %s\n", mark, mod.Name, packageSummary(mod, goos))
	}
	return nil
}

func packageSummary(mod manifest.Module, goos string) string {
	var pkgs []string
	if goos == "darwin" {
		pkgs = append(pkgs, mod.Brew...)
		pkgs = append(pkgs, mod.Cask...)
	} else {
		pkgs = append(pkgs, mod.Pacman...)
		pkgs = append(pkgs, mod.AUR...)
	}
	return strings.Join(pkgs, " ")
}

func installPackages(p *plan.Plan, goos string) error {
	cmds := pkgmgr.Commands(p.Packages, goos)
	if len(cmds) == 0 {
		return nil
	}
	if missing := pkgmgr.Missing(cmds); len(missing) > 0 {
		return fmt.Errorf("missing package manager(s): %s", strings.Join(missing, ", "))
	}
	return pkgmgr.Run(cmds)
}

func initSubmodules(repo string, paths []string) error {
	fmt.Printf("\n→ git submodule update --init %s\n", strings.Join(paths, " "))
	args := append([]string{"submodule", "update", "--init", "--recursive", "--"}, paths...)
	cmd := exec.Command("git", args...)
	cmd.Dir = repo
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func report(p *plan.Plan, home string) error {
	changes := p.Changes()
	if len(changes) == 0 {
		fmt.Println("everything is already in place")
	}
	for _, i := range changes {
		item := p.Items[i]
		line := fmt.Sprintf("  %-12s %s", item.Action, item.Dest)
		if item.Backup != "" {
			line += "  (backup: " + filepath.Base(item.Backup) + ")"
		}
		fmt.Println(line)
	}

	res, err := p.Preview()
	if err != nil {
		return err
	}
	for _, cmd := range pkgmgr.Commands(p.Packages, runtime.GOOS) {
		fmt.Printf("  packages     %s\n", strings.Join(cmd, " "))
	}
	for _, path := range p.Submodules {
		fmt.Printf("  submodule    %s needs init\n", path)
	}
	for _, name := range p.Posts {
		fmt.Printf("  hook         %s\n", name)
	}
	fmt.Printf("\n%s (dry run, nothing written)\n", describe(res))
	return nil
}

func describe(res plan.Result) string {
	parts := []string{fmt.Sprintf("%d linked", res.Linked)}
	if res.BackedUp > 0 {
		parts = append(parts, fmt.Sprintf("%d backed up", res.BackedUp))
	}
	if res.Unlinked > 0 {
		parts = append(parts, fmt.Sprintf("%d unlinked", res.Unlinked))
	}
	if res.UpToDate > 0 {
		parts = append(parts, fmt.Sprintf("%d already current", res.UpToDate))
	}
	if res.Skipped > 0 {
		parts = append(parts, fmt.Sprintf("%d skipped", res.Skipped))
	}
	return strings.Join(parts, ", ")
}
