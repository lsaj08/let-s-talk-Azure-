import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

let createAzureService, createProtocol;
try { ({ createAzureService } = await import('../local/service.mjs')); } catch(e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
try { ({ createProtocol } = await import('../local/server.mjs')); } catch(e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const subscription='11111111-1111-1111-1111-111111111111';
const config={subscription,resourceGroup:'sandbox',allowedTypes:['Microsoft.Storage/storageAccounts']};
const template={resources:[{type:'Microsoft.Storage/storageAccounts',apiVersion:'2023-05-01',name:'example',location:'eastus',kind:'StorageV2',sku:{name:'Standard_LRS'},properties:{supportsHttpsTrafficOnly:true}}]};

test('inventory is bound to the configured subscription and strips tags and properties',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  const service=createAzureService(config,async argv=>{
    assert.deepEqual(argv,['group','list','--subscription',subscription,'--query','[].{id:id,name:name,location:location}']);
    return [{id:'/subscriptions/'+subscription+'/resourceGroups/sandbox',name:'sandbox',location:'eastus',tags:{secret:'must-not-return'}}];
  });
  assert.deepEqual(await service.call('list_resource_groups',{}),{groups:[{id:'/subscriptions/'+subscription+'/resourceGroups/sandbox',name:'sandbox',location:'eastus'}]});
});

test('caller cannot override scope or select an arbitrary CLI command',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  let calls=0; const service=createAzureService(config,async()=>{calls++;return [];});
  for(const [name,args] of [['list_resource_groups',{subscription:'other'}],['run_command',{command:'account get-access-token'}],['deploy_template',{template}],['list_resources',{resource_group:'other'}]]) await assert.rejects(service.call(name,args));
  assert.equal(calls,0);
});

test('template checks reuse policy before Azure, and temp inputs are cleaned',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  let paths; const service=createAzureService(config,async argv=>{
    assert.equal(argv[0],'deployment'); assert.equal(argv[1],'group'); assert.equal(argv[2],'validate');
    assert.equal(argv[argv.indexOf('--subscription')+1],subscription);
    assert.equal(argv[argv.indexOf('--resource-group')+1],'sandbox');
    paths=[argv[argv.indexOf('--template-file')+1],argv[argv.indexOf('--parameters')+1].slice(1)];
    assert.deepEqual(JSON.parse(await readFile(paths[0],'utf8')),template);
    return {properties:{provisioningState:'Succeeded',outputs:{token:'do-not-return'}}};
  });
  await assert.rejects(service.call('validate_template',{template:{resources:[{type:'Microsoft.Authorization/roleAssignments',apiVersion:'2022-04-01',name:'bad'}]}}));
  assert.equal(paths,undefined);
  assert.deepEqual(await service.call('validate_template',{template}),{status:'Succeeded',valid:true});
  for(const p of paths) await assert.rejects(readFile(p),{code:'ENOENT'});
});

test('what-if returns only bounded resource IDs and change types; no deployment is submitted',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  const service=createAzureService(config,async argv=>{
    assert.equal(argv[2],'what-if'); assert.ok(argv.includes('--no-pretty-print')); assert.ok(argv.includes('ResourceIdOnly'));
    return {status:'Succeeded',changes:[{resourceId:'/subscriptions/'+subscription+'/resourceGroups/sandbox/providers/Microsoft.Storage/storageAccounts/example',changeType:'Create',after:{secret:'do-not-return'}}]};
  });
  assert.deepEqual(await service.call('what_if',{template}),{status:'Succeeded',changes:[{resourceId:'/subscriptions/'+subscription+'/resourceGroups/sandbox/providers/Microsoft.Storage/storageAccounts/example',changeType:'Create'}],deploymentSubmitted:false});
});

test('missing per-project scope and sensitive templates fail before Azure',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  let calls=0;const run=async()=>{calls++;return []};
  await assert.rejects(createAzureService({subscription},run).call('what_if',{template}));
  const bad=structuredClone(template);bad.resources[0].properties.password='never-send';
  await assert.rejects(createAzureService(config,run).call('validate_template',{template:bad}));
  assert.equal(calls,0);
});

test('CLI failures never echo stderr, credentials, or arbitrary provider content',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  const service=createAzureService(config,async()=>{throw new Error('secret-value-in-stderr')});
  await assert.rejects(service.call('list_resource_groups',{}),e=>!e.message.includes('secret-value')&&e.message.includes('Azure CLI'));
});

test('cross-scope parameter defaults are blocked before the CLI is called',async()=>{
  assert.equal(typeof createAzureService,'function','local Azure service is missing');
  let calls=0;const service=createAzureService(config,async()=>{calls++;return {properties:{provisioningState:'Succeeded'}}});
  const bad=structuredClone(template);bad.parameters={region:{type:'string',defaultValue:"[reference('/subscriptions/other/resource')]"}};
  await assert.rejects(service.call('validate_template',{template:bad}));
  assert.equal(calls,0);
});

test('MCP lifecycle, tool discovery and errors preserve JSON-RPC IDs',async()=>{
  assert.equal(typeof createProtocol,'function','stdio protocol is missing');
  const service=createAzureService(config,async()=>[]);const protocol=createProtocol(service);
  const request=(id,method,params)=>({jsonrpc:'2.0',id,method,params});
  assert.equal((await protocol(request(1,'tools/list'))).error.code,-32002);
  const init=await protocol(request(2,'initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'test',version:'1'},capabilities:{}}));
  assert.equal(init.id,2);assert.equal(init.result.protocolVersion,'2025-11-25');
  assert.equal(await protocol({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  const list=await protocol(request(3,'tools/list'));
  assert.ok(list.result.tools.some(t=>t.name==='list_resource_groups'));
  assert.ok(list.result.tools.every(t=>t.annotations.readOnlyHint&&t.annotations.destructiveHint===false));
  assert.ok(!list.result.tools.some(t=>/approve|deploy_template|run_command|get_access_token/.test(t.name)));
  const call=await protocol(request(4,'tools/call',{name:'list_resource_groups',arguments:{}}));
  assert.equal(call.id,4);assert.deepEqual(JSON.parse(call.result.content[0].text),{groups:[]});
  assert.equal((await protocol(request(5,'tools/call',{name:'run_command'}))).result.isError,true);
  assert.equal((await protocol(request(6,'unknown'))).error.code,-32601);
});
