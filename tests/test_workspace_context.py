import unittest
from copy import deepcopy
from agent.runtime.workspace_context import validate


class WorkspaceContextTests(unittest.TestCase):
    def setUp(self):
        self.catalog = {'datasets': [{'id': 'cohort-a'}, {'id': 'cohort-b'}], 'runs': [
            {'history_id': 'workspace--same', 'run_id': 'same', 'source': 'live', 'dataset_id': 'cohort-a'},
            {'history_id': 'archive--same', 'run_id': 'same', 'source': 'archive', 'dataset_id': 'cohort-b'}]}
        self.value = dict(version=1, dataset_id='cohort-a', history_id='workspace--same', stage=6, selected_genes=['MEGF6'])

    def resolve(self, value):
        return validate(value, lambda: self.catalog)

    def test_canonical_source_and_dataset(self):
        self.assertEqual(self.resolve(self.value)['source'], 'live')
        self.value.update(dataset_id='cohort-b', history_id='archive--same')
        self.assertEqual(self.resolve(self.value)['source'], 'archive')
        self.value['dataset_id'] = 'cohort-a'
        with self.assertRaises(ValueError): self.resolve(self.value)

    def test_bounds_and_no_private_fields(self):
        for patch in ({'stage': True}, {'stage': 7}, {'version': True}, {'history_id': 'same'},
                      {'selected_genes': ['a'] * 33}, {'selected_genes': ['a', 'a']},
                      {'selected_genes': ['secret\nkey']}, {'selected_genes': ['a' * 65]},
                      {'dataset_id': '../cohort-a'}, {'matrix': [[1]]}, {'api_key': 'private'}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.resolve(dict(self.value, **patch))

    def test_missing_and_unselected_do_not_inherit(self):
        self.assertIsNone(self.resolve(None))
        self.value.update(history_id=None, selected_genes=[])
        self.assertNotIn('run_id', self.resolve(self.value))
        self.value['selected_genes'] = ['MEGF6']
        with self.assertRaises(ValueError): self.resolve(self.value)

    def test_dataset_reassignment_invalidates_next_request(self):
        self.resolve(self.value)
        self.catalog['runs'][0]['dataset_id'] = 'cohort-b'
        with self.assertRaises(ValueError): self.resolve(self.value)

    def test_deleted_dataset_remains_valid_only_as_existing_history_context(self):
        self.catalog['datasets'] = self.catalog['datasets'][1:]
        self.catalog['runs'][0]['dataset_deleted'] = True
        self.assertEqual(self.resolve(self.value)['run_id'], 'same')
        with self.assertRaises(ValueError):
            self.resolve(dict(self.value, history_id=None, selected_genes=[]))

    def test_no_scientific_payload_leaks(self):
        self.catalog['runs'][0].update(inputs={'clinical': 'private'}, secret='key')
        result = self.resolve(self.value)
        self.assertEqual(set(result), set(self.value) | {'source', 'run_id'})
        result['selected_genes'].append('OTHER')
        self.assertEqual(self.value['selected_genes'], ['MEGF6'])
