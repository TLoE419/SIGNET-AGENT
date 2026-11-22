from contextlib import ExitStack
import json
import hashlib
from pathlib import Path
import shlex
import tempfile
import unittest
from unittest.mock import patch

from agent.runtime import signet_jobs as jobs, workspace_genotype as workspace
from agent.runtime.jobs.review_clinical import review
from agent.runtime.jobs import review_clinical


class ClinicalChoicesTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.folder = Path(temporary.name).resolve()
        self.clinical = self.folder / 'clinical.tsv'
        self.clinical.write_bytes(b'submitter_id\trace\tgender\r\n'
            b'TCGA-AA-0001\tasian\tfemale\r\nTCGA-AA-0002\tblack or african american\tmale\r\n'
            b'TCGA-AA-0003\twhite\tfemale\r\nTCGA-AA-0004\tother\tmale\r\n')
        self.genotype, self.expression = self.folder / 'genotype-ids', self.folder / 'expression-ids'
        for path in (self.genotype, self.expression):
            path.write_text(''.join(f'TCGA-AA-{number:04}-01\n' for number in range(1, 5)))

    def test_unknown_race_requires_explicit_choice_and_returns_counts_only(self):
        result = review(self.clinical, self.genotype, self.expression)
        self.assertEqual(result['needs_choice'], ['other'])
        self.assertEqual(result['unrecognized_race'], {'other': 1})
        self.assertTrue(result['issues'])
        self.assertNotIn('TCGA-', json.dumps(result))

    def test_both_choices_preserve_original_and_write_unix_copy(self):
        original = self.clinical.read_bytes()
        for choice, replacement, retained in [('not_reported', 'not reported', 4), ('exclude', 'american indian or alaska native', 3)]:
            out = self.folder / choice / 'clinical.tsv'
            result = review(self.clinical, self.genotype, self.expression, {'other': choice}, out)
            self.assertFalse(result['issues'])
            self.assertTrue(result['written'])
            self.assertEqual(result['retained'], retained)
            self.assertIn(replacement, out.read_text())
            self.assertNotIn(b'\r', out.read_bytes())
            self.assertEqual(self.clinical.read_bytes(), original)
            self.assertTrue(review(self.clinical, self.genotype, self.expression, {'other': choice}, out)['written'])

    def test_copy_conflict_symlink_and_invalid_choices_are_refused(self):
        out = self.folder / 'copy.tsv'
        out.write_text('preserved')
        with self.assertRaises(ValueError):
            review(self.clinical, self.genotype, self.expression, {'other': 'exclude'}, out)
        self.assertEqual(out.read_text(), 'preserved')
        for choices in ([], {'other': 'automatic'}, {'other': []}):
            with self.assertRaises(ValueError):
                review(self.clinical, self.genotype, self.expression, choices)
        link = self.folder / 'link.tsv'
        link.symlink_to(self.clinical)
        with self.assertRaises(ValueError):
            review(self.clinical, self.genotype, self.expression, {'other': 'exclude'}, link)

    def test_missing_gender_and_missing_patients_cannot_be_overridden(self):
        self.clinical.write_text(self.clinical.read_text().replace('other\tmale', 'other\tunknown'))
        self.assertTrue(review(self.clinical, self.genotype, self.expression, {'other': 'not_reported'})['issues'])
        self.expression.write_text(self.expression.read_text() + 'TCGA-AA-9999-01\n')
        self.genotype.write_text(self.genotype.read_text() + 'TCGA-AA-9999-01\n')
        result = review(self.clinical, self.genotype, self.expression, {'other': 'exclude'})
        self.assertTrue(any('missing' in issue for issue in result['issues']))

    def test_linked_parent_is_refused_before_any_foreign_directory_is_created(self):
        owner, foreign = self.folder / 'owned', self.folder / 'foreign'
        owner.mkdir()
        foreign.mkdir()
        (owner / 'inputs').symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(ValueError):
            review(self.clinical, self.genotype, self.expression, {'other': 'exclude'},
                   owner / 'inputs/clinical/review1/clinical.tsv')
        self.assertEqual(list(foreign.iterdir()), [], 'canonical checks must precede mkdir')

    def test_raced_destination_and_existing_partial_are_never_overwritten(self):
        out = self.folder / 'copy/clinical.tsv'
        link = review_clinical.os.link
        def raced(source, destination):
            Path(destination).write_text('foreign copy must survive\n')
            return link(source, destination)
        with patch.object(review_clinical.os, 'link', side_effect=raced), self.assertRaises(ValueError):
            review(self.clinical, self.genotype, self.expression, {'other': 'exclude'}, out)
        self.assertEqual(out.read_text(), 'foreign copy must survive\n')
        self.assertFalse(out.with_suffix('.tsv.partial').exists())
        out.unlink()
        partial = out.with_suffix('.tsv.partial')
        partial.write_text('foreign partial must survive\n')
        with self.assertRaises(FileExistsError):
            review(self.clinical, self.genotype, self.expression, {'other': 'exclude'}, out)
        self.assertEqual(partial.read_text(), 'foreign partial must survive\n')

    def review_fixture(self):
        """Use the actual read/copy helper behind the workspace review transport seam."""
        self.run_id = 'reviewed'
        self.root = self.folder / 'runs' / self.run_id
        (self.root / 'steps').mkdir(parents=True)
        self.remote = self.folder / 'remote-runs' / self.run_id
        self.source = self.folder / 'refdata/clinical.tsv'
        self.source.parent.mkdir()
        self.source.write_bytes(self.clinical.read_bytes())
        for relative, source in (('res/resg/signet_Genotype.sampleID', self.genotype),
                                 ('res/rest/signet_gexpID', self.expression)):
            target = self.remote / 'work' / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        self.config = {'root': str(self.folder), 'source': str(self.folder / 'software/pinned'),
            'image': str(self.folder / 'images/signet.sif'), 'executor': '/bin/echo',
            'workRoot': str(self.remote.parent), 'partition': 'fixture'}
        self.history = {'jobs': {name: {'run_id': self.run_id, 'step': name, 'state': 'completed',
            'job_id': str(index), 'remote_dir': str(self.remote), 'image': self.config['image'],
            'partition': 'fixture'} for index, name in enumerate(('genotype', 'expression'), 123)}}
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(workspace, '_workspace_run', return_value=(self.root, self.history)))
        stack.enter_context(patch.object(workspace, '_initial', return_value={}))
        stack.enter_context(patch.object(workspace, '_dataset_id', return_value='dataset'))
        stack.enter_context(patch.object(jobs, '_environment', return_value=self.config))
        stack.enter_context(patch.object(jobs, '_remote_dir', return_value=str(self.remote)))
        stack.enter_context(patch.object(jobs, '_active_step', return_value=None))
        stack.enter_context(patch.object(jobs, '_output_guard', return_value=':\n'))
        self.shell = stack.enter_context(patch.object(jobs, '_shell', side_effect=self.clinical_shell))
        self.submitted = stack.enter_context(patch.object(jobs, 'submit', return_value={'state': 'queued'}))

    def clinical_shell(self, script):
        args = shlex.split(next(line for line in script.splitlines() if line.startswith('python3 - ')))
        arguments = [arg for arg in args[2:] if not arg.startswith('<<')]
        value = review(*arguments[:3], json.loads(arguments[3]), arguments[4] if len(arguments) > 4 else None)
        return 0, {'clinical': json.dumps(value)}, []

    def checked_review(self, source=None, choices=None):
        return workspace.review_adjust(self.run_id, str(source or self.source), choices or {'other': 'exclude'})

    def checked_submit(self, token, choices=None):
        return workspace.submit_adjust(self.run_id, {'cli.file': str(self.source)}, {'npc': 3},
            jobs.STEPS['adjust'].resources, choices or {'other': 'exclude'}, token)

    def test_review_token_binds_source_path_choices_and_both_upstream_identities(self):
        self.review_fixture()
        baseline = self.checked_review()
        token = baseline['review_token']
        self.assertEqual(len(token), 64)
        self.assertEqual(token, self.checked_review()['review_token'])
        other = self.source.with_name('other.tsv')
        other.write_bytes(self.source.read_bytes())
        self.assertNotEqual(token, self.checked_review(other)['review_token'], 'same bytes at another selected path need review')
        self.assertNotEqual(token, self.checked_review(choices={'other': 'not_reported'})['review_token'])
        for step in ('genotype', 'expression'):
            old = self.history['jobs'][step]['job_id']
            self.history['jobs'][step]['job_id'] = '9999'
            self.assertNotEqual(token, self.checked_review()['review_token'])
            self.history['jobs'][step]['job_id'] = old
        identifiers = self.remote / 'work/res/resg/signet_Genotype.sampleID'
        identifiers.write_text(identifiers.read_text().replace('-01', '-02'))
        self.assertNotEqual(token, self.checked_review()['review_token'], 'same matched patients with changed ID files need review')
        self.assertNotIn('TCGA-', json.dumps(baseline))
        unknown = workspace.review_adjust(self.run_id, str(self.source))
        self.assertFalse(unknown['ready'])
        self.assertNotIn('review_token', unknown)

    def test_stale_review_token_refuses_before_copy_or_scheduler_submission(self):
        self.review_fixture()
        token = self.checked_review()['review_token']
        self.source.write_bytes(self.source.read_bytes() + b'\n')
        with self.assertRaises(jobs.StepError) as caught:
            self.checked_submit(token)
        self.assertEqual(caught.exception.code, 'review_required')
        self.submitted.assert_not_called()
        self.assertFalse((self.remote / 'inputs/clinical').exists())

    def test_mid_copy_change_preserves_copy_and_old_review_then_new_review_can_progress(self):
        self.review_fixture()
        old_snapshot = {'review_attempt': 1, 'run_id': self.run_id, 'dataset_id': 'dataset'}
        path = self.root / workspace.ADJUST_SNAPSHOT
        path.write_text(json.dumps(old_snapshot))
        token = self.checked_review()['review_token']
        original_shell = self.clinical_shell
        changed = False
        def change_before_copy(script):
            nonlocal changed
            if '/inputs/clinical/' in script and not changed:
                changed = True
                self.source.write_bytes(self.source.read_bytes() + b'\n')
            return original_shell(script)
        self.shell.side_effect = change_before_copy
        with self.assertRaises(jobs.StepError) as caught:
            self.checked_submit(token)
        self.assertEqual(caught.exception.code, 'review_required')
        self.submitted.assert_not_called()
        preserved = self.remote / f'inputs/clinical/review2-{token}/clinical.tsv'
        self.assertTrue(preserved.is_file())
        self.assertEqual(json.loads(path.read_text()), old_snapshot)
        self.assertFalse((self.root / 'workspace-adjust.review1.json').exists(), 'failed preparation must not block the next review')
        updated = self.checked_review()['review_token']
        self.assertNotEqual(token, updated)
        self.checked_submit(updated)
        self.submitted.assert_called_once()
        self.assertTrue(preserved.is_file())
        self.assertEqual(self.submitted.call_args.args[2],
                         {'cli.file': str(self.remote / f'inputs/clinical/review2-{updated}/clinical.tsv')})
        self.assertEqual(json.loads((self.root / 'workspace-adjust.review1.json').read_text()), old_snapshot)

    def test_frozen_clinical_repair_preserves_initial_inputs_and_requires_fresh_review(self):
        self.review_fixture()
        frozen = self.remote / 'inputs/frozen/clinical'
        frozen.parent.mkdir(parents=True)
        frozen.write_text('submitter_id\trace\nTCGA-AA-0001\twhite\n')
        initial = {'mode': 'dataset', 'frozen_inputs': {'clinical': [str(frozen)]}, 'genotype_attempt': 1}
        initial_path = self.root / workspace.SNAPSHOT
        initial_path.write_text(json.dumps(initial))
        originals = {frozen: frozen.read_bytes(), initial_path: initial_path.read_bytes()}
        for name, record in self.history['jobs'].items():
            path = self.root / 'steps' / (name + '.json')
            path.write_text(json.dumps(record))
            originals[path] = path.read_bytes()
        with patch.object(workspace, '_initial', return_value=initial), \
                patch('agent.runtime.workspace_inputs.frozen_checks', return_value='FROZEN_INPUTS_GUARD\n') as guard:
            blocked = workspace.review_adjust(self.run_id)
            self.assertFalse(blocked['ready'])
            self.assertFalse(blocked['clinical_replacement'])
            self.assertTrue(blocked['clinical_replacement_allowed'])
            self.assertEqual(blocked['inputs']['cli.file'], str(frozen))
            corrected = self.checked_review()
            self.assertTrue(corrected['ready'], corrected['issues'])
            self.assertTrue(corrected['clinical_replacement'])
            self.assertTrue(corrected['clinical_replacement_allowed'])
            self.assertNotIn('TCGA-', json.dumps(corrected))
            token = corrected['review_token']
            source_bytes = self.source.read_bytes()
            self.source.write_bytes(source_bytes + b'\n')
            with self.assertRaises(jobs.StepError) as caught:
                self.checked_submit(token)
            self.assertEqual(caught.exception.code, 'review_required')
            self.submitted.assert_not_called()
            self.assertFalse((self.remote / 'inputs/clinical').exists())
            refreshed = self.checked_review()
            self.assertNotEqual(token, refreshed['review_token'])
            self.checked_submit(refreshed['review_token'])
            self.submitted.assert_called_once()
            self.assertTrue(all('FROZEN_INPUTS_GUARD' in call.args[0] for call in self.shell.call_args_list))
            guard.assert_called_with(str(self.remote), 1)
        saved = json.loads((self.root / workspace.ADJUST_SNAPSHOT).read_text())
        self.assertEqual(saved['clinical']['source'], str(self.source))
        self.assertEqual(saved['clinical']['choices'], {'other': 'exclude'})
        self.assertEqual(saved['clinical']['review']['source_digest'], hashlib.sha256(self.source.read_bytes()).hexdigest())
        self.assertEqual(saved['inputs']['cli.file'], self.submitted.call_args.args[2]['cli.file'])
        self.assertNotEqual(saved['inputs']['cli.file'], str(frozen))
        self.assertNotEqual(saved['inputs']['cli.file'], str(self.source))
        self.assertTrue(Path(saved['inputs']['cli.file']).is_file())
        for path, content in originals.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(self.history['jobs']['genotype']['job_id'], '123')
        self.assertEqual(self.history['jobs']['expression']['job_id'], '124')

    def test_frozen_clinical_replacement_keeps_roots_and_execution_state_guards(self):
        self.review_fixture()
        frozen = self.remote / 'inputs/frozen/clinical'
        frozen.parent.mkdir(parents=True)
        frozen.write_bytes(self.source.read_bytes())
        initial = {'mode': 'dataset', 'frozen_inputs': {'clinical': [str(frozen)]}, 'genotype_attempt': 1}
        with patch.object(workspace, '_initial', return_value=initial), \
                patch('agent.runtime.workspace_inputs.frozen_checks', return_value=':\n'):
            for state in ('running', 'unknown', 'completed'):
                self.history['jobs']['adjust'] = {'state': state}
                with self.subTest(state=state), self.assertRaises(jobs.StepError) as caught:
                    self.checked_review()
                self.assertEqual(caught.exception.code, 'conflict')
            self.history['jobs'].pop('adjust')
            with patch.object(jobs, '_active_step', return_value='network'), self.assertRaises(jobs.StepError):
                self.checked_review()
            self.history['jobs']['genotype']['state'] = 'failed'
            with self.assertRaises(jobs.StepError):
                self.checked_review()
            self.history['jobs']['genotype']['state'] = 'completed'
            with self.assertRaises(jobs.StepError) as caught:
                self.checked_review(self.folder / 'outside-roots.tsv')
            self.assertEqual(caught.exception.code, 'invalid_request')
            marker = self.root / '.active'
            marker.touch()
            with self.assertRaises(jobs.StepError):
                self.checked_review()
            marker.unlink()
            for state in ('not_submitted', 'failed', 'cancelled'):
                self.history['jobs']['adjust'] = {'state': state}
                self.assertTrue(self.checked_review()['clinical_replacement_allowed'])
        self.submitted.assert_not_called()

    def test_manual_api_requires_a_review_token_and_passes_it_to_the_service(self):
        import io
        from types import SimpleNamespace
        from urllib.parse import urlsplit
        from unittest.mock import Mock
        from agent.app import signet_api
        body = {'inputs': {'cli.file': '/remote/clinical.tsv'}, 'options': {'npc': 3}, 'resources': {}}
        def request(value):
            raw = json.dumps(value).encode()
            handler = SimpleNamespace(headers={'Content-Length': str(len(raw))}, rfile=io.BytesIO(raw), connection=Mock())
            return signet_api.submit_adjust_example(handler, urlsplit('/signet/runs/reviewed/adjust/example'), 'reviewed')
        with patch.object(workspace, 'submit_adjust', return_value={'state': 'queued'}) as submitted:
            for changed in (body, {**body, 'review_token': None}, {**body, 'review_token': 'stale'}):
                with self.subTest(body=changed), self.assertRaises(signet_api.ApiError) as caught:
                    request(changed)
                self.assertEqual(caught.exception.status, 400)
            submitted.assert_not_called()
            token = 'a' * 64
            self.assertEqual(request({**body, 'review_token': token, 'choices': {'other': 'exclude'}})[0], 202)
            self.assertEqual(submitted.call_args.kwargs['review_token'], token)
            self.assertEqual(submitted.call_args.kwargs['choices'], {'other': 'exclude'})
        self.assertEqual(signet_api.STATUS['review_required'], 409)

    def test_manual_submit_saves_source_choices_and_uses_separate_copy(self):
        root = self.folder / 'runs' / 'reviewed'
        (root / 'steps').mkdir(parents=True)
        source = '/remote/refdata/clinical.tsv'
        checks = []
        def checked(run_id, clinical=None, choices=None, out=None):
            checks.append((clinical, choices, out))
            return {'ready': True, 'inputs': {'cli.file': source}, 'reason': '', 'clinical': {'written': bool(out)}}
        def submit(run_id, step, inputs, resources, options):
            record = {'run_id': run_id, 'step': step, 'state': 'queued', 'inputs': inputs}
            jobs._save(root, record)
            return record
        with patch.object(workspace, '_workspace_run', return_value=(root, {})), \
             patch.object(jobs, '_active_step', return_value=None), \
             patch.object(workspace, '_review_adjust', side_effect=checked), \
             patch.object(workspace, '_dataset_id', return_value='dataset'), \
             patch.object(jobs, '_environment', return_value={}), \
             patch.object(jobs, '_remote_dir', return_value='/remote/runs/reviewed'), \
             patch.object(jobs, 'submit', side_effect=submit) as submitted:
            result = workspace.submit_adjust('reviewed', {'cli.file': source}, {'npc': 3},
                jobs.STEPS['adjust'].resources, {'other': 'exclude'})
        copy = '/remote/runs/reviewed/inputs/clinical/review1/clinical.tsv'
        self.assertEqual(checks, [(source, {'other': 'exclude'}, None), (source, {'other': 'exclude'}, copy)])
        self.assertEqual(submitted.call_args.args[2], {'cli.file': copy})
        self.assertEqual(result['clinical']['source'], source)
        self.assertEqual(result['clinical']['choices'], {'other': 'exclude'})
        self.assertTrue(result['clinical']['review']['written'])
        saved = json.loads((root / workspace.ADJUST_SNAPSHOT).read_text())
        self.assertEqual(saved['clinical'], result['clinical'])
        self.assertEqual(saved['inputs'], {'cli.file': copy})


if __name__ == '__main__':
    unittest.main()
