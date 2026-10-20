import json,sys,urllib.request
U='https://mcp.luxalgo.com/mcp'
def rpc(method,params=None,i=[1]):
    i[0]+=1
    body=json.dumps({'jsonrpc':'2.0','id':i[0],'method':method,'params':params or {}}).encode()
    req=urllib.request.Request(U,data=body,headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream'})
    raw=urllib.request.urlopen(req,timeout=60).read().decode()
    for line in raw.splitlines():
        if line.startswith('data:'): return json.loads(line[5:])
    return json.loads(raw)
def call(name,args):
    r=rpc('tools/call',{'name':name,'arguments':args})
    if 'error' in r: raise SystemExit(r['error'])
    res=r['result']; 
    if res.get('structuredContent') is not None: return res['structuredContent']
    txt=''.join(c.get('text','') for c in res.get('content',[]))
    try: return json.loads(txt)
    except Exception: return txt
if __name__=='__main__':
    rpc('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'vnedge-research','version':'1'}})
    t=rpc('tools/list')['result']['tools']
    for x in t:
        if x['name'].startswith(('library_','edge_')): print(x['name'],'|',x.get('description','')[:110].replace('\n',' '),'| args:',list(x.get('inputSchema',{}).get('properties',{}).keys()))
