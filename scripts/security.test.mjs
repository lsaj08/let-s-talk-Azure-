import {test} from 'node:test';
Error.stackTraceLimit=0;
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const mod=await import('data:text/javascript;base64,'+Buffer.from(await readFile('worker/guard.js','utf8')).toString('base64'));
const {worker,policy,settings,safeChanges,seal,load,save,arm}=mod;
const origin='https://private.example';
class Bucket {
  map=new Map();count=0;
  async put(k,v,options={}) {const old=this.map.get(k);if(options.onlyIf && old?.etag!==options.onlyIf.etagMatches)return null;const entry={body:v,etag:String(++this.count)};this.map.set(k,entry);return {etag:entry.etag};}
  async get(k){const v=this.map.get(k);return v?{etag:v.etag,json:async()=>JSON.parse(v.body)}:null;}
  async delete(k){this.map.delete(k);}
}
function env(){return {AZURE_TENANT_ID:'11111111-1111-1111-1111-111111111111',AZURE_CLIENT_ID:'22222222-2222-2222-2222-222222222222',AZURE_CLIENT_SECRET:'test-only-not-a-real-secret',AZURE_SUBSCRIPTION_ID:'33333333-3333-3333-3333-333333333333',AZURE_RESOURCE_GROUP:'sandbox',AZURE_ALLOWED_TYPES:'Microsoft.Storage/storageAccounts',VAULT_KEY:Buffer.alloc(32,1).toString('base64url'),BUCKET:new Bucket()};}
function target(e){return {...settings(e,origin),scope:'/subscriptions/'+e.AZURE_SUBSCRIPTION_ID+'/resourceGroups/sandbox',types:['microsoft.storage/storageaccounts']};}
function template(){return {$schema:'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',contentVersion:'1.0.0.0',resources:[{type:'Microsoft.Storage/storageAccounts',apiVersion:'2023-05-01',name:'armguardtest',location:'eastus',kind:'StorageV2',sku:{name:'Standard_LRS'},properties:{supportsHttpsTrafficOnly:true}}]};}
function req(path,method='GET',body,user='alice',browser=false){return new Request(origin+path,{method,headers:{...(user?{'oai-authenticated-user-id':user}:{}),...(browser?{Origin:origin,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}:{}),...(body?{'Content-Type':browser?'application/x-www-form-urlencoded':'application/json'}:{})},body:body?(browser?body:JSON.stringify(body)):undefined});}
const call=(name,args={},user='alice')=>req('/mcp','POST',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},user);
test('setup is fail closed and tool discovery remains available',async()=>{const r=await worker.fetch(call('connection_status'),{});assert.equal((await r.json()).result.isError,true);const page=await worker.fetch(req('/'),{});assert.equal(page.status,503);const d=await worker.fetch(req('/mcp','POST',{jsonrpc:'2.0',id:2,method:'tools/list'},null),{});assert.equal((await d.json()).result.tools.length,6);});
test('anonymous data-bearing tool calls are rejected',async()=>{assert.equal((await worker.fetch(call('connection_status',{},null),env())).status,401);});
test('configuration validates tenant, target and encryption key',()=>{const e=env();assert.ok(settings(e,origin));e.AZURE_TENANT_ID='common';assert.throws(()=>settings(e,origin));});
test('policy allows limited inline incremental deployment',()=>{assert.equal(policy(template(),{},target(env())).properties.mode,'Incremental');});
test('policy blocks nested deployments, IAM, scripts and unknown types',()=>{for(const type of ['Microsoft.Resources/deployments','Microsoft.Authorization/roleAssignments','Microsoft.Resources/deploymentScripts','Microsoft.Compute/virtualMachines']){const t=template();t.resources[0].type=type;assert.throws(()=>policy(t,{},target(env())));}});
test('policy rejects links, cross-scope, identity and sensitive fields',()=>{for(const key of ['templateLink','subscriptionId','scope','identity','adminPassword']){const t=template();t.resources[0].properties[key]='x';assert.throws(()=>policy(t,{},target(env())));}});
test('policy rejects expressions with cross-scope reads',()=>{for(const x of ["[reference('/subscriptions/other/resource')]","[listKeys('x','2020-01-01')]","[concat('a','b')]"]){const t=template();t.resources[0].properties.test=x;assert.throws(()=>policy(t,{},target(env())));}});
test('secret parameters are rejected and literals can be parameters',()=>{const t=template();t.parameters={loc:{type:'string'}};t.resources[0].location="[parameters('loc')]";assert.ok(policy(t,{loc:{value:'eastus'}},target(env())));t.parameters.loc.type='secureString';assert.throws(()=>policy(t,{loc:{value:'never-stored'}},target(env())));});
test('unknown, unresolved and delete changes block approval',()=>{const c=target(env());for(const changeType of ['Delete','Ignore','Unsupported','Deploy'])assert.throws(()=>safeChanges({changes:[{resourceId:c.scope+'/providers/Microsoft.Storage/storageAccounts/a',changeType}]},c));assert.throws(()=>safeChanges({changes:[{resourceId:'/subscriptions/other',changeType:'Modify'}]},c));});
test('vault encrypts payload and binds ciphertext to record identity',async()=>{const e=env();const cipher=await seal(e,'a',{token:'sensitive'});assert.ok(!cipher.includes('sensitive'));await e.BUCKET.put('a',cipher);assert.equal((await load(e,'a')).value.token,'sensitive');await e.BUCKET.put('b',cipher);await assert.rejects(load(e,'b'));});
test('atomic consumption prevents concurrent approvals',async()=>{const e=env();await save(e,'plan',{state:'review'});const p=await load(e,'plan');const r=await Promise.allSettled([save(e,'plan',{state:'submitted'},p.etag),save(e,'plan',{state:'submitted'},p.etag)]);assert.equal(r.filter(x=>x.status==='fulfilled').length,1);});
test('SSRF URL is rejected before credentials are sent',async()=>{await assert.rejects(arm('never-send','https://attacker.example/'));});
test('cross-site approval requests are rejected',()=>{assert.throws(()=>mod.browserPost(req('/review/a','POST','nonce=a&approve=yes','alice',false),origin));});
test('OAuth state is expiring, actor-bound and single use',async()=>{const e=env();const start=await worker.fetch(req('/azure/connect'),e);assert.equal(start.status,302);const target=new URL(start.headers.get('Location'));assert.equal(target.hostname,'login.microsoftonline.com');assert.equal(target.searchParams.get('code_challenge_method'),'S256');assert.ok(!target.searchParams.get('scope').includes('offline_access'));const state=target.searchParams.get('state');assert.equal((await worker.fetch(req('/azure/callback?state='+state+'&code=x','GET',null,'bob'),e)).status,403);const key='oauth/'+state;const old=await load(e,key);await save(e,key,{...old.value,expires:0},old.etag);assert.equal((await worker.fetch(req('/azure/callback?state='+state+'&code=x'),e)).status,403);});
test('exact approved payload deploys once; another user and replay cannot deploy',async()=>{
 const e=env(),cfg=target(e);await save(e,'tokens/alice',{token:'test-token',tenant:cfg.tenant,subscription:cfg.subscription,expires:Date.now()+100000});
 const previous=globalThis.fetch;let puts=[];
 globalThis.fetch=async(url,options={})=>{
   if(options.method==='PUT'){puts.push(JSON.parse(options.body));return Response.json({properties:{provisioningState:'Accepted'}});}
   if(String(url).includes('/whatIf?'))return Response.json({status:'Succeeded',properties:{changes:[{changeType:'Create',resourceId:cfg.scope+'/providers/Microsoft.Storage/storageAccounts/armguardtest'}]}});
   return Response.json({properties:{provisioningState:'Succeeded'}});
 };
 try {
  const pr=await worker.fetch(call('prepare_project',{resource_group:'sandbox',allowed_types:['Microsoft.Storage/storageAccounts'],create_new:false}),e);const project=JSON.parse((await pr.json()).result.content[0].text); const pp='/project-review/'+project.project_id; const ph=await worker.fetch(req(pp),e);const pn=/name="nonce" value="([^"]+)"/.exec(await ph.text())[1];assert.equal((await worker.fetch(req(pp,'POST','nonce='+pn+'&approve=yes','alice',true),e)).status,200);
  const r=await worker.fetch(call('prepare_what_if',{project_id:project.project_id,template:template()}),e);const out=JSON.parse((await r.json()).result.content[0].text);const path='/review/'+out.plan_id;
  assert.equal((await worker.fetch(req(path,'GET',null,'bob'),e)).status,404);
  const page=await worker.fetch(req(path),e);assert.equal(page.status,200);const nonce=/name="nonce" value="([^"]+)"/.exec(await page.text())[1];
  assert.equal((await worker.fetch(req(path,'POST','nonce=wrong&approve=yes','alice',true),e)).status,403);assert.equal(puts.length,0);
  const submitted=await worker.fetch(req(path,'POST','nonce='+nonce+'&approve=yes','alice',true),e);assert.equal(submitted.status,200);assert.equal(puts.length,1);assert.deepEqual(puts[0].properties.template,template());
  assert.equal((await worker.fetch(req(path,'POST','nonce='+nonce+'&approve=yes','alice',true),e)).status,409);assert.equal(puts.length,1);
 }finally{globalThis.fetch=previous;}
});
test('Azure sign-in setup does not require a permanently fixed resource group',()=>{
 const e=env();delete e.AZURE_RESOURCE_GROUP;delete e.AZURE_ALLOWED_TYPES;
 assert.equal(settings(e,origin).scope,'/subscriptions/'+e.AZURE_SUBSCRIPTION_ID);
});
test('existing project selection requires user approval and does not write to Azure',async()=>{
 const e=env(),c=settings(e,origin);await save(e,'tokens/alice',{token:'test-token',tenant:c.tenant,subscription:c.subscription,expires:Date.now()+100000});
 const previous=globalThis.fetch;let writes=0;
 globalThis.fetch=async(url,options={})=>{if(options.method==='PUT')writes++;return Response.json({location:'eastus',properties:{provisioningState:'Succeeded'}});};
 try {
  const r=await worker.fetch(call('prepare_project',{resource_group:'project-a',allowed_types:['Microsoft.Storage/storageAccounts'],create_new:false}),e);
  const result=(await r.json()).result;assert.equal(result.isError,false);
  const proposal=JSON.parse(result.content[0].text);assert.equal(writes,0);
  const status=(await (await worker.fetch(call('project_status',{project_id:proposal.project_id}),e)).json()).result;
  assert.equal(JSON.parse(status.content[0].text).state,'review');
  const blocked=(await (await worker.fetch(call('prepare_what_if',{project_id:proposal.project_id,template:template()}),e)).json()).result;assert.equal(blocked.isError,true);
  const path='/project-review/'+proposal.project_id;assert.equal((await worker.fetch(req(path,'GET',null,'bob'),e)).status,404);
  const page=await worker.fetch(req(path),e);assert.equal(page.status,200);const nonce=/name="nonce" value="([^"]+)"/.exec(await page.text())[1];
  assert.equal((await worker.fetch(req(path,'POST','nonce='+nonce+'&approve=yes','alice',true),e)).status,200);
  assert.equal(writes,0);
  const approved=(await (await worker.fetch(call('project_status',{project_id:proposal.project_id}),e)).json()).result;assert.equal(JSON.parse(approved.content[0].text).state,'approved');
  assert.equal((await worker.fetch(req(path,'POST','nonce='+nonce+'&approve=yes','alice',true),e)).status,409);
 } finally {globalThis.fetch=previous;}
});
test('new group creation is approved once and activates only after Azure succeeds',async()=>{
 const e=env(),c=settings(e,origin);await save(e,'tokens/alice',{token:'test-token',tenant:c.tenant,subscription:c.subscription,expires:Date.now()+100000});
 const previous=globalThis.fetch;const writes=[];let exists=false;let state='Running';
 globalThis.fetch=async(url,options={})=>{
  if(options.method==='PUT'){writes.push({url:String(url),body:JSON.parse(options.body)});return Response.json({properties:{provisioningState:'Accepted'}}, {status:201});}
  if(String(url).includes('/whatIf?'))return Response.json({status:'Succeeded',properties:{changes:[{changeType:'Create',resourceId:c.scope+'/resourceGroups/project-new'}]}});
  if(String(url).includes('/providers/Microsoft.Resources/deployments/'))return Response.json({properties:{provisioningState:state}});
  return exists?Response.json({location:'eastus'}):Response.json({error:'not found'},{status:404});
 };
 try {
  const r=await worker.fetch(call('prepare_project',{resource_group:'project-new',location:'eastus',allowed_types:['Microsoft.Storage/storageAccounts'],create_new:true}),e);const result=(await r.json()).result;assert.equal(result.isError,false);const out=JSON.parse(result.content[0].text);assert.equal(writes.length,0);
  const path='/project-review/'+out.project_id;const page=await worker.fetch(req(path),e);const nonce=/name="nonce" value="([^"]+)"/.exec(await page.text())[1];
  const responses=await Promise.all([worker.fetch(req(path,'POST','nonce='+nonce+'&approve=yes','alice',true),e),worker.fetch(req(path,'POST','nonce='+nonce+'&approve=yes','alice',true),e)]);
  assert.deepEqual(responses.map(x=>x.status).sort(),[200,409]);assert.equal(writes.length,1);
  assert.ok(writes[0].url.startsWith('https://management.azure.com'+c.scope+'/providers/Microsoft.Resources/deployments/armguard-group-'));
  assert.deepEqual(writes[0].body.properties.template.resources,[{type:'Microsoft.Resources/resourceGroups',apiVersion:'2021-04-01',name:'project-new',location:'eastus'}]);
  const pending=JSON.parse((await (await worker.fetch(call('project_status',{project_id:out.project_id}),e)).json()).result.content[0].text);assert.equal(pending.state,'submitted');assert.equal(pending.provisioning_state,'Running');
  const blocked=(await (await worker.fetch(call('validate_template',{project_id:out.project_id,template:template()}),e)).json()).result;assert.equal(blocked.isError,true);
  state='Succeeded';exists=true;
  const approved=JSON.parse((await (await worker.fetch(call('project_status',{project_id:out.project_id}),e)).json()).result.content[0].text);assert.equal(approved.state,'approved');assert.equal(approved.scope,c.scope+'/resourceGroups/project-new');
  const otherUser=(await (await worker.fetch(call('project_status',{project_id:out.project_id},'bob'),e)).json()).result;assert.equal(otherUser.isError,true);
 } finally {globalThis.fetch=previous;}
});
test('project allowlists reject wildcards and privileged providers before Azure calls',async()=>{
 const e=env(),c=settings(e,origin);await save(e,'tokens/alice',{token:'test-token',tenant:c.tenant,subscription:c.subscription,expires:Date.now()+100000});
 const previous=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({});};
 try {for(const type of ['*','Microsoft.Authorization/roleAssignments','Microsoft.Resources/deployments','Microsoft.ManagedIdentity/userAssignedIdentities','Microsoft.Compute/virtualMachines/extensions']){
  const result=(await (await worker.fetch(call('prepare_project',{resource_group:'test',create_new:false,allowed_types:[type]}),e)).json()).result;assert.equal(result.isError,true);
 }assert.equal(calls,0);}finally{globalThis.fetch=previous;}
});
test('a new-group proposal cannot silently target an existing group',async()=>{
 const e=env(),c=settings(e,origin);await save(e,'tokens/alice',{token:'test-token',tenant:c.tenant,subscription:c.subscription,expires:Date.now()+100000});
 const previous=globalThis.fetch;let writes=0;globalThis.fetch=async(url,options={})=>{if(options.method!=='GET')writes++;return Response.json({location:'eastus'});};
 try {const result=(await (await worker.fetch(call('prepare_project',{resource_group:'existing',create_new:true,location:'eastus',allowed_types:['Microsoft.Storage/storageAccounts']}),e)).json()).result;assert.equal(result.isError,true);assert.equal(writes,0);}finally{globalThis.fetch=previous;}
});
test('private pages preserve the origin needed for browser approval',async()=>{
 const r=await worker.fetch(req('/'),env());
 assert.equal(r.status,200);
 assert.equal(r.headers.get('Referrer-Policy'),'strict-origin-when-cross-origin');
});
