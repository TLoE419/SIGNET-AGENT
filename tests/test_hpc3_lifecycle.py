"""Local popup lifecycle regressions. No SSH host or credential prompt is contacted."""
import os
from pathlib import Path
import subprocess
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import hpc3_ssh as ssh


class PopupLifecycleTest(unittest.TestCase):
    def exercise_stop(self, cancel):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ready, stopped = root / 'ready', root / 'stopped'
            # A real subprocess and descendant stand in for ssh and its native dialog.
            child = ('import signal,time,pathlib,sys; '
                     'signal.signal(signal.SIGTERM,lambda *_:(pathlib.Path(sys.argv[1]).write_text("stopped"),sys.exit(0))); '
                     'pathlib.Path(sys.argv[2]).write_text("ready"); time.sleep(30)')
            parent = ('import subprocess,sys,time; '
                      'p=subprocess.Popen([sys.executable,"-c",sys.argv[1],sys.argv[2],sys.argv[3]]); '
                      'time.sleep(30)')
            event = threading.Event()
            processes = []
            original = subprocess.Popen

            def start(*args, **kwargs):
                process = original(*args, **kwargs)
                processes.append(process)
                return process

            def cancel_when_ready():
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    event.wait(0.01)
                event.set()

            thread = threading.Thread(target=cancel_when_ready) if cancel else None
            if thread:
                thread.start()
            try:
                with patch.object(ssh.subprocess, 'Popen', start):
                    code, message = ssh.popup_login(
                        [sys.executable, '-c', parent, child, str(stopped), str(ready)],
                        dict(os.environ), event, 5 if cancel else 1)
                self.assertEqual(code, ssh.CANCELLED)
                self.assertIn('cancelled' if cancel else 'timed out', message)
                self.assertIsNotNone(processes[0].poll())
                deadline = time.monotonic() + 2
                while not stopped.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), 'child did not reach the simulated dialog')
                self.assertTrue(stopped.exists(), 'dialog descendant did not receive termination')
            finally:
                event.set()
                if thread:
                    thread.join(6)
                for process in processes:
                    if process.poll() is None:
                        ssh.stop_login_process(process)

    def test_timeout_stops_popup_process_and_dialog_descendant(self):
        self.exercise_stop(cancel=False)

    def test_cancellation_stops_popup_process_and_dialog_descendant(self):
        self.exercise_stop(cancel=True)

    def test_socket_identity_changes_when_master_is_replaced_at_same_path(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'master')
            with patch.object(ssh, 'control_path', return_value=path):
                self.assertIsNone(ssh.shared_connection_identity('jdoe', 'host'))
                with socket.socket(socket.AF_UNIX) as first:
                    first.bind(path)
                    identity = ssh.shared_connection_identity('jdoe', 'host')
                    self.assertEqual(ssh.shared_connection_identity('jdoe', 'host'), identity)
                    os.unlink(path)
                    with socket.socket(socket.AF_UNIX) as replacement:
                        replacement.bind(path)
                        self.assertNotEqual(ssh.shared_connection_identity('jdoe', 'host'), identity)

    def test_pre_cancelled_attempt_never_starts_a_process(self):
        event = threading.Event()
        event.set()
        with patch.object(ssh.subprocess, 'Popen') as start:
            self.assertEqual(ssh.popup_login(['unused'], {}, event, 180)[0], ssh.CANCELLED)
        start.assert_not_called()

    def test_only_new_successful_login_reports_connection_ownership(self):
        owned = []
        callback = lambda *identity: owned.append(identity)
        with patch.object(ssh, 'shared_connection_alive', return_value=True):
            self.assertEqual(ssh.login('jdoe', ssh.DEFAULT_HOST, popup=True, on_connected=callback)[0], 0)
        self.assertEqual(owned, [])
        with patch.object(ssh, 'shared_connection_alive', return_value=False), \
                patch.object(ssh, 'popup_login', return_value=(0, None)), patch('sys.stdout'):
            self.assertEqual(ssh.login('jdoe', ssh.DEFAULT_HOST, popup=True, on_connected=callback)[0], 0)
        self.assertEqual(owned, [('jdoe', ssh.DEFAULT_HOST)])
