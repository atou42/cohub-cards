import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {build} from 'esbuild';
const root=new URL('../',import.meta.url);
await mkdir(new URL('dist/',root),{recursive:true});
const result=await build({entryPoints:[new URL('web/app.js',root).pathname],bundle:true,write:false,format:'esm',target:'es2022',minify:true});
const html=await readFile(new URL('web/card.html',root),'utf8');
const css=(await Promise.all(['web/card.css','web/composer.css'].map(path=>readFile(new URL(path,root),'utf8')))).join('\n');
if(!html.includes('<!--CARD_STYLE-->') || !html.includes('<!--CARD_SCRIPT-->'))throw new Error('Card build markers missing');
// Callback replacements preserve literal $& and $` strings inside the bundled SDK.
const output=html.replace('<!--CARD_STYLE-->',()=>`<style>${css}</style>`).replace('<!--CARD_SCRIPT-->',()=>`<script type="module">${result.outputFiles[0].text.replaceAll('</script','<\\/script')}</script>`);
if(output.includes('<!--CARD_'))throw new Error('Unresolved card build markers');
await writeFile(new URL('dist/card.html',root),output);
console.log('Built dist/card.html');
