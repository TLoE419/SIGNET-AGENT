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
        self.path = self.root / 'runs/demo/work/res/pairs'
        self.path.parent.mkdir(parents=True)

    def tearDown(self):
        self.patch.stop()
        self.temp.cleanup()

    def test_real_dispatch_paginates_without_losing_lines_or_claiming_records(self):
        self.path.write_bytes('基因\t變異\r\n1\t2\r\n\r\n3\t4'.encode())
        first = st.dispatch_tool('read_file', {'path':'runs/demo/work/res/pairs', 'max_lines':2})
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
        link = self.root/'data/link'
        link.symlink_to(self.path)
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(link)})['status'],'invalid')
        for args in [{'start_line':0},{'max_lines':501},{'start_line':True},{'max_lines':'5'},{'extra':1}]:
            self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path),**args})['status'],'invalid')

    def test_empty_and_oversized_files(self):
        self.path.touch()
        self.assertEqual(tools.read_file(str(self.path))['total_lines'], 0)
        with self.path.open('wb') as stream:
            stream.truncate(tools.MAX_READ_BYTES+1)
        self.assertEqual(st.dispatch_tool('read_file',{'path':str(self.path)})['status'],'invalid')


if __name__ == '__main__':
    unittest.main()
