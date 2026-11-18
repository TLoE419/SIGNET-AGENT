"""Pure metadata tests; no project, chat, filesystem, model or remote runtime is used."""
from copy import deepcopy
import unittest
from agent.runtime.workspace_run_labels import enrich_rows


def row(name, dataset='study', parent=None, created='2026-11-18T10:00:00Z', **extra):
    value = {'source': 'live', 'run_id': name, 'dataset_id': dataset, 'jobs': {
        'adjust': {'settings': {}, 'resources': {'cpus': 4, 'hours': 2}, 'options': {'npc': 3},
                   'clinical': {'choices': {'other': 'exclude'}}}}}
    if parent:
        value['rerun'] = {'source_run_id': parent, 'step': 'adjust', 'created_at': created}
    value.update(extra)
    return value


class RunLabelsTest(unittest.TestCase):
    def test_branching_family_numbers_and_latest_follow_provenance_not_row_or_chat_order(self):
        rows = [row('grandchild', parent='first', created='2026-11-18T10:00:03Z'),
                row('other-original'), row('second', parent='original', created='2026-11-18T10:00:02Z'),
                row('original'), row('first', parent='original', created='2026-11-18T10:00:01Z')]
        original = deepcopy(rows)
        result = enrich_rows(rows)
        self.assertEqual(rows, original)
        self.assertEqual([r['run_id'] for r in result], [r['run_id'] for r in rows])
        families = {r['run_id']: r['rerun_family'] for r in result}
        self.assertEqual([families[key]['number'] for key in ('original', 'first', 'second', 'grandchild')], [0, 1, 2, 3])
        self.assertTrue(families['grandchild']['latest'])
        self.assertFalse(families['original']['latest'])
        self.assertEqual(families['grandchild']['source_run'], 'first')
        self.assertEqual(families['grandchild']['root_run'], 'original')
        self.assertEqual(families['other-original']['root_run'], 'other-original')
        rows[0]['session'], rows[3]['session'] = 'unrelated-chat', 'other-chat'
        self.assertEqual([r['rerun_family'] for r in enrich_rows(rows)], [r['rerun_family'] for r in result])

    def test_changes_include_actual_parameters_resources_options_and_clinical_choices(self):
        parent, child = row('original'), row('fork', parent='original')
        child['jobs']['adjust']['resources'] = {'cpus': '4', 'hours': 4}
        child['jobs']['adjust']['options']['npc'] = 5
        child['jobs']['adjust']['clinical']['choices']['other'] = 'not_reported'
        child['jobs']['adjust']['inputs'] = {'cli.file': '/different-owned-copy'}
        child['jobs']['adjust']['state'] = 'running'
        family = enrich_rows([parent, child])[1]['rerun_family']
        self.assertEqual(family['changes'], [
            {'group': 'resources', 'key': 'hours', 'before': 2, 'after': 4},
            {'group': 'options', 'key': 'npc', 'before': 3, 'after': 5},
            {'group': 'clinical_choices', 'key': 'other', 'before': 'exclude', 'after': 'not_reported'}])
        self.assertTrue(family['changes_available'])

    def test_unrecorded_clinical_choices_are_not_reported_as_removed(self):
        parent, child = row('original'), row('fork', parent='original')
        child['jobs']['adjust'].pop('clinical')
        self.assertEqual(enrich_rows([parent, child])[1]['rerun_family']['changes'], [])
        child['jobs']['adjust']['clinical'] = {'choices': {}}
        self.assertEqual(enrich_rows([parent, child])[1]['rerun_family']['changes'], [
            {'group': 'clinical_choices', 'key': 'other', 'before': 'exclude', 'after': None}])

    def test_missing_cross_dataset_and_foreign_source_parents_do_not_invent_families(self):
        rows = [row('parent', dataset='other'), row('cross', parent='parent'),
                row('missing', parent='absent'), row('archive', source='archive'),
                row('from-archive', parent='archive'), row('recorded', source='recorded'),
                row('unclassified', dataset=None)]
        result = enrich_rows(rows)
        for entry in result[1:]:
            self.assertNotIn('rerun_family', entry)
        self.assertEqual(result[0]['rerun_family']['root_run'], 'parent')

    def test_cycles_duplicate_ids_and_descendants_are_unresolved(self):
        rows = [row('a', parent='b'), row('b', parent='a'), row('child', parent='a'),
                row('duplicate'), row('duplicate'), row('ambiguous-child', parent='duplicate')]
        self.assertTrue(all('rerun_family' not in entry for entry in enrich_rows(rows)))

    def test_ancestor_order_survives_clock_rollback_and_unknown_or_tied_siblings_have_no_latest(self):
        rows = [row('root'), row('child', parent='root', created='2026-11-18T10:00:03Z'),
                row('grandchild', parent='child', created='2026-11-18T10:00:01Z')]
        result = enrich_rows(rows)
        self.assertEqual([r['rerun_family']['number'] for r in result], [0, 1, 2])
        self.assertTrue(result[-1]['rerun_family']['latest'])
        for date in (None, '2026-11-18T10:00:00Z'):
            result = enrich_rows([row('root'), row('a', parent='root', created=date), row('b', parent='root')])
            self.assertFalse(any(r['rerun_family']['latest'] for r in result))

    def test_before_submission_can_use_reviewed_parameters_and_missing_evidence_is_explicit(self):
        child = row('fork', parent='original', jobs={})
        result = enrich_rows([row('original'), child])[1]
        self.assertFalse(result['rerun_family']['changes_available'])
        child['rerun']['parameters'] = {'settings': {}, 'options': {'npc': 4},
                                      'resources': {'cpus': 4, 'hours': 2},
                                      'clinical': {'choices': {'other': 'exclude'}}}
        result = enrich_rows([row('original'), child])[1]
        self.assertEqual(result['rerun_family']['changes'], [
            {'group': 'options', 'key': 'npc', 'before': 3, 'after': 4}])


if __name__ == '__main__':
    unittest.main()
