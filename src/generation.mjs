import {z} from 'zod';
import {createDraftStore,mediaSchema,patchSchema} from './drafts.mjs';
import {createModelCatalog,validateDraft,limitationsFor} from './models.mjs';
import {createReader} from './cards.mjs';
import {runCohub} from './cli.mjs';
import {MAX_REFERENCE_BYTES,stageReference,uploadReference} from './references.mjs';

const jsonObject=z.record(z.string(),z.json());
export const prepareSchema=z.object({
  spaceId:z.uuid(),title:z.string().max(200).optional(),model:z.string().min(1).nullable().optional(),
  prompt:z.string().max(100000).optional(),media:z.array(mediaSchema).max(30).optional(),
  parameters:jsonObject.optional(),meta:jsonObject.optional(),
}).strict();
export const readDraftSchema=z.object({draftId:z.uuid()}).strict();
export const revisionSchema=readDraftSchema.extend({baseRevision:z.number().int().positive()}).strict();
export const updateDraftSchema=revisionSchema.extend({patch:patchSchema}).strict();
export const addReferenceSchema=revisionSchema.extend({
  type:z.enum(['image','video','audio']),url:z.string().optional(),filePath:z.string().optional(),
  name:z.string().max(240).optional(),mimeType:z.string().max(100).optional(),
  base64:z.string().max(Math.ceil(MAX_REFERENCE_BYTES/3)*4).optional(),role:z.string().max(80).optional(),
}).strict();

function editable(draft) {
  if(draft.status!=='draft')throw new Error('这份草稿已经提交；继续修改请创建新草稿，原任务仍可查看。');
}
function fields(draft) {
  return {model:draft.model,prompt:draft.prompt,media:draft.media,parameters:draft.parameters,meta:draft.meta};
}
export function generationArgs(draft,media=draft.media) {
  const args=['-s',draft.spaceId,'generate','--model',draft.model,'--async','--json'];
  for(const item of media) {
    if(item.source.type!=='url')throw new Error('本地素材尚未完成上传');
    const extra=Object.keys(item.meta||{}).filter(key=>key!=='role');
    if(extra.length)throw new Error(`官方 CLI 不支持素材字段：${extra.join(', ')}`);
    args.push(`--${item.type}`,`${item.meta?.role?item.meta.role+'=':''}${item.source.url}`);
  }
  if(Object.keys(draft.parameters).length)args.push('--parameters',JSON.stringify(draft.parameters));
  if(Object.keys(draft.meta).length)args.push('--meta',JSON.stringify(draft.meta));
  args.push('--',draft.prompt);
  return args;
}
export function createGenerationService({execute=runCohub,store=createDraftStore(),catalog=createModelCatalog(execute),readCard=createReader(execute),directory=store.directory}={}) {
  async function view(draft) {
    const [models,model,generation]=await Promise.all([
      catalog.list(),draft.model?catalog.get(draft.model):null,
      draft.taskRunId?readCard({kind:'generation',spaceId:draft.spaceId,id:draft.taskRunId}):null,
    ]);
    return {kind:'composer',draft,model,catalog:models,generation,
      validation:model?validateDraft(fields(draft),model):{errors:[{path:'model',message:'请选择生成模型'}]},
      limitations:model?limitationsFor(model):[]};
  }
  async function prepare(input) {
    const args=prepareSchema.parse(input);
    if(args.model)await catalog.get(args.model);
    return view(await store.create(args));
  }
  async function read(input) {
    const {draftId}=readDraftSchema.parse(input);
    return view(await store.get(draftId));
  }
  async function update(input) {
    const {draftId,baseRevision,patch}=updateDraftSchema.parse(input);
    if(patch.model)await catalog.get(patch.model);
    return view(await store.mutate(draftId,baseRevision,draft=>{editable(draft);return {...draft,...patch};}));
  }
  async function addReference(input) {
    const args=addReferenceSchema.parse(input);
    if([args.url,args.filePath,args.base64].filter(value=>value!==undefined).length!==1)throw new Error('请选择一个素材链接或文件');
    const saved=await store.mutate(args.draftId,args.baseRevision,async draft=>{
      editable(draft);
      const source=args.url?{type:'url',url:args.url}:await stageReference(directory,args);
      const item=mediaSchema.parse({type:args.type,source,...(args.role?{meta:{role:args.role}}:{})});
      return {...draft,media:[...draft.media,item]};
    });
    return view(saved);
  }
  async function submit(input) {
    const {draftId,baseRevision}=revisionSchema.parse(input);
    const current=await store.get(draftId);
    if(current.status==='submitted')return view(current);
    if(current.status==='submitting')return view(current);
    if(current.status==='unknown')throw new Error(`此前提交结果未确认，不能重复生成。请先查询 Cohub 任务。${current.error||''}`);
    if(!current.model)throw new Error('请选择生成模型');
    const model=await catalog.get(current.model,{fresh:true});
    const validation=validateDraft(fields(current),model);
    if(validation.errors.length)throw new Error(validation.errors.map(error=>`${error.path}：${error.message}`).join('\n'));
    const started=await store.mutate(draftId,baseRevision,draft=>{editable(draft);const next={...draft,status:'submitting'};delete next.error;return next;});
    let media;
    try {
      media=[];
      for(const item of started.media)media.push(item.source.type==='file'?await uploadReference(execute,directory,draftId,started.spaceId,item):item);
    } catch(error) {
      await store.mutate(draftId,started.revision,draft=>({...draft,status:'draft',error:`素材上传失败，尚未提交生成：${error.message}`}));
      throw error;
    }
    let receipt;
    try {
      const result=await execute(generationArgs(started,media),{timeoutMs:120000});
      receipt=z.object({taskRunId:z.uuid()}).parse(result);
    } catch(error) {
      await store.mutate(draftId,started.revision,draft=>({...draft,status:'unknown',error:`提交结果未确认：${error.message}`}));
      throw error;
    }
    let saved;
    try {
      saved=await store.mutate(draftId,started.revision,draft=>({...draft,status:'submitted',taskRunId:receipt.taskRunId}));
    } catch(error) {
      throw new Error(`任务已提交，编号 ${receipt.taskRunId}；保存回执失败，不能重新提交：${error.message}`);
    }
    return view(saved);
  }
  return {prepare,read,update,addReference,submit,store};
}
