"""Linux native 1:32 budget tests of the production functions; no R/session/service."""
import os,sys,ast,pathlib,json,base64,ctypes,tempfile,stat,fcntl,hashlib,errno,select,types

def run(source):
 tree=ast.parse(source);functions={n.name:ast.get_source_segment(source,n) for n in tree.body if isinstance(n,ast.FunctionDef)}
 create=functions['create_root'].replace('268435456','8388608').replace('256*1024**2','8*1024**2').replace('255*1024**2','7*1024**2')
 sealing=functions['seal_session'];assert sealing.count('total_budget=256*1024**2')==1
 sealing=sealing.replace('total_budget=256*1024**2','total_budget=8*1024**2')
 budget=8*1024**2;rows=[]
 for case in ('normal-unaligned','reject-peak','cancel-partial','source-growth'):
  state={'fd':None,'created':0,'copied':0,'peak':0,'samples':0,'changed':False};proof=None;root=None;original=None;sealed=None;mounted=False;quota_proof=None
  pipe_read,pipe_write=os.pipe();reader=os.fdopen(pipe_read,'rb',buffering=0)
  class ObservedOS:
   def __getattr__(self,k):return getattr(os,k)
   def memfd_create(self,*a):
    state['created']+=1
    # Real kernel cap must already exclude the entire page-rounded second copy.
    cap=os.statvfs(root);assert cap.f_blocks*cap.f_frsize+quota_proof['sealedSessionReservedBytes']<=budget
    state['fd']=os.memfd_create(*a);return state['fd']
   def write(self,fd,data):
    n=os.write(fd,data);state['copied']+=n;sample();return n
  def sample():
   cap=os.statvfs(root);root_used=(cap.f_blocks-cap.f_bfree)*cap.f_frsize
   size=os.fstat(state['fd']).st_size if state['fd'] is not None else 0
   rounded=((size+4095)//4096)*4096;peak=root_used+rounded
   state['peak']=max(state['peak'],peak);state['samples']+=1;assert peak<=budget
  def interrupted():
   if state['fd'] is not None and os.fstat(state['fd']).st_size:
    if case=='cancel-partial' and state.get('pipeWriterClosed') is not True:
     os.close(pipe_write);state['pipeWriterClosed']=True
    if case=='source-growth' and not state['changed']:
     state['changed']=True
     with open(root/'source.bin','r+b') as f:f.seek(0,2);f.write(b'G')
   ns['control_interrupted']()
  ns={'os':ObservedOS(),'ctypes':ctypes,'pathlib':pathlib,'tempfile':tempfile,'stat':stat,'fcntl':fcntl,'hashlib':hashlib,'mounted':False,'quota_proof':None,'interrupted':interrupted,'sys':types.SimpleNamespace(stdin=types.SimpleNamespace(buffer=reader,fileno=reader.fileno)),'select':select,'json':json,'buffered':b''}
  exec(compile(functions['interrupted'].replace('def interrupted():','def control_interrupted():')+'\n'+create+'\n'+sealing,'production-functions-scaled-1-to-32','exec'),ns)
  try:
   root=ns['create_root']();ns['root']=root;quota_proof=ns['quota_proof']
   size=4*1024**2 if case=='reject-peak' else 2*1024**2+1
   other=100*1024**2//32 if case=='reject-peak' else 1024**2
   for name,length in [('source.bin',size),('other.bin',other)]:
    fd=os.open(root/name,os.O_CREAT|os.O_RDWR,0o600)
    try:os.posix_fallocate(fd,0,length)
    finally:os.close(fd)
   before=os.statvfs(root);state['initialRootAllocated']=(before.f_blocks-before.f_bfree)*before.f_frsize;sample()
   original=os.open(root/'source.bin',os.O_RDONLY|os.O_NOFOLLOW)
   try:
    sealed,digest=ns['seal_session'](original);result='sealed'
    assert case=='normal-unaligned';assert os.fstat(sealed).st_size==size and fcntl.fcntl(sealed,fcntl.F_GET_SEALS)==15
    assert digest==hashlib.sha256(b'\0'*size).hexdigest()
    try:os.pwrite(sealed,b'x',0);raise AssertionError('seal writable')
    except OSError as e:assert e.errno==errno.EPERM
    # Real remaining kernel quota cannot allocate one byte beyond its free pages.
    v=os.statvfs(root);f=os.open(root/'fill.bin',os.O_CREAT|os.O_RDWR,0o600)
    try:
     free=v.f_bfree*v.f_frsize;os.posix_fallocate(f,0,free);sample()
     try:os.pwrite(f,b'x',free);raise AssertionError('quota admitted excess')
     except OSError as e:assert e.errno==errno.ENOSPC
    finally:os.close(f)
   except RuntimeError as e:result=str(e)
   expected={'normal-unaligned':'sealed','reject-peak':'QUOTA_SEAL_RESERVATION_UNAVAILABLE','cancel-partial':'CANCELLED','source-growth':'SESSION_CHANGED'}[case]
   assert result==expected,(case,result)
   if case=='reject-peak':assert state['created']==0
   elif case!='normal-unaligned':
    assert 0<state['copied']<=size
    try:os.fstat(state['fd']);raise AssertionError('failed copy FD leaked')
    except OSError as e:assert e.errno==errno.EBADF
   rows.append({'case':case,'result':result,'budget':budget,'sourceBytes':size,'otherBytes':other,'state':state.copy(),'quota':dict(quota_proof),'kernelENOSPC':case=='normal-unaligned'})
  finally:
   reader.close()
   if not state.get('pipeWriterClosed'):os.close(pipe_write)
   if original is not None:os.close(original)
   if sealed is not None:os.close(sealed)
   if root:
    if ctypes.CDLL(None,use_errno=True).umount2(os.fsencode(root),0):raise RuntimeError('TEST_UNMOUNT_FAILED')
    root.rmdir();assert not root.exists()
    if rows and rows[-1]['case']==case:rows[-1]['cleanup']={'root':str(root),'rootRemoved':True,'sourceAndSealedFDClosed':True,'reservationReleasedByUnmount':True}
 return {'scope':'production functions with only 256MiB -> 8MiB quota scaling; real Linux tmpfs/memfd/syscalls; ordinary byte fixtures, not RData','sourceSHA256':hashlib.sha256(source.encode()).hexdigest(),'scale':'1:32','cases':rows,'passed':len(rows)==4}
if __name__=='__main__':
 if sys.platform!='linux':raise SystemExit('Linux kernel required; not tested on this platform')
 source=base64.b64decode(json.loads(sys.stdin.readline())['source']).decode() if '--stdin' in sys.argv else pathlib.Path(__file__).with_name('guest.py').read_text()
 print(json.dumps(run(source),indent=2))
