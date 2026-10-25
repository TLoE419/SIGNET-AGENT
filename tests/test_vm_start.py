import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class VMStartTest(unittest.TestCase):
    def run_script(self, original_running, stable_exists):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            docker = path / 'docker'
            docker.write_text('''#!/bin/bash
echo "$*" >> "$CALL_LOG"
if [[ $1 == inspect && $* == *signet-vm-20261006* ]]; then
  echo "$ORIGINAL_RUNNING"
elif [[ $1 == inspect ]]; then
  [[ $STABLE_EXISTS == yes ]]
elif [[ $1 == run || $1 == start ]]; then
  echo controlled-container
else
  exit 2
fi
''')
            docker.chmod(0o700)
            env = {**os.environ, 'PATH':str(path) + ':' + os.environ['PATH'],
                   'SIGNET_RUNTIME_PROJECT':str(path), 'SIGNET_SSH_PORT':'2226',
                   'CALL_LOG':str(path/'calls'), 'ORIGINAL_RUNNING':original_running,
                   'STABLE_EXISTS':stable_exists}
            (path / 'vm').mkdir()
            result = subprocess.run(['bash',str(Path(__file__).resolve().parents[1]/'scripts/advanced/start_scientific_vm.sh')],
                                    env=env,capture_output=True,text=True)
            return result, (path/'calls').read_text()

    def test_original_disk_cannot_be_shared_with_running_original_vm(self):
        result, calls = self.run_script('true','no')
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('run ',calls)
        self.assertNotIn('start ',calls)

    def test_existing_repair_reuses_container_without_recreating_disk(self):
        result, calls = self.run_script('false','yes')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('start signet-vm-stable-20261020',calls)
        self.assertNotIn('run ',calls)

    def test_new_container_uses_single_thread_and_overlay(self):
        result, calls = self.run_script('false','no')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertIn('tcg,thread=single',calls)
        self.assertIn('file=/work/vm/signet-stable-20261020.qcow2',calls)
        self.assertNotIn('thread=multi',calls)
        self.assertNotIn('rm signet-vm',calls)


if __name__ == '__main__':
    unittest.main()
