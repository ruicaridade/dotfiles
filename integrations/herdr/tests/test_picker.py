"""Exercise the real curses picker through a terminal, with Herdr at the boundary."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

PLUGIN = Path(__file__).resolve().parents[1] / 'plugins/pin-worktrees/plugin.py'


class PickerFlow(unittest.TestCase):
    def run_picker(self, operation):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            binary = directory / 'herdr'
            fixture = {'workspaces': [
                {'workspace_id': 'one', 'label': 'Feature One', 'worktree': {'checkout_path': '/work/one'}},
                {'workspace_id': 'two', 'label': 'Feature Two', 'worktree': {'checkout_path': '/work/two'}},
                {'workspace_id': 'three', 'label': 'Not pinned', 'worktree': {'checkout_path': '/work/three'}}],
                'focused_workspace_id': 'one'}
            binary.write_text('''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
if sys.argv[1:]==['api','snapshot']:
 print(json.dumps({'result':{'snapshot':json.loads(os.environ['FIXTURE'])}}))
elif sys.argv[1:3]==['workspace','focus']:
 Path(os.environ['FOCUSED']).write_text(sys.argv[3])
 print('{}')
else:
 sys.exit(2)
''')
            binary.chmod(0o755)
            env = dict(os.environ, HERDR_BIN_PATH=str(binary), HERDR_PLUGIN_STATE_DIR=tmp,
                       FIXTURE=json.dumps(fixture), FOCUSED=str(directory/'focused'), TERM='xterm-256color')
            for path in ['/work/one', '/work/two']:
                subprocess.run([sys.executable,str(PLUGIN),'toggle',path],env=env,check=True,capture_output=True)
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH',24,80,0,0))
            process = subprocess.Popen([sys.executable,str(PLUGIN),'panel'],env=env,
                                       stdin=slave,stdout=slave,stderr=slave,start_new_session=True)
            os.close(slave)
            output = b''
            def pump(seconds=.25):
                nonlocal output
                end=time.monotonic()+seconds
                while time.monotonic()<end:
                    if select.select([master],[],[],max(0,end-time.monotonic()))[0]:
                        try:
                            output += os.read(master,65536)
                        except OSError:
                            break
            def send(keys):
                os.write(master,keys)
                pump()
            try:
                for _ in range(15):
                    pump(.2)
                    if b'Feature Two' in output:
                        break
                self.assertIn(b'Feature Two',output)
                self.assertNotIn(b'Not pinned',output)
                self.assertNotIn(b'SPACES',output)
                operation(send,directory,pump)
                process.wait(timeout=4)
                self.assertEqual(process.returncode,0,output.decode(errors='replace'))
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                os.close(master)

    def test_keyboard_reorder_then_control_number_focuses_new_first_pin(self):
        def flow(send,directory,pump):
            send(b'J')
            self.assertEqual(json.loads((directory/'pins.json').read_text())['pins'], ['/work/two','/work/one'])
            send(b'\x1b[49;5u')
            self.assertEqual((directory/'focused').read_text(),'two')
        self.run_picker(flow)

    def test_mouse_drag_reorders_without_changing_spaces_then_click_focuses(self):
        def flow(send,directory,pump):
            send(b'\x1b[<0;4;4M')
            send(b'\x1b[<32;4;5M')
            send(b'\x1b[<0;4;5m')
            self.assertEqual(json.loads((directory/'pins.json').read_text())['pins'], ['/work/two','/work/one'])
            self.assertFalse((directory/'focused').exists())
            send(b'\x1b[<0;4;4M')
            send(b'\x1b[<0;4;4m')
            self.assertEqual((directory/'focused').read_text(),'two')
        self.run_picker(flow)

    def test_herdr_extended_control_p_toggles_selected_pin(self):
        def flow(send,directory,pump):
            send(b'\x1b[112;5u')
            self.assertEqual(json.loads((directory/'pins.json').read_text())['pins'], ['/work/two'])
            send(b'\x1b')
        self.run_picker(flow)
