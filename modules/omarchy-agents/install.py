#!/usr/bin/env python3
"""Install the user-owned usage widget without changing packaged Omarchy files."""
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    if sys.platform != 'linux' or not shutil.which('omarchy-shell'):
        raise SystemExit('This widget is for Linux with Omarchy.')
    home = Path.home()
    root = Path(__file__).resolve().parent
    source = root/'.config/omarchy/plugins/ruicaridade.agents'
    target = home/'.config/omarchy/plugins/ruicaridade.agents'
    config = home/'.config/omarchy/shell.json'
    settings = json.loads(config.read_text())
    layout = settings.setdefault('bar', {}).setdefault('layout', {})
    found = False
    for entries in layout.values():
        for index, entry in enumerate(entries):
            if entry.get('id') in ('omarchy.agents', 'ruicaridade.agents'):
                entries[index] = {'id': 'ruicaridade.agents'}
                found = True
    if not found:
        layout.setdefault('center', []).append({'id': 'ruicaridade.agents'})
    backup = home/'.local/state/dotfiles-backups'/datetime.now().strftime('omarchy-usage-%Y%m%d-%H%M%S')
    backup.mkdir(parents=True,exist_ok=True)
    shutil.copy2(config, backup/'shell.json')
    if not target.is_symlink() or target.resolve() != source:
        if target.is_symlink():
            target.unlink()
        elif target.exists():
            shutil.move(target,backup/'ruicaridade.agents')
        target.parent.mkdir(parents=True,exist_ok=True)
        target.symlink_to(source,target_is_directory=True)
    with tempfile.NamedTemporaryFile(mode='w',dir=config.parent,delete=False) as out:
        out.write(json.dumps(settings,indent=2)+'\n')
        temporary=out.name
    os.replace(temporary,config)
    # QML's component cache can retain the old plugin after a directory is relinked.
    subprocess.run(['omarchy','restart','shell'],check=True)


if __name__ == '__main__':
    main()
