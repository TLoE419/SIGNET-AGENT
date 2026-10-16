import ast,pathlib,subprocess,sys,os,select,signal,json,tempfile,unittest,io,contextlib
source=pathlib.Path(__file__).with_name('exec.py').read_text();f=[n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='run_r'];ns=globals().copy();exec(compile(ast.Module(body=f,type_ignores=[]),'actual-exec-wait','exec'),ns)
class Direct(unittest.TestCase):
 def test_real_status_and_bounded_pipe(self):
  for code,expected in [('pass',0),('raise SystemExit(137)',137),('import os,signal;os.kill(os.getpid(),signal.SIGTERM)',-15)]:
   out=io.StringIO()
   with contextlib.redirect_stdout(out):self.assertEqual(ns['run_r'](sys.executable,['-c',code]),expected)
   record=json.loads(out.getvalue().split('SIGNET_R_EXIT ')[1]);self.assertEqual(record['returncode'],expected);self.assertEqual(record['signalName'],'SIGTERM' if expected<0 else None)
  with tempfile.TemporaryDirectory() as root:
   out=io.StringIO()
   with contextlib.redirect_stdout(out):self.assertEqual(ns['run_r'](sys.executable,['-c',"import os;f=open(os.environ['SIGNET_R_PROFILE'],'wb');f.write(b'x'*2097152);f.close()"],root),0)
   self.assertEqual((pathlib.Path(root)/'r-profile.txt').stat().st_size,1048576);r=json.loads(out.getvalue().split('SIGNET_R_EXIT ')[1]);self.assertEqual(r['profileDroppedBytes'],1048576)
if __name__=='__main__':unittest.main()
