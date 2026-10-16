"""Fixed child boundary: no outbound connections; never accepts user code or paths."""
import os,sys,resource,ctypes,errno,shutil,fcntl,stat,subprocess,select,signal,json
if os.uname().machine!='x86_64':raise RuntimeError('ARCH_UNSUPPORTED')
resource.setrlimit(resource.RLIMIT_FSIZE,(128*1024**2,128*1024**2))
resource.setrlimit(resource.RLIMIT_AS,(4*1024**3,4*1024**3))
resource.setrlimit(resource.RLIMIT_CPU,(240,240))
resource.setrlimit(resource.RLIMIT_NOFILE,(256,256))
os.setgroups([]);os.setgid(65534);os.setuid(65534)
lib=ctypes.CDLL(None,use_errno=True)
class F(ctypes.Structure):_fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class P(ctypes.Structure):_fields_=[('length',ctypes.c_ushort),('filters',ctypes.POINTER(F))]
# Original official code is fixed; even its download helpers cannot connect/send datagrams.
rows=[F(0x20,0,0,4),F(0x15,1,0,0xc000003e),F(0x06,0,0,0x80000000),F(0x20,0,0,0),F(0x35,0,1,0x40000000),F(0x06,0,0,0x50000|errno.EPERM)]
for nr in (42,44,46,307):rows += [F(0x15,0,1,nr),F(0x06,0,0,0x50000|errno.EPERM)]
if sys.argv[1]=='prepare':rows += [F(0x15,0,1,41),F(0x06,0,0,0x50000|errno.EPERM)]
else:
 # Only AF_INET SOCK_STREAM sockets can be listeners; connect remains denied.
 rows += [F(0x15,0,6,41),F(0x20,0,0,16),F(0x15,0,3,2),F(0x20,0,0,24),F(0x54,0,0,15),F(0x15,1,0,1),F(0x06,0,0,0x50000|errno.EPERM)]
rows += [F(0x06,0,0,0x7fff0000)];arr=(F*len(rows))(*rows);program=P(len(rows),arr)
if lib.prctl(38,1,0,0,0) or lib.prctl(22,2,ctypes.byref(program),0,0):raise OSError(ctypes.get_errno(),'SECCOMP_FAILED')
if stat.S_ISREG(os.fstat(0).st_mode):
 if fcntl.fcntl(0,fcntl.F_GET_SEALS)!=15:raise RuntimeError('SESSION_STDIN_NOT_SEALED')
 os.lseek(0,0,0);print('SIGNET_SEALED_STDIN',flush=True)
def run_r(binary,arguments,profile_dir=None):
 # A narrow same-boundary waiter: the R child inherits every existing limit, UID, seccomp and FD0.
 read_fd=write_fd=None;profile=None;kept=dropped=0;env=os.environ.copy()
 if profile_dir:
  read_fd,write_fd=os.pipe();env['SIGNET_R_PROFILE']='/proc/self/fd/'+str(write_fd)
  profile=open(os.path.join(profile_dir,'r-profile.txt'),'xb',buffering=0)
 try:
  p=subprocess.Popen([binary,*arguments],env=env,pass_fds=(write_fd,) if write_fd is not None else ())
  try:
   with open('/proc/'+str(p.pid)+'/stat') as identity:birth=identity.read().split()[21]
  except OSError:birth=None
  if write_fd is not None:os.close(write_fd);write_fd=None
  while read_fd is not None:
   if select.select([read_fd],[],[],.1)[0]:
    b=os.read(read_fd,65536)
    if not b:break
    n=min(len(b),max(0,1048576-kept)) if profile else 0
    try:
     if profile:profile.write(b[:n])
    except OSError:
     profile.close();profile=None;n=0
    kept+=n;dropped+=len(b)-n
  code=p.wait();sig=-code if code<0 else None
  print('SIGNET_R_EXIT '+json.dumps({'pid':p.pid,'birth':birth,'returncode':code,'signal':sig,'signalName':signal.Signals(sig).name if sig else None,'profileBytes':kept,'profileDroppedBytes':dropped}),flush=True)
  return code
 finally:
  if profile:profile.close()
  for fd in (read_fd,write_fd):
   if fd is not None:os.close(fd)
binary=shutil.which('Rscript',path='/usr/local/bin:/usr/bin:/bin')
if not binary:raise RuntimeError('RSCRIPT_UNAVAILABLE')
print('SIGNET_R_EXEC '+binary,flush=True)
code=run_r(binary,sys.argv[2:],sys.argv[3] if len(sys.argv)>3 and os.path.basename(sys.argv[2])=='prepare.R' else None)
if code<0:os.kill(os.getpid(),-code)
sys.exit(code)
