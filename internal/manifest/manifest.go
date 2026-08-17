// Package manifest reads dots.toml, the declaration of every module the
// installer knows how to link and install.
package manifest

import (
	"fmt"
	"os"
	"sort"

	"github.com/BurntSushi/toml"
)

// LinkSpec overrides the convention-based mapping for a module. Src is
// relative to the module directory, Dest is relative to $HOME. Both "." and
// a trailing path are allowed, so a whole module directory can be pointed at
// an arbitrary target.
type LinkSpec struct {
	Src  string `toml:"src"`
	Dest string `toml:"dest"`
}

// Module is one selectable entry in the installer.
type Module struct {
	// Name is the directory under the repo root and the key in dots.toml.
	Name string `toml:"-"`

	// Platforms limits where the module applies, using runtime.GOOS values
	// ("linux", "darwin"). Empty means every platform.
	Platforms []string `toml:"platforms"`

	// Package sources, applied per platform.
	Pacman []string `toml:"pacman"`
	AUR    []string `toml:"aur"`
	Brew   []string `toml:"brew"`
	Cask   []string `toml:"cask"`

	// Post names hooks to run after linking, resolved by internal/hooks.
	Post []string `toml:"post"`

	// Links replaces the convention-based file mapping when set.
	Links []LinkSpec `toml:"links"`

	// Description is shown next to the module in the picker.
	Description string `toml:"description"`
}

// AppliesTo reports whether the module should be offered on goos.
func (m Module) AppliesTo(goos string) bool {
	if len(m.Platforms) == 0 {
		return true
	}
	for _, p := range m.Platforms {
		if p == goos {
			return true
		}
	}
	return false
}

// Manifest is the parsed dots.toml.
type Manifest struct {
	Modules map[string]Module `toml:"module"`
}

// Load parses the manifest at path.
func Load(path string) (*Manifest, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read manifest: %w", err)
	}
	var m Manifest
	if err := toml.Unmarshal(body, &m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if len(m.Modules) == 0 {
		return nil, fmt.Errorf("%s declares no modules", path)
	}
	for name, mod := range m.Modules {
		mod.Name = name
		for _, l := range mod.Links {
			if l.Src == "" || l.Dest == "" {
				return nil, fmt.Errorf("module %q: link needs both src and dest", name)
			}
		}
		m.Modules[name] = mod
	}
	return &m, nil
}

// Names returns every module name in sorted order.
func (m *Manifest) Names() []string {
	names := make([]string, 0, len(m.Modules))
	for name := range m.Modules {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// For returns the modules that apply to goos, in sorted order.
func (m *Manifest) For(goos string) []Module {
	var out []Module
	for _, name := range m.Names() {
		if mod := m.Modules[name]; mod.AppliesTo(goos) {
			out = append(out, mod)
		}
	}
	return out
}
