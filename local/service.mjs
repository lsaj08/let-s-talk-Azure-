import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { policy } from '../worker/guard.js';

class PublicError extends Error {}
const fail=message=>{throw new PublicError(message)};
const guid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
const empty={type:'object',properties:{},additionalProperties:false};
const templateInput={type:'object',properties:{template:{type:'object',description:'Inline non-confidential ARM JSON template.'},parameters:{type:'object',description:'Declared literal values only; never secrets.'}},required:['template'],additionalProperties:false};
export const tools=[
  {name:'connection_status',description:'Check the Azure CLI session for the configured subscription. Does not sign in.',inputSchema:empty,annotations},
  {name:'list_subscriptions',description:'List subscription IDs, names and tenant IDs accessible to the CLI session.',inputSchema:empty,annotations},
  {name:'list_resource_groups',description:'List resource group metadata in the operator-configured subscription.',inputSchema:empty,annotations},
  {name:'list_resources',description:'List resource metadata in the operator-configured project group. No resource properties or tags.',inputSchema:empty,annotations},
  {name:'validate_template',description:'Validate an inline restricted ARM template in the configured project. Does not deploy.',inputSchema:templateInput,annotations},
  {name:'what_if',description:'Preview resource IDs and change types for an inline restricted ARM template. Does not deploy. Preview can drift.',inputSchema:templateInput,annotations},
  {name:'deployment_status',description:'Read the state of a named existing deployment in the configured project group.',inputSchema:{type:'object',properties:{name:{type:'string',pattern:'^[A-Za-z0-9_.()-]{1,64}$'}},required:['name'],additionalProperties:false},annotations}
];
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>typeof value?.[k]==='string'||typeof value?.[k]==='boolean').map(k=>[k,value[k]]));
function list(value,keys){if(!Array.isArray(value)||value.length>10000)fail('Unexpected Azure inventory result');return value.map(v=>pick(v,keys));}

export function createAzureService(input,runAzure) {
  // Scope is trusted process configuration, never an MCP argument. Freeze a copy.
  const config=structuredClone(input);
  if(config.subscription!==undefined&&!guid.test(config.subscription))fail('Use a subscription UUID in server configuration');
  if(config.resourceGroup!==undefined&&(typeof config.resourceGroup!=='string'||! /^[\p{L}\p{N}_.()-]{1,90}$/u.test(config.resourceGroup)||config.resourceGroup.endsWith('.')))fail('Use a literal resource group in server configuration');
  const types=config.allowedTypes||[];
  if(!Array.isArray(types)||types.length>30||types.some(t=>typeof t!=='string'||!/^microsoft\.[a-z]+\/[a-z0-9/]+$/i.test(t)||/^microsoft\.(authorization|resources|managedidentity)\//i.test(t)||/deploymentScripts|extensions/i.test(t)))fail('Choose explicit nonprivileged resource types in server configuration');
  config.allowedTypes=types.map(t=>t.toLowerCase());
  const scope=()=>{if(!config.subscription)fail('Configure --subscription before this operation');return ['--subscription',config.subscription]};
  const group=()=>{if(!config.resourceGroup)fail('Configure --resource-group before this operation');return [...scope(),'--resource-group',config.resourceGroup]};
  const run=async argv=>{try{return await runAzure(argv)}catch{fail('Azure CLI request failed. Check CLI installation, az login, scope and RBAC privately. Raw errors are suppressed.')}};
  async function withTemplate(args,operation) {
    const target=group();
    if(!config.allowedTypes.length)fail('Configure at least one --allow-type before template operations');
    const parameters=args.parameters||{};
    try{policy(args.template,parameters,{types:config.allowedTypes})}catch(e){if(e.status)fail(e.message);fail('Invalid ARM template input')}
    // Keep CLI JSON out of command lines and stdout. No persistent token or plan store.
    const folder=await mkdtemp(join(tmpdir(),'azure-arm-guard-'));
    try {
      const templatePath=join(folder,'template.json'),parametersPath=join(folder,'parameters.json');
      await writeFile(templatePath,JSON.stringify(args.template),{mode:0o600});
      await writeFile(parametersPath,JSON.stringify(parameters),{mode:0o600});
      const argv=['deployment','group',operation,...target,'--mode','Incremental','--template-file',templatePath,'--parameters','@'+parametersPath];
      if(operation==='what-if')argv.push('--no-pretty-print','--result-format','ResourceIdOnly');
      return await run(argv);
    } finally {await rm(folder,{recursive:true,force:true})}
  }
  return {
    tools,
    async call(name,args={}) {
      const tool=tools.find(t=>t.name===name);
      if(!tool)fail('Unknown or unsupported tool; local deployment and token tools are not exposed');
      if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!Object.hasOwn(tool.inputSchema.properties,k))||(tool.inputSchema.required||[]).some(k=>!Object.hasOwn(args,k)))fail('Invalid tool arguments; scope cannot be overridden');
      if(name==='list_subscriptions')return {subscriptions:list(await run(['account','list','--query','[].{id:id,name:name,tenantId:tenantId,state:state}']),['id','name','tenantId','state'])};
      if(name==='connection_status')return {account:pick(await run(['account','show',...scope(),'--query','{id:id,name:name,tenantId:tenantId,state:state,environmentName:environmentName}']),['id','name','tenantId','state','environmentName']),resourceGroup:config.resourceGroup||null,allowedTypes:config.allowedTypes};
      if(name==='list_resource_groups')return {groups:list(await run(['group','list',...scope(),'--query','[].{id:id,name:name,location:location}']),['id','name','location'])};
      if(name==='list_resources')return {resources:list(await run(['resource','list',...group(),'--query','[].{id:id,name:name,type:type,location:location}']),['id','name','type','location'])};
      if(name==='deployment_status') {
        if(typeof args.name!=='string'||!/^[A-Za-z0-9_.()-]{1,64}$/.test(args.name))fail('Use a literal deployment name');
        return {deployment:pick(await run(['deployment','group','show',...group(),'--name',args.name,'--query','{id:id,name:name,provisioningState:properties.provisioningState,timestamp:properties.timestamp}']),['id','name','provisioningState','timestamp'])};
      }
      const value=await withTemplate(args,name==='what_if'?'what-if':'validate');
      if(name==='validate_template') {
        const status=value?.properties?.provisioningState;
        if(value?.error||value?.properties?.error||status!=='Succeeded')fail('Validation did not return Succeeded; inspect the result privately');
        return {status,valid:true};
      }
      if(value?.status!=='Succeeded'||value.error||!Array.isArray(value.changes)||value.changes.length>1000)fail('What-if did not return a complete successful result');
      const prefix=('/subscriptions/'+config.subscription+'/resourceGroups/'+config.resourceGroup+'/providers/').toLowerCase();
      const changes=value.changes.map(change=>{
        if(typeof change.resourceId!=='string'||change.resourceId.length>2048||!change.resourceId.toLowerCase().startsWith(prefix)||!['Create','Modify','Delete','NoChange','Ignore','Deploy','Unsupported'].includes(change.changeType))fail('Unexpected or out-of-scope what-if change');
        return pick(change,['resourceId','changeType']);
      });
      return {status:'Succeeded',changes,deploymentSubmitted:false};
    },
    publicError(error){return error instanceof PublicError?error.message:'Local operation failed safely; inspect configuration privately'}
  };
}
