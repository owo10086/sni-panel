import difflib,hashlib,json,pathlib,subprocess
root=pathlib.Path.cwd();tmp=pathlib.Path('/private/tmp/forwardx-282-ticket11');base=json.loads((tmp/'before-sha256.json').read_text());after={}
paths=subprocess.check_output(['git','ls-files','-c','-o','--exclude-standard','-z']).decode().split('\0')
for name in set(paths)-{''}:
 if name.startswith('.scratch/') or not (root/name).is_file(): continue
 after[name]=hashlib.sha256((root/name).read_bytes()).hexdigest()
changes=[];diff=''
for name in sorted(base.keys()|after.keys()):
 if base.get(name)==after.get(name): continue
 changes.append({'path':name,'before':base.get(name),'after':after.get(name),'status':'modified' if name in base and name in after else 'new' if name in after else 'deleted'})
 a=(tmp/'before'/name).read_text().splitlines(keepends=True) if name in base else []
 b=(root/name).read_text().splitlines(keepends=True) if name in after else []
 diff+=''.join(difflib.unified_diff(a,b,fromfile='a/'+name,tofile='b/'+name))
(tmp/'changed-files.json').write_text(json.dumps({'baselineFiles':len(base),'changes':changes},ensure_ascii=False,indent=2)+'\n')
(tmp/'11代码差异.diff').write_text(diff)
(tmp/'after-sha256.json').write_text(json.dumps(after,ensure_ascii=False,indent=2,sort_keys=True)+'\n')
print(json.dumps({'baselineFiles':len(base),'changed':len(changes),'files':[x['path'] for x in changes]},ensure_ascii=False))
