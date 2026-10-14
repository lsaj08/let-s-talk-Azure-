import {readFile,mkdir,writeFile} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
const source=await readFile('worker/guard.js','utf8');
await writeFile('worker/index.js',source);
await writeFile('dist/server/index.js',source);
await writeFile('dist/.openai/hosting.json',await readFile('.openai/hosting.json'));
console.log('Worker built without dependencies');
