#!/usr/bin/env python3
"""Install the stock-Herdr pins plugin and host-only keybindings on Omarchy."""
from datetime import datetime
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parent
BEGIN = '# BEGIN dotfiles pinned worktrees'
END = '# END dotfiles pinned worktrees'


def configure(text):
    text = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?', '', text, flags=re.S)
    section = re.search(r'(?ms)^\[keys\]\n(.*?)(?=^\[|\Z)', text)
    if not section:
        raise ValueError('Herdr config needs a [keys] section')
    body = section.group(1)
    entry = 'workspace_picker = "prefix+w" # Stock sidebar navigation'
    body = re.sub(r'(?m)^workspace_picker\s*=.*$', entry, body) if re.search(r'(?m)^workspace_picker\s*=', body) else entry+'\n'+body
    previous = 'previous_tab = "prefix+alt+p" # prefix+p opens pins'
    body = re.sub(r'(?m)^previous_tab\s*=.*$', previous, body) if re.search(r'(?m)^previous_tab\s*=', body) else previous+'\n'+body
    text = text[:section.start(1)] + body + text[section.end(1):]
    block = ['\n'+BEGIN]
    for key, action, description in [('prefix+p', 'open', 'Pinned worktrees'), ('prefix+ctrl+p', 'toggle', 'Pin/unpin active workspace')] + [(f'ctrl+{i}', f'select-{i}', f'Switch to pin {i}') for i in range(1,10)]:
        block += ['[[keys.command]]', f'key = "{key}"', 'type = "plugin_action"',
                  f'command = "rui.pin-worktrees.{action}"', f'description = "{description}"', '']
    text = text.rstrip() + '\n' + '\n'.join(block) + END+'\n'
    tomllib.loads(text)
    return text


def main():
    if sys.platform != 'linux' or not shutil.which('omarchy-theme-color'):
        raise SystemExit('This integration is for Linux with Omarchy.')
    config = Path(os.environ.get('HERDR_CONFIG_PATH', Path.home()/'.config/herdr/config.toml'))
    old = config.read_text()
    text = configure(old)
    if text != old:
        backup = Path.home()/'.local/state/dotfiles-backups'/datetime.now().strftime('herdr-pins-%Y%m%d-%H%M%S')
        backup.mkdir(parents=True,exist_ok=True)
        shutil.copy2(config,backup/'config.toml')
        with tempfile.NamedTemporaryFile(mode='w',dir=config.parent,delete=False) as out:
            out.write(text)
            temporary=out.name
        # Detach a portable symlink, preserving configs on other platforms.
        os.replace(temporary,config)
    subprocess.run(['herdr','plugin','link',str(ROOT/'plugins/pin-worktrees')],check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['herdr','server','reload-config'],check=True)


if __name__ == '__main__':
    main()
