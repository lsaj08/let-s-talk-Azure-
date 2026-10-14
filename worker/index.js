// This file is inlined into worker/index.js by the build script; no runtime dependencies.
const ARM = 'https://management.azure.com';
const VERSION = '2025-04-01';
const enc = new TextEncoder();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const un64 = s => Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async s => b64(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function settings(env, origin) {
  const keys = ['AZURE_TENANT_ID','AZURE_CLIENT_ID','AZURE_CLIENT_SECRET','AZURE_SUBSCRIPTION_ID','VAULT_KEY'];
  const missing = keys.filter(k=>!env[k]);
  if (missing.length) fail('Azure setup incomplete: '+missing.join(', '), 503);
  const guid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  for (const k of keys.slice(0,2).concat('AZURE_SUBSCRIPTION_ID')) if (!guid.test(env[k])) fail('Invalid configuration: '+k,503);
  if (un64(env.VAULT_KEY).length!==32) fail('Invalid vault key',503);
  if (!env.BUCKET) fail('Private storage unavailable',503);
  return {tenant:env.AZURE_TENANT_ID, client:env.AZURE_CLIENT_ID, secret:env.AZURE_CLIENT_SECRET,
    subscription:env.AZURE_SUBSCRIPTION_ID, types:[],
    origin, scope:`/subscriptions/${env.AZURE_SUBSCRIPTION_ID}`};
}
function projectSpec(args,cfg) {
  const group=args.resource_group;
  if(typeof group!=='string' || !/^[\w.()-]{1,90}$/.test(group) || group.endsWith('.')) fail('Use a literal resource-group name');
  if(!Array.isArray(args.allowed_types) || args.allowed_types.length<1 || args.allowed_types.length>30) fail('Choose 1–30 explicit resource types for this project');
  const types=[...new Set(args.allowed_types.map(t=>typeof t==='string'?t.toLowerCase():''))].sort();
  for(const type of types) if(!/^microsoft\.[a-z]+\/[a-z0-9/]+$/.test(type) || /^microsoft\.(authorization|resources|managedidentity)\//i.test(type) || /deploymentScripts|extensions/i.test(type)) fail('Invalid or privileged resource type');
  if(typeof args.create_new!=='boolean') fail('Specify whether to create a new group');
  if(args.create_new && (typeof args.location!=='string' || !/^[a-z0-9]{2,40}$/.test(args.location))) fail('Choose a literal Azure region for a new group');
  return {tenant:cfg.tenant,subscription:cfg.subscription,scope:cfg.scope+'/resourceGroups/'+group,group,types,create:args.create_new,location:args.create_new?args.location:null};
}
const projectDigest=p=>hash(canonical({spec:p.spec,body:p.body}));
async function projectRecord(env,user,cfg,id,requireApproved=false) {
  if(!/^[a-f0-9]{32}$/.test(id||'')) fail('Invalid project ID');
  const record=await load(env,'projects/'+id);
  if(!record || record.value.user!==user) fail('Project not found',404);
  const p=record.value;
  if(p.spec.tenant!==cfg.tenant || p.spec.subscription!==cfg.subscription || p.digest!==await projectDigest(p)) fail('Project configuration or integrity changed',409);
  const normalized=projectSpec({resource_group:p.spec.group,allowed_types:p.spec.types,create_new:p.spec.create,location:p.spec.location},cfg);
  if(canonical(normalized)!==canonical(p.spec)) fail('Project scope mismatch',409);
  if(requireApproved && p.state!=='approved') fail('Approve the project before preparing deployments',403);
  return record;
}
async function projectTarget(env,user,cfg,id) {
  const {value:p}=await projectRecord(env,user,cfg,id,true);
  return {...cfg,...p.spec,project_id:id};
}
function groupDeploymentPath(cfg,id) {return cfg.scope+'/providers/Microsoft.Resources/deployments/armguard-group-'+id;}
function groupChanges(value,spec) {
  const r=value.properties||value;
  if(value.status && value.status!=='Succeeded' || r.error || r.diagnostics?.length || !Array.isArray(r.changes) || r.changes.length!==1) fail('Resource-group what-if incomplete or unsafe',409);
  if(r.changes[0].changeType!=='Create' || String(r.changes[0].resourceId).toLowerCase()!==spec.scope.toLowerCase()) fail('Only creation of the exact new group is allowed',409);
  return r.changes;
}
async function seal(env, key, value) {
  const aes = await crypto.subtle.importKey('raw',un64(env.VAULT_KEY),'AES-GCM',false,['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(key)},aes,enc.encode(JSON.stringify(value)));
  return JSON.stringify({iv:b64(iv),data:b64(new Uint8Array(encrypted))});
}
async function load(env,key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return null;
  const body = await obj.json();
  const aes = await crypto.subtle.importKey('raw',un64(env.VAULT_KEY),'AES-GCM',false,['decrypt']);
  const value = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:un64(body.iv),additionalData:enc.encode(key)},aes,un64(body.data))));
  return {value,etag:obj.etag};
}
async function save(env,key,value,etag) {
  const result = await env.BUCKET.put(key,await seal(env,key,value),etag?{onlyIf:{etagMatches:etag}}:{});
  if (!result) fail('Concurrent update or already consumed request',409);
}
function policy(template, parameters, cfg) {
  if (!template || !Array.isArray(template.resources) || !template.resources.length || template.resources.length>100) fail('Use an inline resource-group ARM template with 1–100 resources');
  if (template.languageVersion || template.definitions || template.functions || template.outputs) fail('ARM language extensions, functions and outputs are disabled');
  if (JSON.stringify({template,parameters}).length>250000) fail('Template too large',413);
  const walk = (v, depth=0) => {
    if (depth>30) fail('Template nesting too deep');
    if (typeof v==='string' && v.startsWith('[') && !v.startsWith('[[') && !/^\[parameters\('[A-Za-z0-9_-]+'\)\]$/.test(v)) fail('Only direct parameters() expressions are supported');
    if (v && typeof v==='object') {
      for (const [k,x] of Object.entries(v)) {
        if (['templatelink','parameterslink','scope','subscriptionid','resourcegroup','resources','copy','condition','identity'].includes(k.toLowerCase())) fail('Cross-scope, linked, conditional, identity or nested resources are disabled');
        if (/password|secret|token|credential|connectionstring|accesskey|privatekey|certificate|sas/i.test(k)) fail('Secrets and credentials are disabled in template input');
        walk(x,depth+1);
      }
    }
  };
  for (const [name,def] of Object.entries(template.parameters||{})) {
    if (/^secure/i.test(def.type||'')) fail('Secure parameters are disabled in this release; never submit secrets');
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail('Invalid parameter name');
  }
  if (!parameters || Array.isArray(parameters) || typeof parameters!=='object') fail('Parameters must be a name-to-value object');
  for (const [name,p] of Object.entries(parameters)) {
    if (!(name in (template.parameters||{})) || !p || Object.keys(p).length!==1 || !Object.hasOwn(p,'value')) fail('Parameters must contain only declared literal values');
    // Parameter values must not become ARM expressions when used in resource properties.
    walk(p.value);
    if (JSON.stringify(p.value).includes('[parameters(')) fail('Parameter expressions are disabled');
  }
  for (const r of template.resources) {
    if (!r || typeof r.type!=='string' || !cfg.types.includes(r.type.toLowerCase())) fail('Resource type not allowed');
    if (/^microsoft\.(authorization|resources|managedidentity)\//i.test(r.type) || /deploymentScripts|extensions/i.test(r.type)) fail('Privileged resource type blocked');
    if (typeof r.name!=='string' || r.name.includes('[') || !/^[A-Za-z0-9_.()-]+$/.test(r.name)) fail('Use literal resource names');
    if (!/^\d{4}-\d{2}-\d{2}(-preview)?$/.test(r.apiVersion||'')) fail('Use a literal API version');
    walk(r);
  }
  // Parameter defaults and other root fields are input too; never let them bypass policy.
  const {resources:checkedResources,...rootFields}=template;
  walk(rootFields);
  return {properties:{mode:'Incremental',template,parameters}};
}
function redact(v) {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v==='object') {
    const sensitivePath=/password|secret|token|credential|connectionstring|accesskey|privatekey|certificate|sas/i.test(String(v.path||v.propertyName||''));
    return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,(/password|secret|token|credential|connectionstring|accesskey|privatekey|certificate|sas/i.test(k) || sensitivePath && ['before','after','value'].includes(k))?'[REDACTED]':redact(x)]));
  }
  return v;
}
async function arm(token, path, method='GET', body, allowMissing=false) {
  const url = new URL(path,ARM);
  if (url.origin!==ARM || url.username || url.password) fail('Unsafe Azure URL');
  const res=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  if(allowMissing && res.status===404) return {value:null,next:null,status:404};
  if (!res.ok) fail('Azure request failed (HTTP '+res.status+'); inspect Azure Activity Log',502);
  const value=await res.json();
  const next=res.headers.get('Azure-AsyncOperation')||res.headers.get('Location');
  if (next) {
    const u=new URL(next);
    if (u.origin!==ARM || u.username || u.password || !u.pathname.toLowerCase().startsWith('/subscriptions/')) fail('Unsafe Azure polling URL',502);
  }
  return {value,next,status:res.status};
}
function deploymentPath(cfg,id) {return cfg.scope+'/providers/Microsoft.Resources/deployments/armguard-'+id;}
async function tokenFor(env,user,cfg) {
  const record=await load(env,'tokens/'+user);
  if (!record || record.value.expires<Date.now()+30000) fail('Connect or reconnect your Azure account in the private review page',401);
  if (record.value.tenant!==cfg.tenant || record.value.subscription!==cfg.subscription) fail('Azure connection configuration changed; reconnect',401);
  return record.value.token;
}
function safeChanges(value,cfg) {
  const result=value.properties||value;
  if (!Array.isArray(result.changes)) fail('What-if is not complete',409);
  if (value.status && !['Succeeded','succeeded'].includes(value.status)) fail('What-if failed or incomplete',409);
  if (result.error || result.diagnostics?.length) fail('What-if has unresolved diagnostics',409);
  for (const c of result.changes) {
    if (!['Create','Modify','NoChange','NoEffect'].includes(c.changeType)) fail('Unsafe or unresolved what-if change: '+c.changeType,409);
    if (!String(c.resourceId).toLowerCase().startsWith((cfg.scope+'/providers/').toLowerCase())) fail('What-if changes an unapproved scope',409);
  }
  return result.changes;
}
const tools=[
  {name:'connection_status',description:'Show setup and connection status. No Azure writes.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'prepare_project',description:'Propose a project resource group and resource-type allowlist. Existing group selection or new-group creation requires user browser approval. Does not deploy.',inputSchema:{type:'object',properties:{resource_group:{type:'string'},allowed_types:{type:'array',items:{type:'string'},minItems:1,maxItems:30},create_new:{type:'boolean'},location:{type:'string'}},required:['resource_group','allowed_types','create_new'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'project_status',description:'Read or poll a proposed project. Does not deploy.',inputSchema:{type:'object',properties:{project_id:{type:'string',pattern:'^[a-f0-9]{32}$'}},required:['project_id'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'validate_template',description:'Validate an inline ARM template in an approved project. No deployment.',inputSchema:{type:'object',properties:{project_id:{type:'string'},template:{type:'object'},parameters:{type:'object'}},required:['project_id','template'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'prepare_what_if',description:'Prepare a what-if plan for an approved project. Only the user may approve the private review URL. Never submit secrets.',inputSchema:{type:'object',properties:{project_id:{type:'string'},template:{type:'object'},parameters:{type:'object'}},required:['project_id','template'],additionalProperties:false},annotations:{readOnlyHint:true}},
  {name:'plan_status',description:'Poll a prepared plan or read its deployment state. No deployment.',inputSchema:{type:'object',properties:{plan_id:{type:'string',pattern:'^[a-f0-9]{32}$'}},required:['plan_id'],additionalProperties:false},annotations:{readOnlyHint:true}}
];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function html(content,status=200) {
  return new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Azure ARM Guard</title><style>body{font:17px system-ui;margin:4rem auto;padding:0 24px;max-width:900px;color:#17344a;background:#f3f7fa}h1{font-size:38px}a,button{color:#065db6}button{padding:14px;border:1px solid #065db6;border-radius:8px;background:white;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:20px;border-radius:10px}p{line-height:1.6}</style><h1>Azure ARM Guard</h1>'+content+'</html>',{status,headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'strict-origin-when-cross-origin','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",'X-Content-Type-Options':'nosniff'}});
}
function browserPost(req,origin) {
  if (req.method!=='POST' || req.headers.get('Origin')!==origin || req.headers.get('Sec-Fetch-Site')!=='same-origin' || req.headers.get('Sec-Fetch-Mode')!=='navigate' || req.headers.get('Sec-Fetch-Dest')!=='document') fail('Approval requires the private browser form',403);
  if (Number(req.headers.get('Content-Length')||0)>2000) fail('Form too large',413);
}
async function jsonBody(req) {
  if (Number(req.headers.get('Content-Length')||0)>300000) fail('Request too large',413);
  const reader=req.body?.getReader(); if (!reader) fail('Missing request body');
  let bytes=0,chunks=[];
  while (true) {const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>300000){await reader.cancel();fail('Request too large',413);}chunks.push(value);}
  const all=new Uint8Array(bytes);let offset=0;for(const x of chunks){all.set(x,offset);offset+=x.length;}
  return JSON.parse(new TextDecoder().decode(all));
}
async function handleTool(name,args,env,user,cfg) {
  if(name==='connection_status') {
    const record=await load(env,'tokens/'+user);
    return {connected:!!record && record.value.expires>Date.now(),scope:cfg.scope,review_url:cfg.origin,mode:'Incremental',approval:'user browser form only'};
  }
  const token=await tokenFor(env,user,cfg);
  if(name==='prepare_project') {
    const spec=projectSpec(args,cfg),id=crypto.randomUUID().replaceAll('-','');
    const group=await arm(token,spec.scope+'?api-version=2021-04-01','GET',undefined,true);
    if(spec.create && group.status!==404) fail('Group already exists; select it with create_new=false',409);
    if(!spec.create && group.status===404) fail('Group does not exist; propose creation explicitly',404);
    const body=spec.create?{location:spec.location,properties:{mode:'Incremental',template:{$schema:'https://schema.management.azure.com/schemas/2018-05-01/subscriptionDeploymentTemplate.json#',contentVersion:'1.0.0.0',resources:[{type:'Microsoft.Resources/resourceGroups',apiVersion:'2021-04-01',name:spec.group,location:spec.location}]}}}:null;
    const r=spec.create?await arm(token,groupDeploymentPath(cfg,id)+'/whatIf?api-version='+VERSION,'POST',body):null;
    if(r?.status===202 && !r.next) fail('Azure did not supply a polling URL',502);
    const p={user,spec,body,state:'review',nonce:random(),expires:Date.now()+600000,whatif:r?.value||null,next:r?.next||null};
    p.digest=await projectDigest(p);await save(env,'projects/'+id,p);
    return {project_id:id,state:'review',scope:spec.scope,allowed_types:spec.types,creates_group:spec.create,digest:p.digest,review_url:cfg.origin+'/project-review/'+id};
  }
  if(name==='project_status') {
    const key='projects/'+args.project_id,record=await projectRecord(env,user,cfg,args.project_id),p=record.value;
    if(p.state==='review' && p.expires<Date.now()) fail('Project proposal expired',409);
    if(p.state==='review' && p.next) {
      const r=await arm(token,p.next);
      if(['Failed','Canceled'].includes(r.value.status)) fail('Group what-if failed',409);
      if(Array.isArray((r.value.properties||r.value).changes)){groupChanges(r.value,p.spec);p.whatif=r.value;p.next=null;await save(env,key,p,record.etag);}
      else return {project_id:args.project_id,state:'what_if_pending'};
    }
    if(p.state==='submitted') {
      const r=await arm(token,groupDeploymentPath(cfg,args.project_id)+'?api-version='+VERSION);
      const state=r.value.properties?.provisioningState;
      if(state!=='Succeeded') return {project_id:args.project_id,state:'submitted',provisioning_state:state};
      await arm(token,p.spec.scope+'?api-version=2021-04-01');
      p.state='approved';await save(env,key,p,record.etag);
    }
    return {project_id:args.project_id,state:p.state,scope:p.spec.scope,allowed_types:p.spec.types,creates_group:p.spec.create,review_url:cfg.origin+'/project-review/'+args.project_id};
  }
  if(name==='validate_template' || name==='prepare_what_if') {
    cfg=await projectTarget(env,user,cfg,args.project_id);
    const body=policy(args.template,args.parameters||{},cfg);
    const id=crypto.randomUUID().replaceAll('-','');
    const base=deploymentPath(cfg,id);
    if(name==='validate_template') {
      const r=await arm(token,base+'/validate?api-version='+VERSION,'POST',body);
      return {validated:r.status===200 && !r.value.error,pending:r.status===202,details:redact(r.value),note:'Validation is not deployment approval'};
    }
    await arm(token,base+'/validate?api-version='+VERSION,'POST',body);
    const r=await arm(token,base+'/whatIf?api-version='+VERSION,'POST',body);
    const value={user,project_id:cfg.project_id,scope:cfg.scope,tenant:cfg.tenant,body,digest:await hash(canonical({scope:cfg.scope,body})),created:Date.now(),expires:Date.now()+600000,state:'review',next:r.next,whatif:r.value,nonce:random()};
    if(r.status===202 && !r.next) fail('Azure did not supply a polling URL',502);
    await save(env,'plans/'+id,value);
    return {plan_id:id,digest:value.digest,expires_at:new Date(value.expires).toISOString(),review_url:cfg.origin+'/review/'+id,ready:r.status!==202,changes:r.status===200?redact(r.value):undefined};
  }
  if(name==='plan_status') {
    if(!/^[a-f0-9]{32}$/.test(args.plan_id||'')) fail('Invalid plan ID');
    const key='plans/'+args.plan_id, record=await load(env,key);
    if(!record || record.value.user!==user) fail('Plan not found',404);
    const p=record.value;
    cfg=await projectTarget(env,user,cfg,p.project_id);
    if(p.scope!==cfg.scope || p.tenant!==cfg.tenant) fail('Configuration changed; create a new plan',409);
    if(p.state!=='review') {
      const r=await arm(token,deploymentPath(cfg,args.plan_id)+'?api-version='+VERSION);
      return {state:p.state,provisioning_state:r.value.properties?.provisioningState,plan_id:args.plan_id};
    }
    if(p.expires<Date.now()) fail('Plan expired; prepare a new what-if',409);
    if(p.next) {
      const r=await arm(token,p.next);
      const status=r.value.status;
      if(['Failed','Canceled'].includes(status)) fail('What-if failed',409);
      if(Array.isArray((r.value.properties||r.value).changes)) {p.whatif=r.value;p.next=null;await save(env,key,p,record.etag);}
      else return {state:'pending',plan_id:args.plan_id};
    }
    safeChanges(p.whatif,cfg);
    return {state:'ready_for_user_review',digest:p.digest,changes:redact(p.whatif),review_url:cfg.origin+'/review/'+args.plan_id};
  }
  fail('Unknown tool',404);
}
async function mcp(req,env,user,origin) {
  const msg=await jsonBody(req);
  if(msg.jsonrpc!=='2.0') fail('JSON-RPC 2.0 required');
  if(msg.id===undefined) return new Response(null,{status:202});
  let result;
  if(msg.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'azure-arm-guard',version:'0.2.0'},instructions:'Each project requires explicit user approval of its group and types before template deployment review. Only a human user may approve in the private review page. Never automate approval.'};
  else if(msg.method==='ping') result={};
  else if(msg.method==='tools/list') result={tools};
  else if(msg.method==='tools/call') {
    if(!user) return Response.json({error:'Authentication required'},{status:401});
    try {
      const cfg=settings(env,origin);
      const output=await handleTool(msg.params?.name,msg.params?.arguments||{},env,user,cfg);
      result={content:[{type:'text',text:JSON.stringify(output)}],isError:false};
    } catch(e) {result={content:[{type:'text',text:e.status?e.message:'Operation failed safely; inspect server logs'}],isError:true};}
  } else return Response.json({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}});
  return Response.json({jsonrpc:'2.0',id:msg.id,result},{headers:{'Cache-Control':'no-store'}});
}
async function route(req,env) {
  const url=new URL(req.url), user=req.headers.get('oai-authenticated-user-id');
  if(url.pathname==='/mcp' && req.method==='POST') return mcp(req,env,user,url.origin);
  if(!user) return html('<p>Inicia sesión en ChatGPT para acceder a este complemento privado.</p>',401);
  let cfg;
  try {cfg=settings(env,url.origin);} catch(e) {
    return html('<p>Conexión a Azure pendiente de configuración. Las operaciones están bloqueadas.</p><p>'+esc(e.message)+'</p><p>Se requiere una aplicación Entra de un solo tenant y secretos guardados en la configuración del servidor. El grupo y los tipos permitidos se eligen y aprueban por proyecto.</p>',503);
  }
  if(url.pathname==='/' && req.method==='GET') {
    const t=await load(env,'tokens/'+user);
    return html('<p>Validación y what-if de plantillas ARM. Los cambios requieren revisar el plan y aprobarlo en esta página.</p><p>Suscripción conectada: <strong>'+esc(cfg.scope)+'</strong></p><p>'+ (t && t.value.expires>Date.now()?'Azure conectado hasta '+esc(new Date(t.value.expires).toISOString()):'Azure desconectado')+'</p><a href="/azure/connect">Conectar con Microsoft Azure</a><p>En el chat, elige un grupo existente o uno nuevo, su región y los tipos de recursos del proyecto. Primero aprueba el proyecto; después revisa y aprueba cada despliegue.</p><p>Modo incremental. Sin borrados, scripts, IAM, enlaces externos ni secretos en las plantillas. La vista what-if es una predicción; otros cambios en Azure pueden alterar el resultado.</p>');
  }
  if(url.pathname==='/azure/connect' && req.method==='GET') {
    const state=random(),verifier=random(),challenge=await hash(verifier);
    await save(env,'oauth/'+state,{user,verifier,expires:Date.now()+300000,state:'new'});
    const dest=new URL('https://login.microsoftonline.com/'+cfg.tenant+'/oauth2/v2.0/authorize');
    dest.search=new URLSearchParams({client_id:cfg.client,response_type:'code',redirect_uri:url.origin+'/azure/callback',response_mode:'query',scope:'https://management.azure.com/user_impersonation',state,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
    return Response.redirect(dest,302);
  }
  if(url.pathname==='/azure/callback' && req.method==='GET') {
    const state=url.searchParams.get('state');
    if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')) fail('Invalid OAuth state',403);
    const key='oauth/'+state,record=await load(env,key);
    if(!record || record.value.user!==user || record.value.state!=='new' || record.value.expires<Date.now()) fail('OAuth state invalid or expired',403);
    const data=record.value;
    await save(env,key,{...data,state:'consumed'},record.etag);
    if(url.searchParams.has('error') || !url.searchParams.get('code')) fail('Microsoft sign-in was not completed',401);
    const res=await fetch('https://login.microsoftonline.com/'+cfg.tenant+'/oauth2/v2.0/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(20000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:cfg.client,client_secret:cfg.secret,redirect_uri:url.origin+'/azure/callback',code:url.searchParams.get('code'),code_verifier:data.verifier,scope:'https://management.azure.com/user_impersonation'})});
    if(!res.ok) fail('Microsoft token exchange failed',401);
    const t=await res.json();
    if(!t.access_token || !Number.isFinite(t.expires_in) || t.token_type?.toLowerCase()!=='bearer') fail('Invalid Microsoft response',401);
    const sub=await arm(t.access_token,'/subscriptions/'+cfg.subscription+'?api-version=2022-12-01');
    if(String(sub.value.tenantId).toLowerCase()!==cfg.tenant.toLowerCase()) fail('Subscription tenant mismatch',403);
    await save(env,'tokens/'+user,{token:t.access_token,expires:Date.now()+Math.min(t.expires_in,3600)*1000,tenant:cfg.tenant,subscription:cfg.subscription});
    await env.BUCKET.delete(key);
    return html('<p>Azure conectado. No se ha modificado ningún recurso.</p><a href="/">Volver</a>');
  }
  const projectMatch=/^\/project-review\/([a-f0-9]{32})$/.exec(url.pathname);
  if(projectMatch) {
    const id=projectMatch[1],key='projects/'+id,record=await projectRecord(env,user,cfg,id),p=record.value;
    if(p.state!=='review' || p.expires<Date.now()) fail('Project proposal expired or already submitted',409);
    if(p.next) return html('<p>What-if del grupo pendiente. Usa project_status en el chat antes de aprobar.</p>');
    if(p.spec.create) groupChanges(p.whatif,p.spec);
    if(req.method==='GET') return html('<p>'+ (p.spec.create?'Crear un grupo de recursos nuevo en '+esc(p.spec.location)+'. Su creación se enviará a Azure después de aprobar. What-if es una predicción y puede variar si alguien crea el mismo grupo simultáneamente.':'Autorizar un grupo existente para este proyecto. Esta aprobación no modificará el grupo en Azure.')+'</p><p>'+esc(p.spec.scope)+'</p><p>Tipos permitidos: '+esc(p.spec.types.join(', '))+'</p><p>SHA-256: '+esc(p.digest)+'</p>'+(p.spec.create?'<pre>'+esc(JSON.stringify(redact(p.whatif),null,2))+'</pre>':'')+'<form method="post"><input type="hidden" name="nonce" value="'+esc(p.nonce)+'"><p><label><input type="checkbox" name="approve" value="yes" required> Apruebo este grupo y estos tipos para el proyecto'+(p.spec.create?', incluida la creación del grupo':'')+'. Los despliegues de recursos requerirán otra aprobación.</label></p><button type="submit">'+(p.spec.create?'Aprobar y crear grupo':'Aprobar proyecto')+'</button></form>');
    browserPost(req,url.origin);const form=await req.formData();
    if(form.get('nonce')!==p.nonce || form.get('approve')!=='yes') fail('Explicit project approval required',403);
    const token=await tokenFor(env,user,cfg);
    const group=await arm(token,p.spec.scope+'?api-version=2021-04-01','GET',undefined,true);
    if(p.spec.create && group.status!==404) fail('Group appeared since review; prepare a new existing-group project',409);
    if(!p.spec.create && group.status===404) fail('Selected group no longer exists',409);
    await save(env,key,{...p,state:p.spec.create?'submitted':'approved',nonce:null,approvedAt:Date.now()},record.etag);
    if(p.spec.create) {await arm(token,groupDeploymentPath(cfg,id)+'?api-version='+VERSION,'PUT',p.body);return html('<p>Creación del grupo enviada. Usa project_status hasta que el proyecto esté aprobado. No se ha enviado ningún despliegue de recursos del proyecto.</p>');}
    return html('<p>Proyecto aprobado. Usa su project_id para validar y preparar what-if. No se modificaron recursos Azure.</p>');
  }
  const match=/^\/review\/([a-f0-9]{32})$/.exec(url.pathname);
  if(match) {
    const id=match[1],key='plans/'+id,record=await load(env,key);
    if(!record || record.value.user!==user) fail('Plan not found',404);
    const p=record.value;
    cfg=await projectTarget(env,user,cfg,p.project_id);
    if(p.state!=='review' || p.expires<Date.now()) fail('Plan expired or already submitted',409);
    if(p.scope!==cfg.scope || p.tenant!==cfg.tenant || p.digest!==await hash(canonical({scope:cfg.scope,body:p.body}))) fail('Plan integrity or configuration changed',409);
    policy(p.body.properties.template,p.body.properties.parameters,cfg);
    if(p.next) return html('<p>What-if pendiente. Usa plan_status en el chat para actualizarlo. No se puede aprobar todavía.</p>');
    const changes=safeChanges(p.whatif,cfg);
    if(req.method==='GET') return html('<p>Revisa el destino, la plantilla y cada cambio. Esta aprobación enviará exactamente este plan a Azure.</p><p>'+esc(p.scope)+'</p><p>SHA-256: '+esc(p.digest)+'</p><p>Caduca: '+esc(new Date(p.expires).toISOString())+'</p><pre>'+esc(JSON.stringify(redact(changes),null,2))+'</pre><details><summary>Plantilla y parámetros</summary><pre>'+esc(JSON.stringify(redact(p.body),null,2))+'</pre></details><form method="post"><input type="hidden" name="nonce" value="'+esc(p.nonce)+'"><p><label><input type="checkbox" name="approve" value="yes" required> He revisado este plan y autorizo estos cambios y sus posibles costes.</label></p><button type="submit">Aprobar y desplegar en Azure</button></form>');
    browserPost(req,url.origin);
    const form=await req.formData();
    if(form.get('nonce')!==p.nonce || form.get('approve')!=='yes') fail('Explicit approval required',403);
    const token=await tokenFor(env,user,cfg);
    // Atomic consume before the Azure write; a timeout must never trigger an automatic retry.
    await save(env,key,{...p,state:'submitted',nonce:null,approvedAt:Date.now()},record.etag);
    const r=await arm(token,deploymentPath(cfg,id)+'?api-version='+VERSION,'PUT',p.body);
    return html('<p>Despliegue enviado a Azure. Estado: '+esc(r.value.properties?.provisioningState||'Accepted')+'</p><p>Consulta plan_status en el chat. Si hay un fallo o un tiempo de espera, consulta este despliegue antes de crear otro.</p>');
  }
  fail('Not found',404);
}
const worker={async fetch(req,env){try{return await route(req,env);}catch(e){return html('<p>'+esc(e.status?e.message:'Operation failed safely. Consult deployment status before retrying.')+'</p>',e.status||500);}}};
export {worker,policy,settings,canonical,safeChanges,seal,load,save,arm,browserPost};
export default worker;
