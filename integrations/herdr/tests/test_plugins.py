import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'plugins'
USAGE = Path(__file__).resolve().parents[3] / 'modules/omarchy-agents/.config/omarchy/plugins/ruicaridade.agents'

class PinsFlow(unittest.TestCase):
    def test_pin_reorder_unpin_and_restore(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, HERDR_PLUGIN_STATE_DIR=tmp)
            def run(*args):
                result = subprocess.run([sys.executable, str(ROOT / 'pin-worktrees/plugin.py'), *args],
                                        env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)['pins']
            self.assertEqual(run('snapshot'), [])
            self.assertEqual(run('toggle', '/work/one'), ['/work/one'])
            run('toggle', '/work/two')
            run('toggle', '/work/three')
            self.assertEqual(run('move', '/work/three', '/work/one'),
                             ['/work/three', '/work/one', '/work/two'])
            self.assertEqual(run('snapshot'), ['/work/three', '/work/one', '/work/two'])
            self.assertEqual(run('move', '/work/three', '/work/two'),
                             ['/work/one', '/work/two', '/work/three'])
            self.assertEqual(run('toggle', '/work/two'), ['/work/one', '/work/three'])


class UsageFlow(unittest.TestCase):
    def test_codex_handles_notifications_and_response_in_one_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            executable = Path(tmp) / 'codex'
            executable.write_text('''#!/usr/bin/env python3
import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request['method']=='initialize':
        print(json.dumps({'id':request['id'],'result':{}}),flush=True)
    elif request['method']=='account/rateLimits/read':
        result={'rateLimits':{'secondary':{'usedPercent':59,'windowDurationMins':10080,'resetsAt':1893456000}}}
        sys.stdout.write(json.dumps({'method':'account/updated'})+'\\n'+json.dumps({'id':request['id'],'result':result})+'\\n')
        sys.stdout.flush()
''')
            executable.chmod(0o755)
            result = subprocess.run([sys.executable, str(USAGE / 'codex.py')],
                env=dict(os.environ, PATH=tmp + os.pathsep + os.environ['PATH']),
                capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            limits = json.loads(result.stdout)['limits']
            self.assertEqual(limits[0]['percent'], 0.59)
            self.assertEqual(limits[0]['label'], 'Weekly (7-day)')

    def test_usage_preserves_last_known_limits_and_marks_stale(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            collector = directory / 'omarchy-agent-usage-claude'
            collector.write_text('''#!/usr/bin/env python3
import json,os
if os.environ.get('FAIL_CLAUDE'):
 print(json.dumps({'limits': [], 'usageStatusText': 'Offline'}))
else:
 print(json.dumps({'limits': [{'label':'Session (5-hour)','percent':0.2,'resetsAt':'2099-01-01T00:00:00Z'}]}))
''')
            collector.chmod(0o755)
            # No Codex available; it must be shown explicitly as unavailable.
            codex = directory / 'codex'
            codex.write_text('#!/bin/sh\nexit 1\n')
            codex.chmod(0o755)
            env = dict(os.environ, OMARCHY_AGENT_USAGE_STATE_DIR=str(directory / 'state'),
                       XDG_CACHE_HOME=str(directory/'cache'),
                       PATH=tmp + os.pathsep + os.environ['PATH'])
            def run(**extra):
                result = subprocess.run([sys.executable, str(USAGE / 'usage.py'), 'snapshot', '--force'],
                    env=dict(env, **extra), capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                return json.loads(result.stdout)['providers']
            fresh = run()
            self.assertEqual(fresh[0]['limits'][0]['percent'], 0.2)
            self.assertFalse(fresh[0]['stale'])
            stale = run(FAIL_CLAUDE='1')
            self.assertTrue(stale[0]['stale'])
            self.assertEqual(stale[0]['limits'][0]['percent'], 0.2)
            self.assertEqual(stale[1]['limits'], [])
            self.assertTrue(stale[1]['error'])


if __name__ == '__main__':
    unittest.main()
