"""Route tests for /signet/* (agent/app/signet_api.py) through a real ChatServer on a free port.

HPC3 is the same fake as in test_signet_jobs.py: a temporary folder plus
stand-in Slurm commands, reached through a patched SSH transport. These tests
check what only the HTTP layer adds: token/Origin/Host checks on every route,
status codes, error codes and JSON shapes.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import http.client
import io
import json
from pathlib import Path
from subprocess import CompletedProcess
import tarfile
import threading
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import agent.app.chat_ui as chat_ui
import agent.runtime.ssh_transport as ssh_transport
from agent.runtime import signet_jobs as jobs
from agent.tools import signet
from agent.tools.signet import dispatch_tool
import test_signet_jobs


class SignetApiTest(unittest.TestCase):
    # Reuse the fake HPC3 folder, fake Slurm and the run "step_test" from the service tests.
    setUp_hpc = test_signet_jobs.StepsTest.setUp
    remote = test_signet_jobs.StepsTest.remote
    slurm = test_signet_jobs.StepsTest.slurm
    finish_job = test_signet_jobs.StepsTest.finish_job
    genotype_inputs = test_signet_jobs.StepsTest.genotype_inputs

    def setUp(self):
        self.setUp_hpc()

        @contextmanager
        def factory(timing):
            yield None

        self.server = chat_ui.ChatServer(('127.0.0.1', 0), factory)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f'http://127.0.0.1:{self.server.server_port}'
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def call(self, method, path, body=None, headers=None):
        """Send one request as the app page would (token + Origin) unless headers are given."""
        if headers is None:
            headers = {'X-Chat-Token': self.server.token, 'Origin': self.origin, 'Content-Type': 'application/json'}
        data = body if isinstance(body, (str, bytes)) or body is None else json.dumps(body)
        conn = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=20)
        try:
            conn.request(method, path, body=data, headers=headers)
            result = conn.getresponse()
            data = result.read()
            mime = result.getheader('Content-Type', '')
            if mime == 'application/zip':
                return result.status, data
            text = data.decode()
            return result.status, json.loads(text) if mime.startswith('application/json') else text
        finally:
            conn.close()

    def submit(self, run_id='step_test'):
        return self.call('POST', f'/signet/runs/{run_id}/steps/expression', {'inputs': self.inputs})

    def test_every_route_needs_the_page_token_and_writes_need_the_origin(self):
        routes = [('GET', '/signet/progress'), ('GET', '/signet/catalog'), ('GET', '/signet/runs'), ('POST', '/signet/runs'),
                  ('POST', '/signet/runs/step_test/genotype-proposal/prepare'),
                  ('POST', '/signet/runs/step_test/genotype-proposal/confirm'),
                  ('POST', '/signet/runs/step_test/genotype-proposal/decline'),
                  ('GET', '/signet/runs/step_test/results'),
                  ('POST', '/signet/runs/step_test/results/download'),
                  ('POST', '/signet/runs/step_test/steps/expression/proposal/prepare'),
                  ('POST', '/signet/runs/step_test/steps/expression/rerun/prepare'),
                  ('POST', '/signet/runs/step_test/steps/expression/rerun/confirm'),
                  ('GET', '/signet/runs/step_test'), ('PATCH', '/signet/runs/step_test/conversation'), ('PATCH', '/signet/runs/step_test/settings'),
                  ('POST', '/signet/runs/step_test/steps/expression'), ('GET', '/signet/runs/step_test/steps/expression'),
                  ('POST', '/signet/runs/step_test/steps/expression/cancel'),
                  ('GET', '/signet/runs/step_test/steps/expression/log')]
        for method, path in routes:
            self.assertEqual(self.call(method, path, '{}', {'Origin': self.origin})[0], 403, path)
            self.assertEqual(self.call(method, path, '{}', {'X-Chat-Token': 'wrong', 'Origin': self.origin})[0], 403, path)
            self.assertEqual(self.call(method, path, '{}', {'X-Chat-Token': self.server.token, 'Origin': self.origin,
                                                            'Host': 'evil.example:80'})[0], 403, path)
            if method != 'GET':
                self.assertEqual(self.call(method, path, '{}', {'X-Chat-Token': self.server.token})[0], 403, path)
        self.assertEqual(self.calls, [])
        self.assertFalse((self.root / 'steps').exists())

    def test_catalog_and_unknown_routes_and_methods(self):
        status, value = self.call('GET', '/signet/catalog')
        self.assertEqual((status, value['steps'][0]['name']), (200, 'expression'))
        self.assertEqual(self.call('GET', '/signet/nothing')[1]['code'], 'not_found')
        self.assertEqual(self.call('POST', '/signet/catalog', {})[0], 405)
        self.assertEqual(self.call('GET', '/signet/runs/step_test/settings')[0], 405)
        self.assertEqual(self.call('GET', '/signet/catalog?x=1')[0], 400)
        self.assertEqual(self.call('PATCH', '/chat', {})[0], 404)

    def test_create_list_and_read_runs(self):
        status, value = self.call('POST', '/signet/runs', {'run_id': 'luad_t1', 'cohort': 'TCGA'})
        self.assertEqual((status, value['run_id'], value['settings']['cohort']), (201, 'luad_t1', 'TCGA'))
        self.assertEqual(self.call('POST', '/signet/runs', {'run_id': 'luad_t1'})[1]['code'], 'conflict')
        for bad in ({'run_id': '../x'}, {'run_id': 'ok', 'cohort': 'mouse'}, {'cohort': 'TCGA'},
                    {'run_id': 'ok', 'extra': 1}, '[1]', 'not json'):
            status, value = self.call('POST', '/signet/runs', bad)
            self.assertEqual((status, value['code']), (400, 'invalid_request'), bad)
        status, value = self.call('GET', '/signet/runs')
        self.assertEqual(status, 200)
        self.assertEqual({item['run_id'] for item in value['runs']}, {'step_test', 'luad_t1'})
        status, value = self.call('GET', '/signet/runs/luad_t1')
        self.assertEqual((status, value['cohort'], value['steps']), (200, 'TCGA', {}))
        self.assertEqual(self.call('GET', '/signet/runs/missing')[0], 404)

    def test_analysis_can_be_linked_to_one_saved_conversation_without_submitting(self):
        session = '12345678-1234-1234-1234-123456789abc'
        other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        self.server.histories.update({session: [], other: []})
        path = '/signet/runs/step_test'
        self.assertIsNone(self.call('GET', path)[1]['analysis']['session'])
        self.assertEqual(self.call('PATCH', path + '/conversation', {'session': 'invalid'})[0], 400)
        self.assertEqual(self.call('PATCH', path + '/conversation', {'session': '0' * 36})[0], 404)
        for _ in range(2):
            self.assertEqual(self.call('PATCH', path + '/conversation', {'session': session})[0], 200)
        self.assertEqual(self.call('PATCH', path + '/conversation', {'session': other})[0], 409)
        self.assertEqual(self.call('GET', path)[1]['analysis']['session'], session)
        self.assertEqual([r['run_id'] for r in self.call('GET', '/signet/runs?session=' + session)[1]['runs']],
                         ['step_test'])
        self.assertEqual(self.call('GET', '/signet/runs?session=' + other)[1]['runs'], [])
        self.assertEqual(self.calls, [])

    def genotype_review(self):
        session = '12345678-1234-1234-1234-123456789abc'
        self.server.histories[session] = []
        self.genotype_inputs()
        run = '/signet/runs/step_test'
        path = run + '/genotype-proposal/'
        self.assertEqual(self.call('PATCH', run + '/conversation', {'session': session})[0], 200)
        status, draft = self.call('POST', path + 'prepare', {'session': session, 'mode': 'example'})
        self.assertEqual(status, 200)
        self.assertEqual(draft['state'], 'pending')
        settings = {key: ('no' if value == 'no' else float(value) if key in ('mind', 'geno', 'hwe') else int(value))
                    for key, value in draft['parameters']['settings'].items()}
        return path, {'session': session, 'proposal_id': draft['id'], **draft['parameters'],
                      'settings': settings}

    def test_chat_proposes_genotype_without_running_and_waits_for_the_card(self):
        session = '12345678-1234-1234-1234-123456789abc'
        self.genotype_inputs()

        def conversation(client, text, history, **kwargs):
            proposed = dispatch_tool('propose_hpc3_genotype', {'run_id': 'step_test', 'use_example': True})
            bypass = dispatch_tool('genotype_tcga', {})
            self.assertEqual((proposed['status'], proposed['executed']), ('awaiting_confirmation', False))
            self.assertEqual((bypass['status'], bypass['executed']), ('awaiting_confirmation', False))
            return 'Review the genotype settings.'

        with patch.object(chat_ui, 'run_conversation', side_effect=conversation):
            status, stream = self.call('POST', '/chat', {'text': 'Use the official example', 'session': session})
        self.assertEqual(status, 200)
        self.assertIn('Review the genotype settings.', stream)
        progress = self.call('GET', '/signet/progress?session=' + session)[1]['analyses'][0]
        self.assertEqual(progress['genotype_proposal']['state'], 'pending')
        self.assertEqual(progress['steps'][0]['phase'], 'not_started')
        self.assertEqual(self.calls, [])

    def test_genotype_decline_cross_session_and_stale_review_do_not_submit(self):
        path, body = self.genotype_review()
        before = (self.root / 'work/config.ini').read_bytes()
        other = {**body, 'session': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}
        self.assertEqual(self.call('POST', path + 'confirm', other)[0], 404)
        identity = {key: body[key] for key in ('session', 'proposal_id')}
        self.assertEqual(self.call('POST', path + 'decline', identity)[1]['state'], 'declined')
        self.assertEqual(self.call('POST', path + 'confirm', body)[0], 409)
        self.assertEqual((self.root / 'work/config.ini').read_bytes(), before)
        draft = self.call('POST', path + 'prepare', {'session': body['session'], 'mode': 'example'})[1]
        self.assertNotEqual(draft['id'], body['proposal_id'])
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'mind': .2}})[0], 200)
        self.assertEqual(self.call('POST', path + 'confirm', {**body, 'proposal_id': draft['id']})[0], 409)
        self.assertEqual(self.calls, [])

    def test_genotype_confirm_uses_edited_settings_and_only_submits_once(self):
        path, body = self.genotype_review()
        before = (self.root / 'work/config.ini').read_bytes()
        body['settings']['mind'] = 2
        self.assertEqual(self.call('POST', path + 'confirm', body)[0], 400)
        self.assertEqual((self.root / 'work/config.ini').read_bytes(), before)
        self.assertEqual(self.calls, [])
        body['settings']['mind'] = .07
        body['resources']['cpus'] = 3
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.call('POST', path + 'confirm', body), range(2)))
        self.assertEqual(sorted(status for status, _ in responses), [202, 409])
        record = next(record for status, record in responses if status == 202)
        self.assertEqual((record['step'], record['state'], record['job_id']), ('genotype', 'submitted', '12345'))
        self.assertEqual((record['settings']['mind'], record['resources']['cpus']), ('0.07', 3))
        self.assertIn('mind = 0.07', (self.remote_dir / 'work/config.ini').read_text())
        self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), 1)
        progress = self.call('GET', '/signet/progress?session=' + body['session'])[1]['analyses'][0]
        self.assertEqual(progress['genotype_proposal']['state'], 'sent')
        self.assertEqual(progress['steps'][0]['phase'], 'submitted')

    def test_unknown_genotype_submission_cannot_reuse_approval(self):
        path, body = self.genotype_review()
        self.lose_connection_on = 'sbatch --parsable'
        status, record = self.call('POST', path + 'confirm', body)
        self.assertEqual((status, record['state']), (202, 'unknown'))
        self.assertEqual(self.call('POST', path + 'confirm', body)[0], 409)
        self.assertEqual(self.call('POST', path + 'prepare', {'session': body['session'], 'mode': 'example'})[0], 409)
        self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), 1)

    def test_six_reviewed_steps_share_one_run_and_download_its_results(self):
        path, body = self.genotype_review()
        session = body['session']
        run = '/signet/runs/step_test'
        progress = '/signet/progress?session=' + session
        routes = lambda step: run + '/steps/' + step
        results = run + '/results?session=' + session
        download = run + '/results/download'
        other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

        self.assertEqual(self.call('POST', routes('expression') + '/proposal/prepare', {'session': session})[0], 409)
        self.assertEqual(self.call('GET', results)[0], 409)
        self.assertEqual(self.call('POST', download, {'session': session})[0], 409)
        clinical = self.hpc / 'ws/refdata/clinical-compatible.tsv'
        clinical.write_text('submitter_id\trace\tgender\nTCGA-AB-0001\tasian\tfemale\n')
        expression = self.hpc / 'ws/signet/example/gexp/example_gexp'
        expression.parent.mkdir(exist_ok=True)
        expression.write_text('example expression')
        (self.hpc / 'ws/refdata/gencode.v22.genes.gtf').write_text('annotation')
        edges = 'source_gene_symbol,target_gene_symbol,frequency,coefficient\nA,B,0.75,0.2\n'

        submitted = {}
        for index, step in enumerate(jobs.ANALYSIS_STEPS):
            base = routes(step)
            if step != 'genotype':
                endpoint = base + '/proposal/prepare'
                status, draft = self.call('POST', endpoint, {'session': session})
                self.assertEqual(status, 200, draft)
                self.assertEqual(self.call('GET', progress)[1]['analyses'][0]['proposal']['id'], draft['id'])
                self.assertEqual(draft['mode'], 'example')
                parameters = draft['parameters']
                rules = jobs.STEPS[step].settings
                parameters['settings'] = {
                    name: value if value == 'no' or rules[name] == 'hms' else
                    float(value) if rules[name] in ('alpha', 'fraction') else int(value)
                    for name, value in parameters['settings'].items()
                }
                body = {'session': session, 'proposal_id': draft['id'], **parameters}
                if step == 'adjust':
                    self.assertEqual(body['inputs']['cli.file'], '')
                    body['inputs']['cli.file'] = str(clinical)
                    body['options']['npc'] = 2
                if step == 'visualize':
                    body['settings']['freq'] = .75

            self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), index)
            self.slurm(sbatch_reply=str(4000 + index), sacct='', squeue='')
            status, record = self.call('POST', base + '/proposal/confirm', body)
            self.assertEqual(status, 202, record)
            self.assertEqual(record['run_id'], 'step_test')
            submitted[step] = {key: record[key] for key in ('inputs', 'settings', 'resources', 'options')
                               if record.get(key)}
            self.assertEqual(self.call('POST', base + '/proposal/confirm', body)[0], 409)
            if step == 'adjust':
                self.assertEqual(record['options'], {'npc': 2})
            if step == 'visualize':
                script = (self.remote_dir / 'steps/visualize.sbatch').read_text()
                self.assertIn('bash ./signet -v', script)
                self.assertIn('cloud=T', script)
                self.assertIn('signet-edges.csv', script)
                config = (self.remote_dir / 'work/config.ini').read_text()
                self.assertIn('freq = 0.75', config)
                self.assertIn('Afreq = ' + str(self.remote_dir / 'work/res/resn/signet_Afreq'), config)
            outputs = record.get('required_outputs') or jobs.STEPS[step].required
            extra = {
                'genotype': ['tmp/tmpg/impute/impute_Genotype.sizes'],
                'visualize': ['res/resv/signet_top1_freq0.75.html',
                              'res/resv/signet_top1_freq0.75_files/widget.js'],
            }.get(step, [])
            for name in [*outputs, *extra]:
                file = self.remote_dir / 'work' / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(edges if name.endswith('signet-edges.csv') else step)
            (self.remote_dir / f'steps/{step}.done').write_text('0 2026-11-01T10:00:00\n')
            self.slurm(sacct='COMPLETED')
            if step == 'visualize':
                edge_file = self.remote_dir / 'work/res/resv/signet-edges.csv'
                edge_file.unlink()
                status, waiting = self.call('GET', base)
                self.assertEqual((status, waiting['state'], waiting['job_id']),
                                 (200, 'validating', record['job_id']))
                self.assertEqual(waiting['missing_outputs'], ['res/resv/signet-edges.csv'])
                analysis = self.call('GET', progress)[1]['analyses'][0]
                self.assertEqual((analysis['completed_steps'], analysis['steps'][-1]['phase']), (5, 'validating'))
                self.assertEqual(self.call('POST', base + '/proposal/prepare', {'session': session})[0], 409)
                self.assertEqual(self.call('GET', results)[0], 409)
                edge_file.write_text(edges)
                # The chat polls this route normally after the status cache expires.
                with patch.object(jobs, 'CACHE_SECONDS', 0):
                    status, completed = self.call('GET', base)
                self.assertEqual((completed['job_id'], completed['attempt']), (record['job_id'], 1))
            else:
                status, completed = self.call('GET', base + '?refresh=1')
            self.assertEqual((status, completed['state']), (200, 'completed'), completed)
            analysis = self.call('GET', progress)[1]['analyses'][0]
            self.assertEqual(analysis['completed_steps'], index + 1)
            self.assertEqual({stage['step']: stage['parameters'] for stage in analysis['steps']
                              if stage['phase'] == 'completed'}, submitted)
            self.assertEqual(analysis['next_step'],
                             jobs.ANALYSIS_STEPS[index + 1] if index + 1 < len(jobs.ANALYSIS_STEPS) else None)

        self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), 6)
        self.assertEqual(self.call('GET', run + '/results?session=' + other)[0], 404)
        graph = self.call('GET', results)[1]['graph']
        self.assertEqual(graph['edges'], [{'source': 'A', 'target': 'B', 'frequency': .75, 'coefficient': .2}])
        self.assertEqual(self.call('POST', download, {'session': other})[0], 404)
        ticket = self.call('POST', download, {'session': session})[1]['url']
        status, payload = self.call('GET', ticket, headers={})
        self.assertEqual(status, 200, payload)
        with ZipFile(io.BytesIO(payload)) as archive:
            self.assertEqual(archive.read('work/res/resv/signet-edges.csv').decode(), edges)
            self.assertIn('work/res/resv/signet_top1_freq0.75_files/widget.js', archive.namelist())
            self.assertIn('work/res/resg/signet_Geno', archive.namelist())
        self.assertEqual(self.call('GET', ticket, headers={})[0], 403)

        stages = jobs.ANALYSIS_STEPS
        old_records = jobs.run_records(self.root)
        old_config = (self.root / 'work/config.ini').read_bytes()
        plans = {}
        for index, name in enumerate(stages):
            endpoint = routes(name) + '/rerun/prepare'
            self.assertEqual(self.call('POST', endpoint, {'session': other})[0], 404)
            status, draft = self.call('POST', endpoint, {'session': session})
            self.assertEqual(status, 200, draft)
            self.assertEqual(draft['parameters']['settings'], old_records[name]['settings'])
            self.assertEqual(draft['affected_steps'], list(stages[max(2, index + 1):]))
            reused = [stage for stage in stages if stage not in [name, *draft['affected_steps']]]
            self.assertEqual(draft['reused_steps'], reused)
            plans[name] = draft
        self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), 6)
        self.assertEqual(len(list(self.root.parent.iterdir())), 1, 'preview creates no new run')

        for index, name in enumerate(stages):
            draft = plans[name]
            parameters = draft['parameters']
            rules = jobs.STEPS[name].settings
            settings = {key: value if value == 'no' or rules[key] == 'hms' else
                        float(value) if rules[key] in ('alpha', 'fraction') else int(value)
                        for key, value in parameters['settings'].items()}
            if name == 'visualize':
                settings['freq'] = .5
            request = {**parameters, 'settings': settings, 'session': session, 'proposal_id': draft['id']}
            endpoint = routes(name) + '/rerun/confirm'
            self.slurm(sbatch_reply=str(5000 + index), sacct='', squeue='')
            if name == 'adjust':
                remote_input = self.remote_dir / 'work/tmp/tmpg/impute/impute_Genotype.sizes'
                saved_input = remote_input.read_bytes()
                remote_input.unlink()
                self.assertEqual(self.call('POST', endpoint, request)[0], 502)
                self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), 6 + index)
                remote_input.write_bytes(saved_input)
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: self.call('POST', endpoint, request), range(2)))
            self.assertEqual(sorted(code for code, _ in responses), [202, 409], responses)
            _, rerun = next(response for response in responses if response[0] == 202)
            self.assertNotEqual(rerun['run_id'], 'step_test')
            self.assertEqual((rerun['step'], rerun['attempt']), (name, 1))
            child = self.root.parent / rerun['run_id']
            self.assertEqual(jobs.analysis_session(child), session)
            child_records = jobs.run_records(child)
            self.assertEqual(set(child_records), {name, *draft['reused_steps']})
            for reused in draft['reused_steps']:
                self.assertEqual(child_records[reused]['reused_from'], 'step_test')
                for file in child_records[reused]['outputs']:
                    self.assertEqual((child / file).read_bytes(), (self.root / file).read_bytes())
                    self.assertEqual((Path(rerun['remote_dir']) / file).read_bytes(), (self.remote_dir / file).read_bytes())
            if 'genotype' in draft['reused_steps']:
                self.assertTrue((Path(rerun['remote_dir']) / 'work/tmp/tmpg/impute/impute_Genotype.sizes').is_file())
            self.assertEqual((Path(rerun['remote_dir']) / 'steps' / f'{name}.job').read_text().strip(), str(5000 + index))
            if name == 'visualize':
                self.assertEqual(rerun['settings']['freq'], '0.5')
            self.assertEqual(sum('sbatch --parsable' in command for command in self.calls), 7 + index)
        self.assertEqual(jobs.run_records(self.root), old_records)
        self.assertEqual((self.root / 'work/config.ini').read_bytes(), old_config)
        self.assertEqual(self.call('GET', results)[1]['graph'], graph)
        endpoint = routes('genotype') + '/rerun/'
        draft = self.call('POST', endpoint + 'prepare', {'session': session})[1]
        self.assertEqual(draft['chromosome_pair'], {'setting': 'restrict.tcga.geno', 'stage': 'expression'})
        parameters = draft['parameters']
        for key, suffix in jobs.STEPS['genotype'].prefixes.items():
            Path(parameters['inputs'][key] + '2' + suffix).write_text('chromosome 2 data')
        settings = {**parameters['settings'], 'restrict.tcga.geno': 2, 'int': int(parameters['settings']['int'])}
        for key in ('mind', 'geno', 'hwe'):
            settings[key] = float(settings[key])
        status, moved = self.call('POST', endpoint + 'confirm', {
            **parameters, 'settings': settings, 'session': session, 'proposal_id': draft['id']})
        self.assertEqual(status, 202, moved)
        child = self.root.parent / moved['run_id']
        self.assertEqual(set(jobs.run_records(child)), {'genotype'})
        self.assertEqual(signet._settings(child)['restrict.tcga'], '2')
        analyses = self.call('GET', progress)[1]['analyses']
        self.assertEqual(len(analyses), 8)
        branched = next(item for item in analyses if item.get('rerun', {}).get('from_step') == 'adjust')
        self.assertEqual(branched['rerun']['source_run'], 'step_test')
        self.assertEqual(branched['steps'][0]['reused_from'], 'step_test')
        self.assertEqual(branched['steps'][3]['phase'], 'not_started')

    def test_progress_is_scoped_to_conversation_and_readable_while_downloading(self):
        session = '12345678-1234-1234-1234-123456789abc'
        other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        self.server.histories.update({session: [], other: []})
        path = '/signet/runs/step_test'
        self.assertEqual(self.call('GET', '/signet/progress')[0], 400)
        self.assertEqual(self.call('PATCH', path + '/conversation', {'session': session})[0], 200)
        self.assertEqual(self.call('GET', '/signet/progress?session=' + other)[1], {'analyses': []})
        self.assertEqual(self.calls, [])
        self.assertEqual(self.submit()[0], 202)
        self.finish_job()

        downloading, release = threading.Event(), threading.Event()

        def remote(command, **kwargs):
            if 'tar czf' in command:
                downloading.set()
                if not release.wait(10):
                    raise TimeoutError('Test did not release the download.')
            return self.remote(command, **kwargs)

        def progress():
            status, value = self.call('GET', '/signet/progress?session=' + session)
            self.assertEqual(status, 200)
            return value['analyses'][0]

        with patch.object(ssh_transport, 'remote', side_effect=remote), ThreadPoolExecutor() as pool:
            check = pool.submit(self.call, 'GET', path + '/steps/expression')
            try:
                self.assertTrue(downloading.wait(10))
                snapshot = progress()
                self.assertEqual(snapshot['run_id'], 'step_test')
                self.assertEqual(snapshot['completed_steps'], 0)
                expression = snapshot['steps'][1]
                self.assertEqual((expression['step'], expression['flag'], expression['phase']),
                                 ('expression', '-t', 'downloading'))
                self.assertIn('inputs', expression['parameters'])
                self.assertEqual(snapshot['steps'][-1]['phase'], 'not_started')
            finally:
                release.set()
            self.assertEqual(check.result(timeout=10)[1]['state'], 'completed')
        self.assertEqual(progress()['completed_steps'], 1)
        self.assertEqual(sum('sbatch --parsable' in c for c in self.calls), 1)

    def test_analysis_reports_each_attempt_and_distinguishes_transfer_from_completion(self):
        path = '/signet/runs/step_test'
        status_path = path + '/steps/expression?refresh=1'

        def analysis():
            count = len(self.calls)
            status, value = self.call('GET', path)
            self.assertEqual(status, 200)
            self.assertEqual(len(self.calls), count)
            return value['analysis']

        initial = analysis()
        self.assertEqual([s['step'] for s in initial['steps']],
                         ['genotype', 'expression', 'adjust', 'cis', 'network', 'visualize'])
        self.assertEqual(initial['steps'][-1]['phase'], 'not_started')
        self.assertEqual(self.submit()[0], 202)
        self.slurm(squeue='PENDING')
        self.assertEqual(self.call('GET', status_path)[1]['state'], 'pending')
        self.assertEqual(analysis()['steps'][1]['phase'], 'queued')
        self.finish_job(exit_code='1')
        self.assertEqual(self.call('GET', status_path)[1]['state'], 'failed')
        self.assertEqual(analysis()['steps'][1]['phase'], 'failed')
        self.slurm(sbatch_reply='222')
        self.assertEqual(self.call('PATCH', path + '/settings', {'values': {'restrict.tcga': 1}})[0], 200)
        self.assertEqual(self.submit()[0], 202)
        self.finish_job()
        marker = self.remote_dir / 'steps/expression.done'
        marker.unlink()
        self.assertEqual(self.call('GET', status_path)[1]['state'], 'validating')
        self.assertEqual(analysis()['steps'][1]['phase'], 'validating')
        self.finish_job()
        self.lose_connection_on = 'tar czf'
        self.assertEqual(self.call('GET', status_path)[1]['state'], 'validating')
        waiting = analysis()
        self.assertEqual(waiting['completed_steps'], 0)
        self.assertEqual(waiting['steps'][1]['phase'], 'downloading')
        self.lose_connection_on = None
        self.assertEqual(self.call('GET', status_path)[1]['state'], 'completed')
        completed = analysis()
        self.assertEqual(completed['completed_steps'], 1)
        step = completed['steps'][1]
        self.assertEqual(step['phase'], 'completed')
        self.assertEqual([(a['attempt'], a['job_id'], a['state']) for a in step['attempts']],
                         [(1, '12345', 'failed'), (2, '222', 'completed')])
        self.assertNotEqual(step['attempts'][0]['settings']['restrict.tcga'], '1')
        self.assertEqual(step['attempts'][1]['settings']['restrict.tcga'], '1')
        self.assertEqual(sum('sbatch --parsable' in c for c in self.calls), 2)

    def test_corrupt_or_incomplete_download_does_not_complete_or_submit_again(self):
        self.assertEqual(self.submit()[0], 202)
        self.finish_job()
        path = '/signet/runs/step_test/steps/expression?refresh=1'
        partial = io.BytesIO()
        with tarfile.open(fileobj=partial, mode='w:gz') as archive:
            member = tarfile.TarInfo('work/' + test_signet_jobs.OUTPUTS[0])
            member.size = 1
            archive.addfile(member, io.BytesIO(b'x'))

        for content in (b'not a tar archive', partial.getvalue()):
            def remote(command, **kwargs):
                if 'tar czf' in command:
                    return CompletedProcess(command, 0, content, b'')
                return self.remote(command, **kwargs)

            with patch.object(ssh_transport, 'remote', side_effect=remote):
                status, record = self.call('GET', path)
            self.assertEqual((status, record['state'], record['job_id']), (200, 'validating', '12345'))
            self.assertTrue(record['download_pending'])
            self.assertFalse((self.root / 'work' / test_signet_jobs.OUTPUTS[0]).exists())
            self.assertEqual(self.submit()[0], 409)
        status, record = self.call('GET', path)
        self.assertEqual((status, record['state'], record['job_id']), (200, 'completed', '12345'))
        self.assertEqual(sum('sbatch --parsable' in c for c in self.calls), 1)

    def test_settings_patch_is_whitelisted(self):
        status, value = self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'restrict.tcga': 1}})
        self.assertEqual((status, value['settings']['restrict.tcga']), (200, '1'))
        for bad in ({'values': {'forcerm': 'T'}}, {'values': {'restrict.tcga': 30}}, {'restrict.tcga': 1}, {}):
            self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', bad)[0], 400, bad)
        self.assertEqual(self.call('PATCH', '/signet/runs/missing/settings', {'values': {'restrict.tcga': 1}})[0], 404)

    def test_step_lifecycle_submit_status_log_and_finished_cancel(self):
        status, value = self.submit()
        self.assertEqual((status, value['state'], value['job_id']), (202, 'submitted', '12345'))
        self.assertEqual(self.submit()[1]['code'], 'conflict')
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'restrict.tcga': 2}})[0], 409)
        self.slurm(squeue='RUNNING')
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression?refresh=1')
        self.assertEqual((status, value['state']), (200, 'running'))
        (self.remote_dir / 'steps/expression.out').write_text('one\ntwo\nthree\n')
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression/log?lines=2')
        self.assertEqual((status, value), (200, {'lines': ['two', 'three'], 'truncated': True}))
        self.finish_job()
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression?refresh=1')
        self.assertEqual((status, value['state']), (200, 'completed'))
        self.assertEqual(self.call('GET', '/signet/runs/step_test')[1]['steps']['expression']['state'], 'completed')
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression/cancel')[0], 409)

    def test_cancel_running_step(self):
        self.submit()
        self.slurm(squeue='RUNNING', name='signet-expression-step_test')
        status, value = self.call('POST', '/signet/runs/step_test/steps/expression/cancel', {})
        self.assertEqual((status, value['state']), (200, 'cancelling'))
        self.assertEqual(self.submit()[0], 409)
        self.slurm(squeue='', sacct='CANCELLED')
        status, value = self.call('GET', '/signet/runs/step_test/steps/expression?refresh=1')
        self.assertEqual((status, value['state']), (200, 'cancelled'))
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression/cancel', {'force': True})[0], 400)

    def test_scheduler_outage_keeps_unknown_submission_recoverable_over_http(self):
        self.lose_connection_on = 'sbatch --parsable'
        status, value = self.submit()
        self.assertEqual((status, value['state']), (202, 'unknown'))
        self.lose_connection_on = None
        for name in ('squeue', 'sacct'):
            (self.fake / 'bin' / name).write_text('#!/bin/bash\nexit 1\n')
        path = '/signet/runs/step_test/steps/expression'
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state']), (200, 'unknown'))
        self.assertEqual(self.submit()[0], 409)
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings',
                                   {'values': {'restrict.tcga': 1}})[0], 409)
        for name in ('squeue', 'sacct'):
            (self.fake / 'bin' / name).write_text('#!/bin/bash\n' + test_signet_jobs.FAKE_SLURM[name] + '\n')
        self.slurm(queued_id='888', squeue='RUNNING')
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state'], value['job_id']), (200, 'running', '888'))
        self.finish_job()
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state']), (200, 'completed'))

    def test_network_cancel_after_parent_ended_keeps_http_settings_locked(self):
        (self.root / 'steps').mkdir()
        (self.remote_dir / 'steps').mkdir(parents=True)
        record = {'step': 'network', 'run_id': 'step_test', 'remote_dir': str(self.remote_dir),
                  'job_id': '12345', 'state': 'running'}
        (self.root / 'steps/network.json').write_text(json.dumps(record))
        test_signet_jobs.StepsTest.signet_children(self)
        self.slurm(squeue='', sacct='CANCELLED')
        path = '/signet/runs/step_test/steps/network'
        status, value = self.call('POST', path + '/cancel', {})
        self.assertEqual((status, value['state']), (200, 'cancelling'))
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'nboots': 2}})[0], 409)
        self.assertEqual(self.call('POST', path, {'inputs': {}})[0], 409)
        (self.fake / 'workdir_777').unlink()
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state']), (200, 'cancelled'))
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'nboots': 2}})[0], 200)

    def test_network_done_marker_without_accounting_waits_for_children_over_http(self):
        from agent.runtime import signet_jobs
        (self.root / 'steps').mkdir()
        (self.remote_dir / 'steps').mkdir(parents=True)
        (self.root / 'steps/network.json').write_text(json.dumps({
            'step': 'network', 'run_id': 'step_test', 'remote_dir': str(self.remote_dir),
            'job_id': '12345', 'state': 'running'}))
        test_signet_jobs.StepsTest.signet_children(self)
        for relative in signet_jobs.STEPS['network'].required:
            path = self.remote_dir / 'work' / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('fresh output\n')
        (self.remote_dir / 'steps/network.done').write_text('0 2026-11-10T00:00:00-08:00\n')
        self.slurm(squeue='', sacct='')
        path = '/signet/runs/step_test/steps/network?refresh=1'
        self.assertEqual(self.call('GET', path)[1]['state'], 'validating')
        self.assertEqual(self.call('PATCH', '/signet/runs/step_test/settings', {'values': {'nboots': 2}})[0], 409)
        self.assertFalse((self.root / 'work/res/resn/signet_Afreq').exists())
        (self.fake / 'workdir_777').unlink()
        queue = self.fake / 'bin/squeue'
        queue.write_text('#!/bin/bash\nexit 1\n')
        self.assertEqual(self.call('GET', path)[1]['state'], 'validating')
        self.assertFalse((self.root / 'work/res/resn/signet_Afreq').exists())
        queue.write_text('#!/bin/bash\n' + test_signet_jobs.FAKE_SLURM['squeue'] + '\n')
        status, value = self.call('GET', path)
        self.assertEqual((status, value['state']), (200, 'completed'))
        self.assertEqual((self.root / 'work/res/resn/signet_Afreq').read_text(), 'fresh output\n')

    def test_retry_never_returns_previous_outputs_over_http(self):
        self.submit()
        self.finish_job(err='Error in fread(x): failed\n')
        path = '/signet/runs/step_test/steps/expression'
        self.assertEqual(self.call('GET', path + '?refresh=1')[1]['state'], 'failed')
        for relative in test_signet_jobs.OUTPUTS:
            (self.remote_dir / 'work' / relative).write_text('old-attempt-only\n')
        changed = self.hpc / 'ws/refdata/new_counts'
        changed.write_text('new input\n')
        self.slurm(sbatch_reply='222')
        status, record = self.call('POST', path, {'inputs': {**self.inputs, 'gexp.file': str(changed)}})
        self.assertEqual((status, record['job_id']), (202, '222'))
        self.finish_job(outputs=())
        status, record = self.call('GET', path + '?refresh=1')
        self.assertEqual(status, 200)
        self.assertNotEqual(record['state'], 'completed')
        self.assertFalse((self.root / 'work' / test_signet_jobs.OUTPUTS[0]).exists())

    def test_refresh_downloads_later_visible_outputs_over_http_without_new_job(self):
        self.submit()
        path = '/signet/runs/step_test/steps/expression'
        self.finish_job(outputs=())
        self.assertNotEqual(self.call('GET', path + '?refresh=1')[1]['state'], 'completed')
        self.finish_job()
        status, record = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, record['state'], record['job_id']), (200, 'completed', '12345'))
        self.assertEqual((self.root / 'work' / test_signet_jobs.OUTPUTS[0]).read_text(), 'data\n')
        self.assertEqual(sum('sbatch --parsable' in call for call in self.calls), 1)

    def test_sbatch_refusal_keeps_an_independent_attempt_over_http(self):
        self.submit()
        self.finish_job(outputs=())
        path = '/signet/runs/step_test/steps/expression'
        self.assertEqual(self.call('GET', path + '?refresh=1')[1]['state'], 'failed')
        batch = self.fake / 'bin/sbatch'
        batch.write_text('#!/bin/bash\necho temporarily-refused >&2\nexit 1\n')
        self.assertEqual(self.submit()[0], 502)
        record = self.call('GET', path)[1]
        self.assertEqual((record['state'], record['attempt']), ('failed', 2))
        batch.write_text('#!/bin/bash\n' + test_signet_jobs.FAKE_SLURM['sbatch'] + '\n')
        self.slurm(sbatch_reply='222')
        status, record = self.submit()
        self.assertEqual((status, record['attempt']), (202, 3))
        self.assertIn('temporarily-refused', (self.remote_dir / 'steps/expression.attempt2.sbatch.err').read_text())

    def test_refresh_recovers_a_saved_missing_marker_failure_and_downloads_results(self):
        status, record = self.submit()
        self.assertEqual(status, 202)
        self.finish_job()
        record.update(state='failed', slurm_state='COMPLETED', exit_code=None,
                      reason='The job did not finish its last line.', finished_at='2026-11-01T10:00:01')
        (self.root / 'steps/expression.json').write_text(json.dumps(record))
        path = '/signet/runs/step_test/steps/expression'
        self.assertEqual(self.call('GET', path)[1]['state'], 'failed')
        status, value = self.call('GET', path + '?refresh=1')
        self.assertEqual((status, value['state'], value['job_id']), (200, 'completed', '12345'))
        self.assertEqual((self.root / 'work/res/rest/signet_gexp').read_text(), 'data\n')
        self.assertEqual(sum('sbatch --parsable' in call for call in self.calls), 1)

    def test_unexpected_error_still_gets_a_json_reply(self):
        (self.project / 'runs/broken').mkdir()
        (self.project / 'runs/broken/manifest.json').write_text('{not json')
        with patch('sys.stderr'):
            status, value = self.call('GET', '/signet/runs')
        self.assertEqual((status, value['code']), (500, 'internal_error'))
        self.assertNotIn('JSONDecodeError', value['error'])

    def test_step_errors_map_to_status_codes(self):
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression', {'inputs': {'gexp.file': '/etc/passwd'}})[0], 400)
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/expression', {})[0], 400)
        self.assertEqual(self.call('POST', '/signet/runs/step_test/steps/visualize', {'inputs': {}})[0], 400)
        self.assertEqual(self.call('GET', '/signet/runs/step_test/steps/expression')[0], 404)
        for query in ('refresh=2', 'stream=out&stream=err', 'other=1'):
            self.assertEqual(self.call('GET', f'/signet/runs/step_test/steps/expression?{query}')[0], 400, query)
        with patch.object(ssh_transport, 'available', return_value=False):
            status, value = self.submit()
            self.assertEqual((status, value['code']), (412, 'not_ready'))
        self.lose_connection_on = 'tar xzf'
        status, value = self.submit()
        self.assertEqual((status, value['code']), (502, 'remote_failed'))
        self.lose_connection_on = None
        self.submit()
        for query in ('lines=0', 'lines=201', 'lines=abc', 'stream=all'):
            self.assertEqual(self.call('GET', f'/signet/runs/step_test/steps/expression/log?{query}')[0], 400, query)


if __name__ == '__main__':
    unittest.main()
