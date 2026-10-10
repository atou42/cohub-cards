import {readFile} from 'node:fs/promises';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {registerAppTool,registerAppResource} from '@modelcontextprotocol/ext-apps/server';
import {z} from 'zod';
import {createReader,querySchema} from './cards.mjs';
import {createGenerationService,prepareSchema,readDraftSchema,updateDraftSchema,revisionSchema,addReferenceSchema} from './generation.mjs';
export const UI_URI='ui://cohub-cards/result.html';
export function createServer(reader=createReader(),generation=createGenerationService()) {
  const server=new McpServer({name:'cohub-cards',version:'0.3.0'});
  const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true};
  const ui={resourceUri:UI_URI};
  registerAppResource(server,'cohub-result',UI_URI,{},async()=>({contents:[{
    uri:UI_URI,mimeType:'text/html;profile=mcp-app',text:await readFile(new URL('../dist/card.html',import.meta.url),'utf8'),
    _meta:{ui:{prefersBorder:false,csp:{resourceDomains:['https://router-files.neta.art','https://oss.talesofai.cn','https://sessions.cohub.live','https://cca.neta.art','https://works.cohub.live','https://public.cohub.live'],connectDomains:[]}},'openai/ui':{preferredDisplayMode:'inline',availableDisplayModes:['inline','fullscreen']}},
  }]}));
  async function respond(handler,args) {
    try {const card=await handler(args);return {structuredContent:card,content:[{type:'text',text:JSON.stringify(card),annotations:{audience:['assistant']}}]};}
    catch(error){return {isError:true,content:[{type:'text',text:error.code==='REVISION_CONFLICT'?'REVISION_CONFLICT: 内容已更新，请读取最新草稿后合并。':error.message}],...(error.code?{_meta:{code:error.code,currentRevision:error.current?.revision}}:{})};}
  }
  const identity=z.object({spaceId:z.uuid(),id:z.uuid()}).strict();
  registerAppTool(server,'show_generation',{title:'查看 Cohub 生成结果',description:'Show an existing Cohub generation as a large visual card. Read only. Use prepare_generation for a new shared editable draft.',inputSchema:identity,annotations,_meta:{ui}},args=>respond(reader,{kind:'generation',...args}));
  registerAppTool(server,'show_publication',{title:'查看 Cohub 发布结果',description:'Show a published Cohub App with its actual link and version. Read only; publish using the official Cohub CLI first.',inputSchema:identity,annotations,_meta:{ui}},args=>respond(reader,{kind:'publication',...args}));
  server.registerTool('read_card',{description:'Refresh this card from the same existing Cohub object without submitting any job.',inputSchema:querySchema,annotations,_meta:{ui:{visibility:['app']}}},args=>respond(reader,args));
  const edits={readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
  registerAppTool(server,'prepare_generation',{
    title:'准备 Cohub 生成',description:'Create one shared editable generation draft and its inline UI. Fill model, prompt, media, parameters and meta for the user. Empty model opens the live model picker. Does not submit or charge. For subsequent edits read and update the same draftId.',
    inputSchema:prepareSchema,annotations:edits,_meta:{ui},
  },args=>respond(generation.prepare,args));
  server.registerTool('read_generation_draft',{
    title:'读取生成草稿',description:'Read the latest shared draft, its revision, live model fields and any submitted result. Read before editing; the user may have changed the UI.',
    inputSchema:readDraftSchema,annotations,_meta:{ui:{visibility:['model','app']}},
  },args=>respond(generation.read,args));
  server.registerTool('update_generation_draft',{
    title:'共同编辑生成内容',description:'Update the same user/agent draft using its current baseRevision. Only supplied fields change. Conflicts preserve existing work; read and merge instead of retrying an old copy. This tool updates the existing card, without submitting generation.',
    inputSchema:updateDraftSchema,annotations:edits,_meta:{ui:{visibility:['model','app']}},
  },args=>respond(generation.update,args));
  server.registerTool('submit_generation',{
    title:'开始 Cohub 生成',description:'Submit the saved shared draft to Cohub, possibly incurring model charges. Use only when the user requests generation or presses Generate. Requires the current revision. A draft submits at most once; an unknown attempt must be investigated, never silently retried. Local references become accessible URLs in the selected Cohub Space for the model to read.',
    inputSchema:revisionSchema,annotations:{...edits,idempotentHint:true,openWorldHint:true},_meta:{ui:{visibility:['model','app']}},
  },args=>respond(generation.submit,args));
  server.registerTool('add_generation_reference',{
    title:'添加生成素材',description:'Attach exactly one HTTPS URL or user-selected local media file to the shared draft. A file is staged locally, up to 20 MB; upload happens only at generation submission. Browser UIs pass base64; agents may pass an authorized local filePath. Preserves media type and declared role.',
    inputSchema:addReferenceSchema,annotations:edits,_meta:{ui:{visibility:['model','app']}},
  },args=>respond(generation.addReference,args));
  return server;
}
if(process.argv[1] && new URL(import.meta.url).pathname===process.argv[1])await createServer().connect(new StdioServerTransport());
