from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import tools
import signet_tools as st


class ListFilesTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name).resolve()
        self.project_patch=patch.object(tools,'PROJECT',self.root)
        self.project_patch.start()
        self.dispatch_patch=patch.object(st,'PROJECT',self.root)
        self.dispatch_patch.start()

    def tearDown(self):
        self.dispatch_patch.stop()
        self.project_patch.stop()
        self.temp.cleanup()

    def create(self,path):
        target=self.root/path
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_text('fake fixture content')
        return target

    def test_nested_files_are_sorted_relative_paths(self):
        for path in ['z.txt','data/expression.txt','data/中文資料/genotype.vcf','runs/demo/work/res/result.txt','a.py']:
            self.create(path)
        (self.root/'empty-folder').mkdir()
        result=tools.list_files(str(self.root))
        self.assertEqual(result,['a.py','data/expression.txt','data/中文資料/genotype.vcf','runs/demo/work/res/result.txt','z.txt'])
        self.assertTrue(all(not Path(path).is_absolute() for path in result))

    def test_hidden_items_environments_dependencies_and_caches_are_pruned(self):
        for path in ['.env','.env.local','.git/config','.aws/credentials','.venv/secret.txt','venv/lib/package.py','node_modules/pkg/index.js','__pycache__/tools.pyc','data/.private.txt','data/.private/secret.txt','data/normal.csv']:
            self.create(path)
        self.assertEqual(tools.list_files(str(self.root)),['data/normal.csv'])

    def test_symbolic_files_directories_and_cycles_are_skipped(self):
        self.create('data/normal.csv')
        with tempfile.TemporaryDirectory() as outside:
            external=Path(outside).resolve()
            (external/'outside.txt').write_text('external fixture')
            (self.root/'linked-file').symlink_to(external/'outside.txt')
            (self.root/'linked-dir').symlink_to(external,target_is_directory=True)
            (self.root/'loop').symlink_to(self.root,target_is_directory=True)
            (self.root/'internal-link').symlink_to(self.root/'data',target_is_directory=True)
            self.assertEqual(tools.list_files(str(self.root)),['data/normal.csv'])

    def test_other_directories_rejected_by_function_and_dispatch(self):
        (self.root/'data').mkdir()
        for folder in [self.root/'data',self.root.parent]:
            with self.assertRaises(ValueError):
                tools.list_files(str(folder))
            self.assertEqual(st.dispatch_tool('list_files',{'folder':str(folder)})['status'],'invalid')

    def test_root_alias_symlink_is_rejected(self):
        with tempfile.TemporaryDirectory() as alias_parent:
            alias=Path(alias_parent)/'alias'
            alias.symlink_to(self.root,target_is_directory=True)
            with self.assertRaises(ValueError):
                tools.list_files(str(alias))

    def test_dispatch_retains_files_response_shape_and_never_reads_contents(self):
        self.create('data/expression.txt')
        self.create('.env')
        with patch.object(Path,'read_text',side_effect=AssertionError('File content must not be read')):
            result=st.dispatch_tool('list_files',{'folder':str(self.root)})
        self.assertEqual(result,{'files':['data/expression.txt']})

    def test_empty_project_returns_empty_list(self):
        self.assertEqual(tools.list_files(str(self.root)),[])

    def test_walk_error_is_not_silently_reported_as_a_complete_list(self):
        with patch.object(tools.os,'walk',side_effect=PermissionError('Cannot inspect fixture directory')):
            result=st.dispatch_tool('list_files',{'folder':str(self.root)})
        self.assertEqual(result['status'],'invalid')
        self.assertIn('Cannot inspect',result['error'])


if __name__=='__main__':
    unittest.main()
