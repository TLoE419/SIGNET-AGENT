"""One owned local-VM session, fixed files, framed control, bounded work and cleanup."""
import os,sys,json,base64,hashlib,tempfile,pathlib,subprocess,signal,time,select,shutil,stat
OUT=sys.stdout
children=[];root=None;child=None;server=None;session_hash=None;manifest_hash=None;held=None;session_identity=None;image_fd=None
IMAGE='/work/evidence/signet-0.0.6.sif';OFFICIAL='/work/official-signet'
PIN={'dev':41,'ino':20,'size':6383458834,'mtime_ns':1791314959944771412,'ctime_ns':1791314959944771412}
IMAGE_HASH='de28f224f3da41b17ff08a03d0f04b1d5c033b2afbad18ed448b646b2feda277'
def digest(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def emit(v):OUT.write(json.dumps(v,separators=(',',':'))+'\n');OUT.flush()
def line():
 b=sys.stdin.buffer.readline(24*1024**2+1)
 if not b:return None
 if len(b)>24*1024**2:raise RuntimeError('FRAME_LIMIT')
 return json.loads(b)
def stop(p):
 if p and p.poll() is None:
  os.killpg(p.pid,signal.SIGTERM)
  try:p.wait(timeout=.5)
  except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait(timeout=.5)
def check_image():
 s=os.fstat(image_fd)
 if {k:getattr(s,'st_'+k) for k in PIN}!=PIN or not stat.S_ISREG(os.lstat(IMAGE).st_mode) or {k:getattr(os.lstat(IMAGE),'st_'+k) for k in PIN}!=PIN:raise RuntimeError('IMAGE_BINDING_CHANGED')
def command(mode,*args):
 check_image()
 return ['/usr/bin/singularity','exec','--containall','--no-home','--bind',str(root)+':'+str(root),'/proc/'+str(os.getpid())+'/fd/'+str(image_fd),'/usr/bin/python3','-I','-B',str(root/'exec.py'),mode,*args]
def launch(mode,*args):
 global child
 log=open(root/'process.log','ab',buffering=0)
 child=subprocess.Popen(command(mode,*args),stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={'PATH':'/usr/bin:/bin','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1'})
 children.append(child);log.close();return child
buffered=b''
def interrupted():
 global buffered
 if select.select([sys.stdin.buffer],[],[],0)[0]:
  b=os.read(sys.stdin.fileno(),4096)
  if not b:raise RuntimeError('CANCELLED')
  buffered+=b
  if b'\n' in buffered:
   raw,buffered=buffered.split(b'\n',1);m=json.loads(raw)
   if m.get('op')=='close':raise RuntimeError('CANCELLED')
   raise RuntimeError('CONTROL_BUSY')
def bounded_wait(p,seconds):
 end=time.monotonic()+seconds
 while p.poll() is None:
  interrupted()
  if time.monotonic()>=end:raise RuntimeError('OFFICIAL_WORK_TIMEOUT')
  size=sum(f.stat().st_size for f in root.rglob('*') if f.is_file())
  if size>256*1024**2:raise RuntimeError('DISK_LIMIT')
  time.sleep(.05)
 if p.returncode:raise RuntimeError('OFFICIAL_R_FAILED')
def verify():
 check_image()
 if any(digest(root/'input'/n)!=h for n,h in hashes.items()):raise RuntimeError('INPUT_CHANGED')
 if any(digest(root/n)!=h for n,h in official_files.items()):raise RuntimeError('OFFICIAL_SOURCE_CHANGED')
 if held is None or digest(root/'manifest.json')!=manifest_hash:raise RuntimeError('SESSION_CHANGED')
 a=os.fstat(held);b=os.stat(root/'official-session.RData')
 if (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=session_identity or session_identity!=(b.st_dev,b.st_ino,b.st_size,b.st_mtime_ns,b.st_ctime_ns):raise RuntimeError('SESSION_CHANGED')
try:
 image_fd=os.open(IMAGE,os.O_RDONLY|os.O_NOFOLLOW);check_image()
 while True:
  if not select.select([sys.stdin.buffer],[],[],.1)[0]:
   if server and server.poll() is not None:emit({'event':'service-exited'});server=None
   continue
  q=line()
  if q is None:break
  seq=q.get('seq');op=q.get('op')
  try:
   if op=='prepare':
    if root is not None:raise RuntimeError('NO_REPLAY')
    if not isinstance(q['freq'],(int,float)) or not 0<=q['freq']<=1 or type(q['ntop']) is not int or not 1<=q['ntop']<=100:raise RuntimeError('PARAMETERS_INVALID')
    root=pathlib.Path(tempfile.mkdtemp(prefix='signet-import-'));os.chmod(root,0o755)
    (root/'input').mkdir();(root/'res/resv').mkdir(parents=True)
    # Copy only fixed official scripts; never a foreign executable/session from an import.
    shutil.copytree(OFFICIAL+'/script/netvis',root/'script/netvis',symlinks=False)
    hashes={}
    for n in ('frequency','coefficient','positions'):
     b=base64.b64decode(q['network'][n],validate=True)
     if len(b)>4*1024**2 or hashlib.sha256(b).hexdigest()!=q['networkHashes'][n]:raise RuntimeError('INPUT_HASH_MISMATCH')
     (root/'input'/n).write_bytes(b);hashes[n]=hashlib.sha256(b).hexdigest()
    for n in ('exec.py','prepare.R','load.R'):
     b=base64.b64decode(q['tools'][n],validate=True)
     if len(b)>65536:raise RuntimeError('TOOL_LIMIT')
     (root/n).write_bytes(b)
    official_files={str(f.relative_to(root)):digest(f) for f in sorted((root/'script').rglob('*')) if f.is_file()}
    if official_files!=q['officialFiles']:raise RuntimeError('OFFICIAL_SOURCE_CHANGED')
    official_hash=hashlib.sha256(json.dumps(official_files,sort_keys=True).encode()).hexdigest()
    for f in root.rglob('*'):os.chown(f,65534,65534)
    os.chown(root,65534,65534)
    launch('prepare',str(root/'prepare.R'),str(root),str(q['freq']),str(q['ntop']));bounded_wait(child,300)
    p=root/'official-session.RData';s=p.lstat()
    if not s.st_size or s.st_size>128*1024**2:raise RuntimeError('SESSION_SIZE')
    held=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);session_hash=digest(p)
    manifest={'networkHashes':hashes,'parameters':{'freq':q['freq'],'ntop':q['ntop']},'sessionHash':session_hash,'officialHash':official_hash,'containerHash':IMAGE_HASH,'generated':True,'scientificStatus':'unknown'}
    (root/'manifest.json').write_text(json.dumps(manifest,sort_keys=True))
    manifest_hash=digest(root/'manifest.json');os.chmod(p,0o444)
    # Pin the final post-chmod identity and load the same file, never just its extension.
    os.close(held);held=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);st=os.fstat(held);session_identity=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
    launch('prepare',str(root/'load.R'),str(root),'check');bounded_wait(child,30)
    if 'SIGNET_SESSION_LOADED' not in (root/'process.log').read_text(errors='replace'):raise RuntimeError('LOAD_UNVERIFIED')
    verify();emit({'seq':seq,'value':{**manifest,'manifestHash':manifest_hash,'loadState':'loaded','guestRoot':str(root)}})
   elif op=='verify':verify();emit({'seq':seq,'value':{'sessionHash':session_hash,'manifestHash':manifest_hash,'loadState':'loaded','serviceAlive':server is not None and server.poll() is None}})
   elif op=='serve':
    verify()
    if server and server.poll() is None:raise RuntimeError('SERVICE_BUSY')
    port=q['port'];token=q['token']
    if type(port) is not int or not 1024<=port<=65535 or not isinstance(token,str) or len(token)!=36:raise RuntimeError('SERVICE_IDENTITY')
    offset=(root/'process.log').stat().st_size
    server=launch('serve',str(root/'load.R'),str(root),'serve',str(port),token);end=time.monotonic()+12
    while time.monotonic()<end:
     interrupted()
     if server.poll() is not None:raise RuntimeError('SERVICE_EXITED')
     if ('Listening on http://127.0.0.1:'+str(port)) in (root/'process.log').read_bytes()[offset:].decode(errors='replace'):break
     time.sleep(.1)
    else:raise RuntimeError('SERVICE_NOT_LISTENING')
    emit({'seq':seq,'value':{'port':port,'token':token,'pid':server.pid,'birth':open('/proc/'+str(server.pid)+'/stat').read().split()[21]}})
   elif op=='stop':stop(server);server=None;emit({'seq':seq,'value':{'stopped':True}})
   elif op=='close':break
   else:raise RuntimeError('UNKNOWN_OPERATION')
  except Exception as e:
   stop(child);emit({'seq':seq,'error':str(e),'tail':(root/'process.log').read_text(errors='replace')[-3000:] if root and (root/'process.log').exists() else ''})
   if str(e)=='CANCELLED':break
finally:
 stop(server);stop(child)
 if held is not None:os.close(held)
 if image_fd is not None:os.close(image_fd)
 if root:shutil.rmtree(root)
 emit({'event':'closed','resourcesClosed':all(p.poll() is not None for p in children),'children':[{'pid':p.pid,'exit':p.poll()} for p in children],'rootRemoved':str(root) if root else None})
