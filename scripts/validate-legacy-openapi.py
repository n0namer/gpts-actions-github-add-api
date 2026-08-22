#!/usr/bin/env python3
import sys,re,datetime
from pathlib import Path
import yaml

path=Path(sys.argv[1] if len(sys.argv)>1 else 'legacy-gpts-api-github-action.yaml')
text=path.read_text(encoding='utf-8')
issues=[]

class Loader(yaml.SafeLoader):
    pass

def mapping(loader,node,deep=False):
    out={}
    for k_node,v_node in node.value:
        k=loader.construct_object(k_node,deep=deep)
        if k in out:
            issues.append(('DUPLICATE_KEY',f'line {k_node.start_mark.line+1}',repr(k)))
        out[k]=loader.construct_object(v_node,deep=deep)
    return out
Loader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,mapping)

try:
    doc=yaml.load(text,Loader=Loader)
except Exception as e:
    print('YAML_PARSE_FAIL\t'+str(e)); sys.exit(1)

if not isinstance(doc,dict): issues.append(('OPENAPI_ROOT','$','root must be object')); doc={}
if not str(doc.get('openapi','')).startswith('3.'): issues.append(('OPENAPI_VERSION','$.openapi',repr(doc.get('openapi'))))
paths=doc.get('paths')
if not isinstance(paths,dict): issues.append(('PATHS','$.paths','paths must be object')); paths={}

http={'get','put','post','delete','options','head','patch','trace'}
ops=[]

def walk(x,p='$'):
    if isinstance(x,(datetime.date,datetime.datetime)):
        issues.append(('YAML_DATE_COERCION',p,f'{x!r} ({type(x).__name__})'))
        return
    if isinstance(x,dict):
        t=x.get('type')
        if 'default' in x:
            d=x['default']
            ok=True
            if t=='string':
                ok=isinstance(d,str)
                if ok and re.fullmatch(r'\d{4}-\d{2}-\d{2}',d):
                    issues.append(('DATE_LIKE_STRING_DEFAULT',p+'.default',d))
            elif t=='integer': ok=isinstance(d,int) and not isinstance(d,bool)
            elif t=='number': ok=isinstance(d,(int,float)) and not isinstance(d,bool)
            elif t=='boolean': ok=isinstance(d,bool)
            if not ok: issues.append((f'{str(t).upper()}_DEFAULT_TYPE',p+'.default',f'{d!r} ({type(d).__name__})'))
        desc=x.get('description')
        if isinstance(desc,str) and len(desc)>300: issues.append(('DESCRIPTION_TOO_LONG',p+'.description',str(len(desc))))
        for k,v in x.items(): walk(v,p+'.'+str(k))
    elif isinstance(x,list):
        for i,v in enumerate(x): walk(v,f'{p}[{i}]')
walk(doc)

for url,item in paths.items():
    if not isinstance(item,dict): continue
    for method,op in item.items():
        if method.lower() not in http or not isinstance(op,dict): continue
        oid=op.get('operationId')
        if oid: ops.append((oid,url,method))
        vars=set(re.findall(r'{([^}]+)}',url))
        all_params=list(item.get('parameters',[]))+list(op.get('parameters',[]))
        params={q.get('name'):q for q in all_params if isinstance(q,dict) and q.get('in')=='path'}
        for var in vars:
            q=params.get(var)
            if q is None: issues.append(('MISSING_PATH_PARAMETER',f'$.paths.{url}.{method}',var))
            elif q.get('required') is not True: issues.append(('PATH_PARAMETER_NOT_REQUIRED',f'$.paths.{url}.{method}',var))

if len(ops)>30: issues.append(('OPERATION_LIMIT','$.paths',f'{len(ops)} > 30'))
if not any(oid=='graphql' for oid,_,_ in ops): issues.append(('REQUIRED_OPERATION_MISSING','$.paths','graphql'))

seen={}
for oid,url,method in ops:
    if oid in seen: issues.append(('DUPLICATE_OPERATION_ID',oid,f'{seen[oid]} vs {method.upper()} {url}'))
    else: seen[oid]=f'{method.upper()} {url}'
    if str(oid).startswith('github_'): issues.append(('FORBIDDEN_OPERATION_PREFIX',oid,'github_'))

print(f'file={path}')
print(f'operations={len(ops)}')
print(f'issues={len(issues)}')
for row in issues: print('\t'.join(map(str,row)))
sys.exit(1 if issues else 0)
