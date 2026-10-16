"""One owned local-VM session, fixed files, framed control, bounded work and cleanup."""
import ctypes,fcntl,os,sys,json,base64,hashlib,tempfile,pathlib,subprocess,signal,time,select,shutil,stat
OUT=sys.stdout
children=[];root=None;child=None;server=None;session_hash=None;manifest_hash=None;held=None;session_identity=None;image_fd=None;mounted=False;quota_proof=None
RESOURCE_PINS={'version.tsv': {'bytes': 40, 'sha256': '9f05a212be447560b980dacac4af78a2be5ae21c48099b3f3fad49b80e95322c', 'method': 'GET', 'url': 'https://string-db.org/api/tsv-no-header/version'}, 'versions.tsv': {'bytes': 202, 'sha256': 'b31fd4723e08ac7c08430633abc51ca3a21cd86f8ab4417838e07846190fa889', 'method': 'GET', 'url': 'https://string-db.org/api/tsv-no-header/available_api_versions'}, '9606.protein.info.v12.0.txt.gz': {'bytes': 1970090, 'sha256': '144de4b0d98c6a7dfde6ddc2591cf88657f27b989eadff4f501450c3ed1f0f1c', 'method': 'GET', 'url': 'https://stringdb-static.org/download/protein.info.v12.0/9606.protein.info.v12.0.txt.gz'}, '9606.protein.aliases.v12.0.txt.gz': {'bytes': 19777800, 'sha256': 'b65f730b993ed0c1bd72edf4565d3d425db42861101b29699704810e8f125680', 'method': 'GET', 'url': 'https://stringdb-static.org/download/protein.aliases.v12.0/9606.protein.aliases.v12.0.txt.gz'}, '9606.protein.links.v12.0.txt.gz': {'bytes': 83164437, 'sha256': '3e22f32572211aa341d5b4bd08d30c32e693e294603202120936872f87719d4f', 'method': 'GET', 'url': 'https://stringdb-static.org/download/protein.links.v12.0/9606.protein.links.v12.0.txt.gz'}, 'enrichment_KEGG.tsv': {'bytes': 3025, 'sha256': 'b06684502f5de93510549992f409df81f9e28ecfa50d09eaf8df60e9abdeca7e', 'method': 'POST', 'url': 'https://version-12-0.string-db.org/api/tsv/enrichment'}, 'enrichment_Process.tsv': {'bytes': 3025, 'sha256': 'b06684502f5de93510549992f409df81f9e28ecfa50d09eaf8df60e9abdeca7e', 'method': 'POST', 'url': 'https://version-12-0.string-db.org/api/tsv/enrichment'}, 'identifiers.txt': {'bytes': 1659, 'sha256': '0f9d9864372e1c5ab9161de8e2f3550bd5558d83043e018ad11db4bdfabac53c', 'derivedFrom': 'enrichment.json publicBinding.identifiers'}}
resource_file=None;resource_name=None;resource_offset=0;resource_digest=None;resources_done=set();prepared=False;resource_identities={}
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
def create_root():
 global mounted,quota_proof
 # A private mount namespace: no shared VM mount/service is changed.
 lib=ctypes.CDLL(None,use_errno=True)
 if lib.unshare(0x00020000):raise RuntimeError('QUOTA_NAMESPACE_UNAVAILABLE')
 if lib.mount(None,b'/',None,0x4000|0x40000,None):raise RuntimeError('QUOTA_PRIVATE_UNAVAILABLE')
 p=pathlib.Path(tempfile.mkdtemp(prefix='signet-import-'))
 try:
  if lib.mount(b'tmpfs',os.fsencode(p),b'tmpfs',2|4|8,b'size=268435456,nr_inodes=4096,mode=0755'):raise RuntimeError('QUOTA_FILESYSTEM_UNAVAILABLE')
  mounted=True;s=os.statvfs(p)
  if s.f_blocks*s.f_frsize>256*1024**2 or s.f_blocks*s.f_frsize<255*1024**2:raise RuntimeError('QUOTA_BINDING_INVALID')
  quota_proof={'kind':'private-tmpfs','maxAllocatedBytes':s.f_blocks*s.f_frsize,'maxInodes':s.f_files,'lifetimeCumulativeWriteLimit':False}
  return p
 except Exception:
  if mounted:lib.umount2(os.fsencode(p),0);mounted=False
  p.rmdir();raise
def check_total():
 total=os.fstat(held).st_size if held is not None else 0;count=0
 for p in root.rglob('*'):
  s=p.lstat();count+=1
  if count>4096 or stat.S_ISLNK(s.st_mode):raise RuntimeError('DISK_LIMIT')
  if stat.S_ISREG(s.st_mode):total+=s.st_size
  if total>256*1024**2:raise RuntimeError('DISK_LIMIT')
 return total
def command(mode,*args):
 check_image()
 binds=str(root)+':'+str(root)+','+str(root/'tmp')+':/tmp,'+str(root/'tmp')+':/var/tmp'
 return ['/usr/bin/singularity','exec','--containall','--no-home','--bind',binds,'/proc/'+str(os.getpid())+'/fd/'+str(image_fd),'/usr/bin/python3','-I','-B',str(root/'exec.py'),mode,*args]
def launch(mode,*args):
 global child
 log=open(root/'process.log','ab',buffering=0)
 child=subprocess.Popen(command(mode,*args),stdin=held if held is not None else subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={'PATH':'/usr/bin:/bin','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','TMPDIR':str(root/'tmp')})
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
  check_total()
  time.sleep(.05)
 check_total()
 if p.returncode:raise RuntimeError('OFFICIAL_R_FAILED')
def verify():
 check_image();check_total()
 if held is not None and fcntl.fcntl(held,fcntl.F_GET_SEALS)!=15:raise RuntimeError('SESSION_NOT_IMMUTABLE')
 for n,identity in resource_identities.items():
  s=os.stat(root/'resources'/n,follow_symlinks=False)
  if not stat.S_ISREG(s.st_mode) or (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)!=identity:raise RuntimeError('RESOURCE_CHANGED')
 if any(digest(root/'input'/n)!=h for n,h in hashes.items()):raise RuntimeError('INPUT_CHANGED')
 if any(digest(root/n)!=h for n,h in official_files.items()):raise RuntimeError('OFFICIAL_SOURCE_CHANGED')
 if held is None or digest(root/'manifest.json')!=manifest_hash:raise RuntimeError('SESSION_CHANGED')
 a=os.fstat(held)
 if (a.st_dev,a.st_ino,a.st_size,a.st_mtime_ns,a.st_ctime_ns)!=session_identity:raise RuntimeError('SESSION_CHANGED')
try:
 image_fd=os.open(IMAGE,os.O_RDONLY|os.O_NOFOLLOW);check_image()
 while True:
  if not select.select([sys.stdin.buffer],[],[],.1)[0]:
   if root:check_total()
   if server and server.poll() is not None:emit({'event':'service-exited'});server=None
   continue
  q=line()
  if q is None:break
  seq=q.get('seq');op=q.get('op')
  try:
   if op=='resources-begin':
    if root is not None:raise RuntimeError('NO_REPLAY')
    root=create_root();(root/'resources').mkdir()
    emit({'seq':seq,'value':{'started':True}})
   elif op=='resource-begin':
    name=q['name']
    if root is None or prepared or resource_file or name not in RESOURCE_PINS or name in resources_done:raise RuntimeError('RESOURCE_PURPOSE')
    resource_name=name;resource_offset=0;resource_digest=hashlib.sha256();resource_file=open(root/'resources'/name,'xb')
    emit({'seq':seq,'value':{'started':True}})
   elif op=='resource-chunk':
    if not resource_file or q['offset']!=resource_offset:raise RuntimeError('RESOURCE_SEQUENCE')
    b=base64.b64decode(q['bytes'],validate=True)
    if not b or len(b)>1024**2 or resource_offset+len(b)>RESOURCE_PINS[resource_name]['bytes']:raise RuntimeError('RESOURCE_LIMIT')
    resource_file.write(b);resource_digest.update(b);resource_offset+=len(b)
    emit({'seq':seq,'value':{'offset':resource_offset}})
   elif op=='resource-end':
    if not resource_file:raise RuntimeError('RESOURCE_SEQUENCE')
    resource_file.close();resource_file=None;pin=RESOURCE_PINS[resource_name]
    if resource_offset!=pin['bytes'] or resource_digest.hexdigest()!=pin['sha256']:raise RuntimeError('RESOURCE_HASH_MISMATCH')
    os.chmod(root/'resources'/resource_name,0o444);resources_done.add(resource_name)
    emit({'seq':seq,'value':{'verified':True}})
   elif op=='prepare':
    if prepared:raise RuntimeError('NO_REPLAY')
    prepared=True
    if root is None or resources_done!=set(RESOURCE_PINS):raise RuntimeError('RESOURCE_INCOMPLETE')
    if q['freq']!=1 or q['ntop']!=1:raise RuntimeError('PUBLIC_RESOURCE_PARAMETERS_MISMATCH')
    if not isinstance(q['freq'],(int,float)) or not 0<=q['freq']<=1 or type(q['ntop']) is not int or not 1<=q['ntop']<=100:raise RuntimeError('PARAMETERS_INVALID')
    (root/'tmp').mkdir();os.chmod(root/'tmp',0o1777);(root/'input').mkdir();(root/'res/resv').mkdir(parents=True)
    # Copy only fixed official scripts; never a foreign executable/session from an import.
    shutil.copytree(OFFICIAL+'/script/netvis',root/'script/netvis',symlinks=False)
    hashes={}
    for n in ('frequency','coefficient','positions'):
     b=base64.b64decode(q['network'][n],validate=True)
     if len(b)>4*1024**2 or hashlib.sha256(b).hexdigest()!=q['networkHashes'][n]:raise RuntimeError('INPUT_HASH_MISMATCH')
     (root/'input'/n).write_bytes(b);hashes[n]=hashlib.sha256(b).hexdigest()
    for n in ('exec.py','prepare.R','load.R','resource-client.R'):
     b=base64.b64decode(q['tools'][n],validate=True)
     if len(b)>65536:raise RuntimeError('TOOL_LIMIT')
     (root/n).write_bytes(b)
    official_files={str(f.relative_to(root)):digest(f) for f in sorted((root/'script').rglob('*')) if f.is_file()}
    if official_files!=q['officialFiles']:raise RuntimeError('OFFICIAL_SOURCE_CHANGED')
    official_hash=hashlib.sha256(json.dumps(official_files,sort_keys=True).encode()).hexdigest()
    original_files=dict(official_files)
    # Exact, narrow offline/empty-result adaptations, only after original source pins match.
    replacements={
     'sub_summary.R':[
      ('  mapped_id <- mapped$STRING_id','  mapped_id <- mapped$STRING_id\n  nodes[[i]]$enrichment <- ""',1),
      ('[1:min(nrow_max_enrich, nrow(enrich)), ]','[seq_len(min(nrow_max_enrich, nrow(enrich))), , drop=FALSE]',1),
      ('if(!is.na(enrichment[[i]][1, 1])){','if(nrow(enrichment[[i]]) > 0 && !is.na(enrichment[[i]][1, 1])){',1)],
     'circular.R':[('species = Sys.getenv("assembly"),','cytoband = readRDS(system.file("extdata", "cytoband_list.rds", package="circlize"))[["hg38"]], species = NULL,',2)],
     'server.R':[('species = Sys.getenv("assembly"),','cytoband = readRDS(system.file("extdata", "cytoband_list.rds", package="circlize"))[["hg38"]], species = NULL,',2),
      ('if(is.null(enrichment[[input$net_num1]])){','if(is.null(enrichment[[input$net_num1]]) || NROW(enrichment[[input$net_num1]]) == 0){',1)]}
    for name,changes in replacements.items():
     p=root/'script/netvis'/name;text=p.read_text()
     for old,new,count in changes:
      if text.count(old)!=count:raise RuntimeError('OFFICIAL_ADAPTATION_CHANGED')
      text=text.replace(old,new)
     p.write_text(text);official_files['script/netvis/'+name]=digest(p)
    adaptation_hash=hashlib.sha256(json.dumps(official_files,sort_keys=True).encode()).hexdigest()

    for f in root.rglob('*'):os.chown(f,65534,65534)
    for n in RESOURCE_PINS:
     p=root/'resources'/n;os.chown(p,0,0);os.chmod(p,0o444);s=p.stat();resource_identities[n]=(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
    os.chown(root/'resources',0,0);os.chmod(root/'resources',0o555)
    os.chown(root,65534,65534)
    launch('prepare',str(root/'prepare.R'),str(root),str(q['freq']),str(q['ntop']));bounded_wait(child,300)
    p=root/'official-session.RData';s=p.lstat()
    if not s.st_size or s.st_size>128*1024**2:raise RuntimeError('SESSION_SIZE')
    # Copy the generated file through its held descriptor into a kernel-sealed immutable FD.
    original=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
    try:
     before=os.fstat(original);held=os.memfd_create('signet-session',os.MFD_ALLOW_SEALING);h=hashlib.sha256()
     while True:
      data=os.read(original,1024*1024)
      if not data:break
      h.update(data);view=memoryview(data)
      while view:view=view[os.write(held,view):]
     if os.fstat(original)!=before:raise RuntimeError('SESSION_CHANGED')
     fcntl.fcntl(held,fcntl.F_ADD_SEALS,15);session_hash=h.hexdigest()
     os.lseek(held,0,0);check=hashlib.sha256()
     for data in iter(lambda:os.read(held,1024*1024),b''):check.update(data)
     if check.hexdigest()!=session_hash:raise RuntimeError('SESSION_CHANGED')
    finally:os.close(original)
    # The original temporary output is replaced by a zero-byte bind target; actual load uses sealed FD bytes.
    p.unlink()
    remaining=((256*1024**2-os.fstat(held).st_size)//4096)*4096
    # After sealing, charge its bytes against the same total, enforced by a smaller live filesystem.
    data=('size='+str(remaining)+',nr_inodes=4096').encode()
    if ctypes.CDLL(None,use_errno=True).mount(b'tmpfs',os.fsencode(root),b'tmpfs',32|2|4|8,data):raise RuntimeError('QUOTA_SEALED_CHARGE_UNAVAILABLE')
    cap=os.statvfs(root);quota_proof['sealedSessionBytes']=os.fstat(held).st_size;quota_proof['remainingFilesystemBytes']=cap.f_blocks*cap.f_frsize
    if quota_proof['remainingFilesystemBytes']+quota_proof['sealedSessionBytes']>256*1024**2:raise RuntimeError('QUOTA_BINDING_INVALID')
    st=os.fstat(held);session_identity=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns)
    manifest={'networkHashes':hashes,'parameters':{'freq':q['freq'],'ntop':q['ntop']},'sessionHash':session_hash,'officialHash':official_hash,'containerHash':IMAGE_HASH,'generated':True,'scientificStatus':'unknown','offlineResources':{n:p['sha256'] for n,p in RESOURCE_PINS.items()},'identifiersMatched':True,'adaptationHash':adaptation_hash,'originalFiles':original_files,'adaptedFiles':official_files,'quota':quota_proof,'sessionBinding':'sealed-memfd-inherited-fd0'}
    (root/'manifest.json').write_text(json.dumps(manifest,sort_keys=True))
    manifest_hash=digest(root/'manifest.json');verify()
    launch('prepare',str(root/'load.R'),str(root),'check',session_hash);bounded_wait(child,30)
    if 'SIGNET_SESSION_LOADED' not in (root/'process.log').read_text(errors='replace'):raise RuntimeError('LOAD_UNVERIFIED')
    if 'SIGNET_OFFLINE_IDENTIFIERS_MATCHED' not in (root/'process.log').read_text(errors='replace'):raise RuntimeError('RESOURCE_CONSUMPTION_UNVERIFIED')
    verify();emit({'seq':seq,'value':{**manifest,'manifestHash':manifest_hash,'loadState':'loaded','guestRoot':str(root)}})
   elif op=='verify':verify();emit({'seq':seq,'value':{'sessionHash':session_hash,'manifestHash':manifest_hash,'loadState':'loaded','serviceAlive':server is not None and server.poll() is None}})
   elif op=='serve':
    verify()
    if server and server.poll() is None:raise RuntimeError('SERVICE_BUSY')
    port=q['port'];token=q['token']
    if type(port) is not int or not 1024<=port<=65535 or not isinstance(token,str) or len(token)!=36:raise RuntimeError('SERVICE_IDENTITY')
    offset=(root/'process.log').stat().st_size
    server=launch('serve',str(root/'load.R'),str(root),'serve',session_hash,str(port),token);end=time.monotonic()+12
    while time.monotonic()<end:
     interrupted();check_total()
     if server.poll() is not None:raise RuntimeError('SERVICE_EXITED')
     if ('Listening on http://127.0.0.1:'+str(port)) in (root/'process.log').read_bytes()[offset:].decode(errors='replace'):break
     time.sleep(.1)
    else:raise RuntimeError('SERVICE_NOT_LISTENING')
    verify()
    emit({'seq':seq,'value':{'port':port,'token':token,'pid':server.pid,'birth':open('/proc/'+str(server.pid)+'/stat').read().split()[21]}})
   elif op=='stop':stop(server);server=None;emit({'seq':seq,'value':{'stopped':True}})
   elif op=='close':break
   else:raise RuntimeError('UNKNOWN_OPERATION')
  except Exception as e:
   stop(child);details=None
   if root and (root/'resource-refusal.json').exists() and (root/'resource-refusal.json').stat().st_size<=8192:details=json.loads((root/'resource-refusal.json').read_text())
   emit({'seq':seq,'error':str(e),'details':details,'tail':(root/'process.log').read_text(errors='replace')[-3000:] if root and (root/'process.log').exists() else ''})
   if str(e)=='CANCELLED':break
finally:
 if resource_file:resource_file.close()
 stop(server);stop(child)
 if held is not None:os.close(held)
 if image_fd is not None:os.close(image_fd)
 if root:
  shutil.rmtree(root,ignore_errors=False) if not mounted else None
  if mounted:
   if ctypes.CDLL(None,use_errno=True).umount2(os.fsencode(root),0):raise RuntimeError('QUOTA_UNMOUNT_UNKNOWN')
   mounted=False;root.rmdir()
 emit({'event':'closed','resourcesClosed':all(p.poll() is not None for p in children),'children':[{'pid':p.pid,'exit':p.poll()} for p in children],'rootRemoved':str(root) if root else None})
