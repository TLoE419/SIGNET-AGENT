import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from agent.runtime import hpc
from agent.runtime.jobs import watch_setup


class SetupWatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.args = (str(self.root), str(self.root / 'software/pinned'), str(self.root / 'image.sif'), 'a' * 64)
        self.steps = self.root / '.signet-agent/steps'
        self.steps.mkdir(parents=True)

    def signature(self):
        return watch_setup.signature(*self.args)

    def test_completion_metadata_notifies_without_reading_logs_or_research_data(self):
        cursor = self.signature()
        tick = [0]
        def sleep(seconds):
            tick[0] += seconds
            (self.steps / 'container.status').write_text('state=done\n')
        with patch.object(Path, 'read_bytes', side_effect=AssertionError('Must not read files')), \
                patch.object(Path, 'read_text', side_effect=AssertionError('Must not read files')):
            current, changed = watch_setup.wait(*self.args, cursor, clock=lambda: tick[0], sleep=sleep)
        self.assertTrue(changed)
        self.assertNotEqual(current, cursor)
        self.assertEqual(tick[0], 1)

    def test_timeout_is_unchanged_and_bounded(self):
        tick = [0]
        def sleep(seconds): tick[0] += seconds
        cursor = self.signature()
        self.assertEqual(watch_setup.wait(*self.args, cursor, seconds=3,
                         clock=lambda: tick[0], sleep=sleep), (cursor, False))
        self.assertEqual(tick[0], 3)

    def test_old_job_file_completion_is_observed_without_a_new_hook(self):
        image = Path(self.args[2])
        cursor = self.signature()
        image.write_bytes(b'completed image')
        self.assertEqual(watch_setup.wait(*self.args, cursor, seconds=0)[1], True)

    def test_unrelated_log_content_is_not_watched(self):
        log = self.steps / 'container.log'
        log.write_text('first line')
        cursor = self.signature()
        log.write_text('extra progress; no state change')
        self.assertEqual(self.signature(), cursor)

    def test_paths_and_cursor_are_not_arbitrary_command_or_file_requests(self):
        for value in ('../outside', '/', '/tmp/../outside', '/tmp/a;id', '/tmp/a b'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                watch_setup.signature(value, self.args[1], self.args[2], self.args[3])
        for cursor in ('', '../secret', 'a' * 63, 'Z' * 64):
            with self.subTest(cursor=cursor), self.assertRaises(ValueError):
                watch_setup.wait(*self.args, cursor, seconds=0)
            self.assertEqual(hpc.watch_setup(cursor)['status'], 'invalid')
        with self.assertRaises(ValueError):
            watch_setup.wait(*self.args, self.signature(), seconds=46)

    def test_terminal_hooks_record_success_and_failure_and_preserve_exit_status(self):
        for code in (0, 7):
            with self.subTest(code=code):
                script = 'set -euo pipefail\nSLURM_JOB_ID=123\nD=' + str(self.steps) + '\n' + hpc._setup_status_hook('container')
                script += 'exit ' + str(code) + '\n'
                result = subprocess.run(['bash', '-s'], input=script, text=True, capture_output=True)
                self.assertEqual(result.returncode, code, result.stderr)
                self.assertEqual((self.steps / 'container.status').read_text(),
                                 'job=123\nstate=running\nstate=' + ('done' if code == 0 else 'failed') + '\n')

    def test_container_installs_the_completion_hook(self):
        self.assertIn('trap signet_setup_exit EXIT', hpc._container_job())

    def test_dataset_files_and_old_setup_steps_do_not_trigger_a_notification(self):
        assets = self.root / 'refdata'
        (assets / 'prepared/example').mkdir(parents=True)
        cursor = self.signature()
        for file in ('selected.tsv', 'clinical.tsv', 'prepared/example/summary.json'):
            (assets / file).write_text('changed')
        for step in ('ref', 'gmap', 'gtf', 'clinical', 'prepare'):
            (self.steps / (step + '.status')).write_text('state=done\n')
            (self.steps / (step + '.job')).write_text('123\n')
        self.assertEqual(self.signature(), cursor)

    def test_cursor_precedes_full_check_and_catches_change_during_check(self):
        config = {'root': self.args[0], 'source': self.args[1], 'image': self.args[2], 'executor': '/bin/echo',
                  'revision': hpc.SOURCE_INVENTORY['revision'], 'partition': 'free'}
        token = hpc._CONFIG.set(config)
        try:
            check = hpc._check_script(str(self.root))
            self.assertLess(check.index('SIGNET_SETUP_WATCH'), check.index('sha256sum -c'))
            capture = subprocess.run(['bash', '-s'], input=hpc._setup_watch_script(str(self.root)),
                                     text=True, capture_output=True, check=True)
            cursor = hpc._parse(capture.stdout.encode())['setup_cursor']
            (self.steps / 'container.status').write_text('state=done\n')
            response = subprocess.run(['bash', '-s'], input=hpc._setup_watch_script(str(self.root), cursor, 0),
                                      text=True, capture_output=True, check=True)
        finally:
            hpc._CONFIG.reset(token)
        self.assertEqual(hpc._parse(response.stdout.encode())['setup_changed'], 'yes')

    def test_cancelled_watch_keeps_its_admission_slot_until_remote_lease_expires(self):
        semaphore = threading.BoundedSemaphore(2)
        stop = threading.Event()
        stop.set()
        timers = []
        class Timer:
            def __init__(self, delay, callback):
                self.delay, self.callback, self.daemon, self.started = delay, callback, False, False
                timers.append(self)
            def start(self): self.started = True
        def cancelled(script, **kwargs):
            script(str(self.root))
            return None, {'status': 'unavailable'}
        with patch.object(hpc, '_SETUP_WATCHERS', semaphore), \
                patch.object(hpc.threading, 'Timer', Timer), \
                patch.object(hpc, '_run', side_effect=cancelled) as run:
            hpc.watch_setup('a' * 64, cancel_event=stop)
            hpc.watch_setup('a' * 64, cancel_event=stop)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(hpc.watch_setup('a' * 64)['status'], 'unavailable')
            self.assertEqual(run.call_count, 2)
            for timer in timers:
                self.assertTrue(timer.daemon)
                self.assertTrue(timer.started)
                self.assertGreater(timer.delay, 85)
                self.assertLessEqual(timer.delay, 90)
                timer.callback()
            self.assertTrue(semaphore.acquire(blocking=False))
            self.assertTrue(semaphore.acquire(blocking=False))

    def test_transport_error_without_cancellation_also_retains_remote_admission(self):
        semaphore = threading.BoundedSemaphore(2)
        timers = []
        class Timer:
            def __init__(self, delay, callback):
                self.delay, self.callback, self.daemon = delay, callback, False
                timers.append(self)
            def start(self): pass
        def timeout(script, **kwargs):
            script(str(self.root))
            return None, {'status': 'unavailable', 'reason': 'transport timeout'}
        with patch.object(hpc, '_SETUP_WATCHERS', semaphore), \
                patch.object(hpc.threading, 'Timer', Timer), \
                patch.object(hpc, '_run', side_effect=timeout) as run:
            for _ in range(2):
                self.assertEqual(hpc.watch_setup('a' * 64)['status'], 'unavailable')
            hpc.watch_setup('a' * 64)
            self.assertEqual(run.call_count, 2)
            self.assertEqual(len(timers), 2)
            for timer in timers:
                self.assertTrue(timer.daemon)
                timer.callback()
            self.assertTrue(semaphore.acquire(blocking=False))
            self.assertTrue(semaphore.acquire(blocking=False))

    def test_current_failure_is_immediate_but_old_failed_attempt_does_not_mask_retry(self):
        for terminal_job, expected in [('123', 'problem'), ('122', 'in_progress')]:
            values = {'file_container': 'no', 'job_container': '123', 'job_container_state': 'RUNNING',
                      'job_container_terminal': 'failed', 'job_container_terminal_job': terminal_job}
            item = next(check for check in hpc._checks(values, hpc.SOURCE_INVENTORY['revision'])
                        if check['item'] == 'container')
            self.assertEqual(item['status'], expected)
        values = {'file_container': 'no', 'job_container': '123', 'job_container_state': 'RUNNING',
                  'job_container_terminal': 'done', 'job_container_terminal_job': '123'}
        self.assertEqual(next(check for check in hpc._checks(values, hpc.SOURCE_INVENTORY['revision'])
                              if check['item'] == 'container')['status'], 'problem')

    def test_remote_report_accepts_terminal_status_only_for_current_job(self):
        binary = self.root / 'bin'
        binary.mkdir()
        queue = binary / 'squeue'
        queue.write_text('#!/bin/sh\necho RUNNING\n')
        queue.chmod(0o700)
        import os
        for terminal_job in ('123', '122'):
            (self.steps / 'container.job').write_text('123\n')
            (self.steps / 'container.status').write_text('job=' + terminal_job + '\nstate=running\nstate=failed\n')
            script = hpc._prelude(str(self.root)) + 'D=' + str(self.steps) + '\n' + hpc._report_steps()
            response = subprocess.run(['bash', '-s'], input=script, text=True, capture_output=True,
                       env={**os.environ, 'PATH': str(binary) + ':' + os.environ['PATH']}, check=True)
            values = hpc._parse(response.stdout.encode())
            self.assertEqual(values.get('job_container_terminal'), 'failed' if terminal_job == '123' else None)
            self.assertEqual(values.get('job_container_terminal_job'), '123' if terminal_job == '123' else None)

    def test_wrapper_bounds_concurrent_watchers_and_validates_reply(self):
        with patch.object(hpc, '_run', return_value=({'setup_cursor': 'b' * 64,
                  'setup_changed': 'yes', 'workspace_path': '/w'}, None)) as run:
            result = hpc.watch_setup('a' * 64)
        self.assertEqual(result['setup_cursor'], 'b' * 64)
        self.assertTrue(result['changed'])
        self.assertEqual(run.call_args.kwargs['timeout'], 55)
        self.assertTrue(hpc._SETUP_WATCHERS.acquire(blocking=False))
        self.assertTrue(hpc._SETUP_WATCHERS.acquire(blocking=False))
        try:
            self.assertEqual(hpc.watch_setup('a' * 64)['status'], 'unavailable')
        finally:
            hpc._SETUP_WATCHERS.release()
            hpc._SETUP_WATCHERS.release()
        for current, changed in [('a' * 64, 'yes'), ('b' * 64, 'no')]:
            with patch.object(hpc, '_run', return_value=({'setup_cursor': current, 'setup_changed': changed}, None)):
                self.assertEqual(hpc.watch_setup('a' * 64)['status'], 'failed')
        with patch.object(hpc, '_run', return_value=({'setup_cursor': 'not a cursor'}, None)):
            self.assertEqual(hpc.watch_setup('a' * 64)['status'], 'failed')


class SetupWatchCancellationTest(unittest.TestCase):
    def test_cancel_interrupts_an_idle_response_header_without_waiting_for_remote_timeout(self):
        from agent.runtime import ssh_transport
        stop = threading.Event()
        class Connection:
            def recv(self, count):
                raise AssertionError('No response is available')
        def idle(*_):
            stop.set()
            return [], [], []
        with patch.object(ssh_transport.select, 'select', side_effect=idle):
            with self.assertRaisesRegex(OSError, 'cancelled'):
                ssh_transport._cancelled_receive(Connection(), 1, stop, time.monotonic() + 55)

    def test_cancel_path_keeps_broker_framing_and_does_not_transmit_event_object(self):
        from agent.runtime import ssh_transport
        stop = threading.Event()
        payload = json.dumps({'ok': True, 'value': {'returncode': 0, 'signal': None,
                             'stdoutLength': 2, 'stderrLength': 1}}).encode() + b'\nok!'
        class Connection:
            def __init__(self): self.buffer, self.sent, self.closed = payload, [], False
            def settimeout(self, value): pass
            def connect(self, path): pass
            def sendall(self, data): self.sent.append(data)
            def recv(self, count):
                result, self.buffer = self.buffer[:count], self.buffer[count:]
                return result
            def close(self): self.closed = True
        connection = Connection()
        with patch.dict(ssh_transport.os.environ, {'SIGNET_SSH_BROKER': '/private/test.sock',
                         'SIGNET_SSH_BROKER_TOKEN': 'test-only-token'}), \
             patch.object(ssh_transport.socket, 'socket', return_value=connection), \
             patch.object(ssh_transport.select, 'select', return_value=([connection], [], [])):
            result = ssh_transport.request('exec', cancel_event=stop, command='bash -s', timeoutMs=55000)
        self.assertEqual((result['stdout'], result['stderr']), (b'ok', b'!'))
        self.assertTrue(connection.closed)
        self.assertNotIn('cancel_event', json.loads(connection.sent[0]))


if __name__ == '__main__':
    unittest.main()
