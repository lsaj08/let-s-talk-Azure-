import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createAzureService } from './service.mjs';
import { createAzureRunner } from './azure-cli.mjs';

const versions=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
export function createProtocol(service) {
  let initialized=false,ready=false;
  const error=(id,code,message)=>({jsonrpc:'2.0',id,error:{code,message}});
  return async message=>{
    if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string'||(Object.hasOwn(message,'id')&&typeof message.id!=='number'&&typeof message.id!=='string'))return error(null,-32600,'Invalid request');
    const hasId=Object.hasOwn(message,'id'),id=hasId?message.id:null;
    if(!hasId){if(initialized&&message.method==='notifications/initialized')ready=true;return null}
    const result=value=>({jsonrpc:'2.0',id,result:value});
    if(message.method==='ping')return result({});
    if(message.method==='initialize'){
      if(initialized)return error(id,-32600,'Already initialized');
      if(typeof message.params?.protocolVersion!=='string')return error(id,-32602,'Missing protocol version');
      initialized=true;
      return result({protocolVersion:versions.includes(message.params.protocolVersion)?message.params.protocolVersion:versions[0],capabilities:{tools:{listChanged:false}},serverInfo:{name:'lets-talk-azure-local',version:'0.2.0'}});
    }
    if(!ready)return error(id,-32002,'Initialize the MCP session first');
    if(message.method==='tools/list')return result({tools:service.tools});
    if(message.method==='tools/call'){
      try{const value=await service.call(message.params?.name,message.params?.arguments);return result({content:[{type:'text',text:JSON.stringify(value)}],isError:false})}
      catch(e){return result({content:[{type:'text',text:service.publicError(e)}],isError:true})}
    }
    return error(id,-32601,'Method not found');
  };
}

export function parseArgs(argv) {
  const config={allowedTypes:[]};
  for(let i=0;i<argv.length;i++){
    const key=argv[i],value=argv[++i];
    if(!value||value.startsWith('--'))throw new Error('Each option needs a value');
    if(key==='--subscription'&&!config.subscription)config.subscription=value;
    else if(key==='--resource-group'&&!config.resourceGroup)config.resourceGroup=value;
    else if(key==='--allow-type')config.allowedTypes.push(value);
    else throw new Error('Unknown or repeated server option');
  }
  return config;
}

export function startStdio(handle,{input=process.stdin,output=process.stdout,diagnostics=process.stderr}={}) {
  let buffer=Buffer.alloc(0),queue=Promise.resolve(),pending=0,closed=false;
  const send=value=>{if(value)output.write(JSON.stringify(value)+'\n')};
  const stop=()=>{closed=true;input.destroy();diagnostics.write('MCP input limit exceeded; session closed.\n')};
  input.on('data',chunk=>{
    if(closed)return;
    buffer=Buffer.concat([buffer,Buffer.from(chunk)]);
    if(buffer.length>1024*1024){stop();return}
    let index;
    while((index=buffer.indexOf(10))!==-1){
      const line=buffer.subarray(0,index).toString('utf8');buffer=buffer.subarray(index+1);
      if(!line.trim())continue;
      if(++pending>16){stop();return}
      queue=queue.then(async()=>{
        try{let message;try{message=JSON.parse(line)}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON'}});return}send(await handle(message))}
        catch{send({jsonrpc:'2.0',id:null,error:{code:-32603,message:'Internal error'}})}
        finally{pending--}
      });
    }
  });
  input.on('end',()=>{if(buffer.length)diagnostics.write('Incomplete MCP message discarded.\n')});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{startStdio(createProtocol(createAzureService(parseArgs(process.argv.slice(2)),createAzureRunner())))}
  catch{process.stderr.write('Invalid Azure MCP configuration. Use --subscription UUID [--resource-group NAME --allow-type TYPE].\n');process.exitCode=1}
}
