import ast, pathlib, subprocess, tempfile, signal, sys, time, resource, unittest, os, json, re, hashlib
source=pathlib.Path(__file__).with_name('guest.py').read_text();tree=ast.parse(source)
functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('bounded_wait','wait_evidence')]
class Contract(unittest.TestCase):
 def test_real_children(self):
  with tempfile.TemporaryDirectory(prefix='signet-wait-') as folder:
   root=pathlib.Path(folder);(root/'process.log').write_bytes(b'x'*20000+b'\nSIGNET_PHASE real-test\n')
   events=[];ns=dict(root=root,time=time,resource=resource,signal=signal,json=json,re=re,hashlib=hashlib,emit=events.append,interrupted=lambda:None,check_total=lambda:0)
   exec(compile(ast.Module(body=functions,type_ignores=[]),'actual-guest-wait','exec'),ns)
   for code,expected in [('pass',0),('raise SystemExit(7)',7),('import os,signal;os.kill(os.getpid(),signal.SIGTERM)',-signal.SIGTERM)]:
    p=subprocess.Popen([sys.executable,'-c',code]);
    if expected: self.assertRaisesRegex(RuntimeError,'OFFICIAL_R_FAILED',ns['bounded_wait'],p,3)
    else: ns['bounded_wait'](p,3)
    e=events[-1];self.assertEqual(e['returncode'],expected);self.assertEqual(e['signalName'],'SIGTERM' if expected<0 else None);self.assertLessEqual(len(e['tail'].encode()),4096);self.assertEqual(e['lastOfficialPhase'],'SIGNET_PHASE real-test');self.assertTrue(e['capturedBeforeCleanup'])
   for reason,seconds in [('CANCELLED',3),('OFFICIAL_WORK_TIMEOUT',0)]:
    p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(5)']);ns['interrupted']=(lambda:(_ for _ in ()).throw(RuntimeError('CANCELLED'))) if reason=='CANCELLED' else lambda:None
    try:
     self.assertRaisesRegex(RuntimeError,reason,ns['bounded_wait'],p,seconds);self.assertIsNone(events[-1]['returncode']);self.assertEqual(events[-1]['waitReason'],reason);self.assertIsNone(events[-1]['signal'])
    finally:p.terminate();p.wait()
   ns['interrupted']=lambda:None;ns['emit']=lambda _:(_ for _ in ()).throw(OSError('evidence full'));p=subprocess.Popen([sys.executable,'-c','raise SystemExit(9)']);self.assertRaisesRegex(RuntimeError,'OFFICIAL_R_FAILED',ns['bounded_wait'],p,3)
if __name__=='__main__':unittest.main()
