import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { startStdio, parseArgs } from '../local/server.mjs';

test('real stdio child negotiates MCP and discovers tools without CLI credentials',async()=>{
  const child=spawn(process.execPath,[fileURLToPath(new URL('../local/server.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  const messages=[];const waiters=[];let stderr='';
  child.stderr.on('data',data=>{stderr+=data});
  const reader=createInterface({input:child.stdout});
  reader.on('line',line=>{const message=JSON.parse(line);messages.push(message);waiters.shift()?.(message)});
  const next=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('stdio response deadline')),3000);waiters.push(value=>{clearTimeout(timer);resolve(value)})});
  async function request(id,method,params){const waiting=next();child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');return waiting}
  try{
    const init=await request(1,'initialize',{protocolVersion:'2025-11-25',clientInfo:{name:'stdio-test',version:'1'},capabilities:{}});
    assert.equal(init.result.serverInfo.name,'lets-talk-azure-local');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const listed=await request(2,'tools/list');
    assert.equal(listed.result.tools.length,7);
    const denied=await request(3,'tools/call',{name:'list_resource_groups',arguments:{}});
    assert.equal(denied.result.isError,true);
    assert.match(denied.result.content[0].text,/--subscription/);
    assert.equal(messages.length,3);assert.equal(stderr,'');
  }finally{child.stdin.end();child.kill();reader.close()}
});

test('transport handles split messages and invalid JSON without leaking payloads',async()=>{
  const input=new PassThrough(),output=new PassThrough(),diagnostics=new PassThrough();let text='';output.on('data',chunk=>{text+=chunk});
  startStdio(async msg=>({jsonrpc:'2.0',id:msg.id,result:{ok:true}}),{input,output,diagnostics});
  input.write('{"jsonrpc":"2.0",');input.write('"id":1,"method":"ping"}\n');input.write('secret invalid JSON\n');
  await new Promise(resolve=>setImmediate(resolve));
  const values=text.trim().split('\n').map(line=>JSON.parse(line));
  assert.equal(values[0].id,1);assert.equal(values[1].error.code,-32700);assert.ok(!text.includes('secret'));
  input.end();
});

test('oversized input closes without dispatching its content',async()=>{
  const input=new PassThrough(),output=new PassThrough(),diagnostics=new PassThrough();let calls=0;
  startStdio(async()=>{calls++},{input,output,diagnostics});
  input.write('x'.repeat(1024*1024+1));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(input.destroyed,true);assert.equal(calls,0);
});

test('startup options bind scope and reject hidden command or config overrides',()=>{
  assert.deepEqual(parseArgs(['--subscription','11111111-1111-1111-1111-111111111111','--resource-group','sandbox','--allow-type','Microsoft.Storage/storageAccounts']),{subscription:'11111111-1111-1111-1111-111111111111',resourceGroup:'sandbox',allowedTypes:['Microsoft.Storage/storageAccounts']});
  for(const args of [['--executable','untrusted'],['--subscription'],['--resource-group','a','--resource-group','b']])assert.throws(()=>parseArgs(args));
});
