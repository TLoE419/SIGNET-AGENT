"""Fixed child boundary: no outbound connections; never accepts user code or paths."""
import os,sys,resource,ctypes,errno
if os.uname().machine!='x86_64':raise RuntimeError('ARCH_UNSUPPORTED')
resource.setrlimit(resource.RLIMIT_FSIZE,(128*1024**2,128*1024**2))
resource.setrlimit(resource.RLIMIT_AS,(4*1024**3,4*1024**3))
resource.setrlimit(resource.RLIMIT_CPU,(240,240))
resource.setrlimit(resource.RLIMIT_NOFILE,(128,128))
os.setgroups([]);os.setgid(65534);os.setuid(65534)
lib=ctypes.CDLL(None,use_errno=True)
class F(ctypes.Structure):_fields_=[('code',ctypes.c_ushort),('jt',ctypes.c_ubyte),('jf',ctypes.c_ubyte),('k',ctypes.c_uint)]
class P(ctypes.Structure):_fields_=[('length',ctypes.c_ushort),('filters',ctypes.POINTER(F))]
# Original official code is fixed; even its download helpers cannot connect/send datagrams.
rows=[F(0x20,0,0,4),F(0x15,1,0,0xc000003e),F(0x06,0,0,0x80000000),F(0x20,0,0,0)]
for nr in (42,44,46,307):rows += [F(0x15,0,1,nr),F(0x06,0,0,0x50000|errno.EPERM)]
if sys.argv[1]=='prepare':rows += [F(0x15,0,1,41),F(0x06,0,0,0x50000|errno.EPERM)]
else:
 # Only AF_INET SOCK_STREAM sockets can be listeners; connect remains denied.
 rows += [F(0x15,0,6,41),F(0x20,0,0,16),F(0x15,0,3,2),F(0x20,0,0,24),F(0x54,0,0,15),F(0x15,1,0,1),F(0x06,0,0,0x50000|errno.EPERM)]
rows += [F(0x06,0,0,0x7fff0000)];arr=(F*len(rows))(*rows);program=P(len(rows),arr)
if lib.prctl(38,1,0,0,0) or lib.prctl(22,2,ctypes.byref(program),0,0):raise OSError(ctypes.get_errno(),'SECCOMP_FAILED')
os.execv('/usr/bin/Rscript',['Rscript',*sys.argv[2:]])
