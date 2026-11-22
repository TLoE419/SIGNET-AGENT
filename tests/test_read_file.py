import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

import agent.core.conversation as main
import agent.tools.general as tools
import agent.tools.signet as st


class ReadFileTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.patch = patch.object(tools, 'PROJECT', self.root)
        self.patch.start()
        # An aggregate result: significant gene-SNP pairs, not people.
        self.path = self.root / 'runs/demo/work/res/resc/signet_all.sig.pValue_0.05'
        self.path.parent.mkdir(parents=True)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_real_dispatch_paginates_without_losing_lines_or_claiming_records(self):
        self.path.write_bytes('基因\t變異\r\n1\t2\r\n\r\n3\t4'.encode())
        first = st.dispatch_tool('read_file', {'path':'runs/demo/work/res/resc/signet_all.sig.pValue_0.05', 'max_lines':2})
        self.assertEqual(first['status'], 'ok')
        self.assertEqual(first['total_lines'], 4)
        self.assertEqual(first['returned_lines'], 2)
        self.assertTrue(first['truncated'])
        second = tools.read_file(str(self.path), start_line=first['next_start_line'])
        self.assertEqual(first['content'] + second['content'], self.path.read_bytes().decode())
        self.assertIsNone(second['next_start_line'])
        self.assertFalse(second['executed'])
        self.assertIn('not validated records', first['evidence_scope'])
        self.assertIn(tools.read_file, main.config.tools)

    def test_person_level_files_and_raw_data_never_reach_the_model(self):
        refused = ['runs/demo/work/res/resg/signet_Genotype.sampleID', 'runs/demo/work/res/resg/signet_Geno',
                   'runs/demo/work/res/rest/signet_gexpID', 'runs/demo/work/res/rest/signet_gexp',
                   'runs/demo/work/res/resa/signet_matched.gexp', 'runs/demo/work/res/resc/signet_all.eQTL.data',
                   'runs/demo/work/tmp/tmpg/clean_Genotype.ped', 'runs/demo/work/data/input.txt',
                   'runs/demo/logs/genotype_tcga.stdout', 'data/clinical.tsv', 'data/study.ped']
        for relative in refused:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('TCGA-95-7947-01C\n')
            result = st.dispatch_tool('read_file', {'path': relative})
            self.assertEqual(result['status'], 'invalid', relative)
            self.assertNotIn('TCGA-95', str(result))
        self.assertIn('summarize_table', st.dispatch_tool('read_file', {'path': 'data/clinical.tsv'})['error'])
        allowed = ['runs/demo/work/res/rest/signet_gene_pos', 'runs/demo/work/res/rest/signet_gene_name',
                   'runs/demo/work/res/resn/signet_Afreq', 'runs/demo/work/res/resn/signet_net.genepos',
                   'runs/demo/work/res/resv/signet-edges.csv', 'runs/demo/work/res/resv/signet_edgelist_0.5.txt']
        for relative in allowed:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('A B 1\n')
            self.assertEqual(st.dispatch_tool('read_file', {'path': relative})['status'], 'ok', relative)

    def test_page_character_limit_preserves_whole_lines(self):
        self.path.write_text('甲'*7000+'\n'+'乙'*7000+'\n'+'丙'*7000+'\n')
        first = tools.read_file(str(self.path))
        self.assertEqual(first['returned_lines'], 2)
        self.assertEqual(first['next_start_line'], 3)
        self.assertLessEqual(len(first['content']), tools.MAX_READ_CHARS)
        self.assertEqual(tools.read_file(str(self.path),3)['returned_lines'], 1)
        self.path.write_text('甲'*16001)
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path)})['status'],'invalid')

    def test_rejects_outside_hidden_links_credentials_binary_and_invalid_arguments(self):
        paths = ['.env', 'main.py', 'data/../.env', 'data/.private/secret',
                 'data/raw-clinical.tsv', 'runs/demo/steps/genotype.json',
                 'runs/demo/work/res/resg/signet_Genotype.sampleID',
                 'data/credentials', 'data/credentials.json', 'data/private.pem', 'data/node_modules/key.txt']
        for relative in paths:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('secret fixture')
            self.assertEqual(st.dispatch_tool('read_file',{'path':str(target)})['status'],'invalid',relative)
        self.assertEqual(st.dispatch_tool('read_file',{'path':'../outside'})['status'],'invalid')
        self.path.write_bytes(b'abc\x00def')
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path)})['status'],'invalid')
        self.path.write_bytes(b'\xff')
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path)})['status'],'invalid')
        link = self.root/'runs/demo/work/res/resc/signet_all.sig.pValue_0.01'
        link.symlink_to(self.path)
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(link)})['status'],'invalid')
        for args in [{'start_line':0},{'max_lines':501},{'start_line':True},{'max_lines':'5'},{'extra':1}]:
            self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path),**args})['status'],'invalid')

    def test_raw_research_data_is_refused_before_contents_are_opened(self):
        path = self.root / 'data/private-clinical.tsv'
        path.parent.mkdir(parents=True)
        path.write_text('patient_id\trace\nPRIVATE-PERSON\tasian\n')
        with patch.object(Path, 'open', side_effect=AssertionError('Raw data must not be opened')):
            result = st.dispatch_tool('read_file', {'path': str(path)})
        self.assertEqual(result['status'], 'invalid')
        self.assertFalse(result['executed'])
        self.assertNotIn('PRIVATE-PERSON', str(result))

    def test_empty_and_oversized_files(self):
        self.path.touch()
        self.assertEqual(tools.read_file(str(self.path))['total_lines'], 0)
        with self.path.open('wb') as stream:
            stream.truncate(tools.MAX_READ_BYTES+1)
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path)})['status'],'invalid')


class SummarizeTableTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.patch = patch.object(tools, 'PROJECT', self.root)
        self.patch.start()
        (self.root / 'data').mkdir()

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_counts_categories_and_hides_identifiers(self):
        rows = ['submitter_id\trace\tgender\tage']
        rows += [f'TCGA-44-{1000 + i}\t{"white" if i % 3 else ""}\t{"female" if i % 2 else "male"}\t{40 + i}' for i in range(30)]
        (self.root / 'data/clinical.tsv').write_text('\r\n'.join(rows) + '\r\n')
        result = st.dispatch_tool('summarize_table', {'path': 'data/clinical.tsv'})
        self.assertEqual((result['status'], result['rows'], result['delimiter']), ('ok', 30, 'tab'))
        self.assertEqual(result['columns'], ['submitter_id', 'race', 'gender', 'age'])
        self.assertTrue(result['windows_line_endings'])
        self.assertEqual(result['per_column']['race'], {'blank': 10, 'distinct': 1, 'values': {'white': 20}})
        self.assertEqual(result['per_column']['gender']['values'], {'female': 15, 'male': 15})
        self.assertEqual(result['per_column']['submitter_id'], {'blank': 0, 'distinct': 'more than 20'})
        self.assertNotIn('values', result['per_column']['age'], 'many distinct values are never listed')
        self.assertNotIn('TCGA-44', str(result))
        self.assertIn(tools.summarize_table, main.config.tools)

    def test_a_small_identifier_column_is_counted_but_never_listed(self):
        (self.root / 'data/few.csv').write_text('sample_id,group\nTCGA-44-0001,a\nTCGA-44-0002,b\n')
        result = tools.summarize_table('data/few.csv')
        self.assertEqual(result['per_column']['sample_id'], {'blank': 0, 'distinct': 2})
        self.assertNotIn('group', result['per_column'])
        self.assertNotIn('TCGA-44', str(result))
        for bad in ('../outside.tsv', '.env', 'data/missing.tsv'):
            self.assertEqual(st.dispatch_tool('summarize_table', {'path': bad})['status'], 'invalid', bad)


if __name__ == '__main__':
    unittest.main()
