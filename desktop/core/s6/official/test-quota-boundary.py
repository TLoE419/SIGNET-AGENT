import ast,pathlib,types,time,stat,subprocess,json,resource
source=pathlib.Path(__file__).with_name('guest.py');tree=ast.parse(source.read_text());functions=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in ('check_total','bounded_wait')]
class File:
 def lstat(self):return types.SimpleNamespace(st_mode=stat.S_IFREG,st_size=96*1024**2)
class Root:
 def rglob(self,p):return [File(),File(),File()]
class Process:
 returncode=0
 def __init__(self,running):self.running=running
 def poll(self):return None if self.running else 0
ns={'root':Root(),'held':None,'stat':stat,'time':time,'resource':resource,'wait_evidence':lambda *args:None,'interrupted':lambda:None,'subprocess':subprocess};exec(compile(ast.Module(body=functions,type_ignores=[]),str(source),'exec'),ns)
rows=[]
for running in (False,True):
 try:ns['bounded_wait'](Process(running),30);result='accepted'
 except RuntimeError as e:result=str(e)
 assert result=='DISK_LIMIT';rows.append({'running':running,'bytes':288*1024**2,'result':result})
print(json.dumps({'production_functions':True,'scope':'metadata boundary, not native filesystem quota','cases':rows}))
