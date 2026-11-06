import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from '../../src/storage/store.ts';
import { initialWorld, advance, choices, type Event } from '../../src/world/world.ts';
import { decisionRequest } from '../../src/agent/brain.ts';
import { loadSettings } from '../../src/config/settings.ts';

// Diagnosis only: reconstruct a past decision in memory. Never advance or write
// the user's world. No model thinking text is retained in the report.
const sourcePath = resolve(process.argv[2] || 'data/newborn.sqlite');
const sourceHash = () => createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
const beforeHash = sourceHash();
const source = new DatabaseSync(sourcePath, { readOnly: true });
const events = (source.prepare('SELECT data FROM events ORDER BY tick LIMIT 2').all() as {data:string}[]).map(r => JSON.parse(r.data) as Event);
source.close();
assert.equal(events.length, 2, '需要至少两步真实行动记录');
const { settings } = loadSettings();
const store = new Store(':memory:');
const seed = initialWorld(settings.initialWorld);
assert.deepEqual(seed.agent, events[0].experience?.before, '当前初始配置与历史不一致，无法直接重建');
let world = store.initialize(seed);
for (const recorded of events) {
  const next = advance(world, recorded.action, recorded.reason, settings.life);
  assert.deepEqual(next.event.experience, recorded.experience, '当前规则与历史身体变化不一致');
  assert.deepEqual(next.event.observation, recorded.observation, '当前地图与历史观察不一致');
  store.save(next.world, next.event); world = next.world;
}
const memories = store.recall(world, settings.memory.maxRecall, settings.life.hungryAt);
const experiences = store.experiences(settings.memory.maxExperiences);
const original = decisionRequest(world, memories, {life:settings.life,character:settings.character,experiences});
const baseline = JSON.parse(original.messages[0].content);
// Recreate the historical unconditional hint even after the production fix,
// so future diagnosis does not accidentally compare the fixed input to itself.
for (const m of baseline.memories) m.nextAction = m.x < world.agent.x ? 'west' : m.x > world.agent.x ? 'east' : m.y < world.agent.y ? 'north' : m.y > world.agent.y ? 'south' : 'explore';
const noHint = structuredClone(baseline);
for (const m of noHint.memories) if (m.foodRemaining === 0) delete m.nextAction;
const compact = {
  identity: baseline.identity,
  task: '根据以下事实选择下一步动作。仅输出符合给定schema的JSON，不要解释。',
  current: { x: world.agent.x, y: world.agent.y, hunger: world.agent.hunger, energy: world.agent.energy, curiosity: world.agent.curiosity, food: world.agent.food },
  bodyLegend: { hunger:'越高越饿',energy:'越低越累',curiosity:'越高越想探索' },
  thresholds: baseline.observation.thresholds,
  nearby: baseline.observation.nearby,
  lastExperience: {
    action: events[1].action,
    location: {x:world.agent.x,y:world.agent.y},
    outcome: events[1].outcome,
    bodyChange: baseline.experiences.find((e: {tick:number}) => e.tick===2)?.bodyChange,
  },
  memories: noHint.memories,
  choices: baseline.observation.choices,
  responseSchema: original.format,
};
const conditions = [{name:'baseline',payload:baseline},{name:'remove-empty-location-hint',payload:noHint},{name:'compact-facts',payload:compact}];
const report: any = {
  date:new Date().toISOString(), model:settings.model,
  scope:'按当前配置重建第3步状态，已核对前两步身体变化和观察，并显式复现修复前的无条件路线提示；不是当时HTTP请求的抓包。三种输入、两个种子、小样本，仅用于定位；不修改世界、不训练模型、不禁止任何合法动作。紧凑输入同时改变了指令与信息组织，不能单独归因。',
  sourcePath, sourceHash:beforeHash, world, memories, experiences,
  conditions:conditions.map(c=>({name:c.name,payload:c.payload})), results:[],
};
mkdirSync('data/diagnostics',{recursive:true});
const output=resolve('data/diagnostics',`learning-${report.date.replace(/[:.]/g,'-')}.json`);
function save() { writeFileSync(output,JSON.stringify(report,null,2)); }
try {
  for (const sampleSeed of [42,43]) {
    for (const condition of conditions) {
      const started=performance.now();
      try {
        const response=await fetch('http://127.0.0.1:11434/api/chat',{
          method:'POST',headers:{'Content-Type':'application/json'}, signal:AbortSignal.timeout(settings.model.timeoutMs),
          body:JSON.stringify({
            model:settings.model.name,messages:[{role:'user',content:JSON.stringify(condition.payload)}],format:original.format,
            stream:false,...(settings.model.name.startsWith('deepseek-r1')?{}:{think:false}),keep_alive:'5m',
            options:{temperature:settings.model.temperature,top_p:settings.model.topP,num_predict:settings.model.numPredict,num_ctx:settings.model.numCtx,seed:sampleSeed},
          }),
        });
        const body=await response.json() as any;
        if(!response.ok)throw new Error(`Ollama HTTP ${response.status}`);
        let parsed: any;
        try {parsed=JSON.parse(body.message?.content||'');}catch{}
        const valid=body.done===true && body.done_reason!=='length' && parsed && Object.keys(parsed).length===1 && choices(world,settings.life).some(c=>c.id===parsed.choice);
        const result={condition:condition.name,seed:sampleSeed,valid:Boolean(valid),choice:valid?parsed.choice:null,repeatedEmptyExplore:valid?parsed.choice==='explore':null,finalOutput:body.message?.content,finishReason:body.done_reason,promptTokens:body.prompt_eval_count,generatedTokens:body.eval_count,latencyMs:Math.round(performance.now()-started)};
        report.results.push(result); console.log(JSON.stringify(result));
      }catch(error){
        const result={condition:condition.name,seed:sampleSeed,valid:false,error:error instanceof Error?error.message:String(error),latencyMs:Math.round(performance.now()-started)};
        report.results.push(result);console.log(JSON.stringify(result));
      }
      save();
    }
  }
  report.sourceUnchanged=sourceHash()===beforeHash;
  report.summary=conditions.map(c=>{const rows=report.results.filter((r:any)=>r.condition===c.name);return{condition:c.name,valid:rows.filter((r:any)=>r.valid).length,repeatedEmptyExplore:rows.filter((r:any)=>r.repeatedEmptyExplore===true).length,choices:rows.map((r:any)=>r.choice||r.error||r.finishReason)};});
  save();console.log(JSON.stringify({summary:report.summary,sourceUnchanged:report.sourceUnchanged,output}));
}finally{store.close();}
