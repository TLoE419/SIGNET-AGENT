"""Exercise the production resource protocol and cleanup without R, a VM or a service."""
import unittest,tempfile,pathlib,subprocess,json,os,base64
SOURCE=pathlib.Path(__file__).with_name('guest.py').read_text()
class Protocol(unittest.TestCase):
 def run_case(self,messages):
  with tempfile.TemporaryDirectory(prefix='resource-protocol-') as d:
   image=pathlib.Path(d)/'image';image.write_bytes(b'only protocol fixture, never executed');s=image.stat()
   pin={k:getattr(s,'st_'+k) for k in ('dev','ino','size','mtime_ns','ctime_ns')}
   code=SOURCE.replace("IMAGE='/work/evidence/signet-0.0.6.sif'",'IMAGE='+repr(str(image)))
   code=code.replace('root=create_root();',"root=pathlib.Path(tempfile.mkdtemp(prefix='signet-import-'));")
   code='\n'.join('PIN='+repr(pin) if line.startswith('PIN=') else line for line in code.splitlines())
   p=subprocess.run(['python3','-I','-B','-c',code],input=''.join(json.dumps(dict(seq=i+1,**m))+'\n' for i,m in enumerate(messages)),text=True,capture_output=True,timeout=5)
   self.assertEqual(p.returncode,0,p.stderr);rows=[json.loads(s) for s in p.stdout.splitlines() if json.loads(s).get('event') not in ('owner','r-wait')]
   self.assertTrue(rows[-1]['resourcesClosed']);self.assertFalse(pathlib.Path(rows[-1]['rootRemoved']).exists());return rows
 def test_exact_hash_and_no_replay(self):
  b=(pathlib.Path(__file__).with_name('public-resource-pins.json'));pins=json.loads(b.read_text());ids=('\n'.join(pins['binding']['identifiers'])+'\n').encode()
  rows=self.run_case([{'op':'resources-begin'},{'op':'resource-begin','name':'identifiers.txt'},{'op':'resource-chunk','offset':0,'bytes':base64.b64encode(ids).decode()},{'op':'resource-end'},{'op':'resource-begin','name':'identifiers.txt'},{'op':'close'}])
  self.assertTrue(rows[3]['value']['verified']);self.assertEqual(rows[4]['error'],'RESOURCE_PURPOSE')
 def test_wrong_hash_cannot_admit_preparation(self):
  rows=self.run_case([{'op':'resources-begin'},{'op':'resource-begin','name':'version.tsv'},{'op':'resource-chunk','offset':0,'bytes':base64.b64encode(b'X'*40).decode()},{'op':'resource-end'},{'op':'prepare','freq':1,'ntop':1},{'op':'close'}])
  self.assertEqual(rows[3]['error'],'RESOURCE_HASH_MISMATCH');self.assertEqual(rows[4]['error'],'RESOURCE_INCOMPLETE')
 def test_path_and_out_of_order_refused(self):
  rows=self.run_case([{'op':'resources-begin'},{'op':'resource-begin','name':'../escape'},{'op':'resource-begin','name':'version.tsv'},{'op':'resource-chunk','offset':1,'bytes':'WA=='},{'op':'close'}])
  self.assertEqual(rows[1]['error'],'RESOURCE_PURPOSE');self.assertEqual(rows[3]['error'],'RESOURCE_SEQUENCE')
if __name__=='__main__':unittest.main()
