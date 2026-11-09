import { drawWorld, projection, hitCell } from './world.js';
const $=id=>document.getElementById(id);
const canvas=$('world-canvas');
let state=null,requesting=false,grid=false,trail=true,selected=null,seenTick=null,toastTimer,fetchSequence=0;
const actionNames={move:'走动',explore:'探索',rest:'休息',eat:'进食'};
const actionIcons={move:'↝',explore:'✧',rest:'☾',eat:'♧'};
function toast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),3500);}
function text(id,value){$(id).textContent=value;}
function renderEvents(events){
  const list=$('event-list');list.replaceChildren();text('event-count',events.length);
  if(!events.length){const empty=document.createElement('p');empty.className='empty-state';empty.textContent='还没有脚印。第一段故事，等小鹿自己开始。';list.append(empty);return;}
  for(const e of [...events].reverse()){
    const row=document.createElement('div');row.className='event-row';
    const tick=document.createElement('span');tick.className='event-tick';tick.textContent=String(e.tick).padStart(2,'0');
    const icon=document.createElement('span');icon.className='event-icon';icon.textContent=actionIcons[e.action.type]||'·';
    const outcome=document.createElement('div');outcome.className='event-outcome';outcome.textContent=e.outcome;
    if(e.cognition?.source==='fallback'){const error=document.createElement('small');error.textContent='模型未完成这一步，已由规则接管';error.title=e.cognition.error||'';outcome.append(error);}
    const source=document.createElement('span');source.className='event-source '+(e.cognition?.source||'');
    source.textContent=e.cognition?.source==='ollama'?'本地模型':e.cognition?.source==='fallback'?'规则接管':e.cognition?.source==='rule'?'规则行动':'历史记录';
    source.title=e.cognition?.latencyMs?`本次推理 ${(e.cognition.latencyMs/1000).toFixed(1)} 秒`:'';
    row.append(tick,icon,outcome,source);list.append(row);
  }
}
function render(next){
  if(seenTick!==null&&next.world.tick<seenTick)return;
  const changed=seenTick!==next.world.tick;state=next;
  const {world,simulation,learning}=state,a=world.agent,last=state.events.at(-1),busy=simulation.busy;
  text('tick',world.tick);text('map-size',`${world.width} × ${world.height} 小世界`);text('deer-name',a.name);
  const name=$('profile-name');name.firstChild.textContent=a.name+' ';
  for(const key of ['hunger','energy','curiosity']){$(key+'-value').replaceChildren(document.createTextNode(a[key]),Object.assign(document.createElement('small'),{textContent:'/100'}));$(key+'-bar').style.width=a[key]+'%';}
  text('food-value',a.food);text('visited',`到访 ${Object.keys(world.visits).length} 处`);text('position',`位置 (${a.x}, ${a.y})`);
  text('save-status',`第 ${world.tick} 步已保存`);text('model-name',`本地模型 · ${simulation.model}`);
  text('mood',a.energy<=state.thresholds.tiredAt?'☾ 有一点累了':a.hunger>=state.thresholds.hungryAt?'♧ 肚子有点饿':'❧ 正在熟悉森林');
  const pos=projection(world).point(a.x,a.y),deer=$('deer');if(seenTick===null)deer.style.transition='none';deer.classList.add('visible');deer.style.left=pos.x/9+'%';deer.style.top=pos.y/6.2+'%';if(seenTick===null)requestAnimationFrame(()=>requestAnimationFrame(()=>deer.style.transition=''));
  deer.classList.toggle('resting',last?.action.type==='rest');
  if(changed){
    deer.classList.remove('moving','exploring');
    if(last?.action.type==='move'){deer.classList.toggle('facing-right',last.action.dx>0);if(seenTick!==null){void deer.offsetWidth;deer.classList.add('moving');}}
    if(last?.action.type==='explore'){void deer.offsetWidth;deer.classList.add('exploring');}
    renderEvents(state.events);
  }
  const current=$('deer-bubble');current.textContent=busy?'正在想下一步…':last?.action.type==='explore'?(last.experience?.after.food>last.experience?.before.food?'找到食物啦':'这次没有找到食物'):last?.action.type==='rest'?'休息一下':last?.action.type==='eat'?'补充一点能量':'正在认识小世界';
  text('scene-status',busy?'小鹿正在思考':simulation.running?'小鹿正在生活':'世界已暂停');$('scene-indicator').classList.toggle('live',busy||simulation.running);
  text('control-icon',busy?'◌':simulation.running?'❧':'☾');document.body.classList.toggle('status-thinking',busy);
  text('control-title',busy?'小鹿在想下一步…':simulation.running?'让它自由生活一会儿':'世界慢下来啦');
  text('control-subtitle',busy?'本地模型正在思考，通常需要十几秒':simulation.running?'每次行动后，都会记下真实经历':'点击开始，或陪它走一个小小的步骤');
  $('run-button').replaceChildren(Object.assign(document.createElement('span'),{textContent:simulation.running||busy?'Ⅱ':'▶'}),document.createTextNode(simulation.running||busy?'暂停生活':'开始生活'));
  $('step-button').disabled=busy||simulation.running||requesting;$('run-button').disabled=requesting;
  $('error-message').classList.toggle('hidden',!simulation.error);text('error-message',simulation.error||'');
  if(learning.goal){text('goal-text',`去 (${learning.goal.x}, ${learning.goal.y}) 看一看`);text('goal-detail',`第 ${learning.goal.selectedAt} 步自己选的目标 · 到达并探索后完成`);}
  else{text('goal-text','还没选好下一站');text('goal-detail',last?.learning?.goalEnd==='explored'?'上一站已经探索完，等待新的选择':'先看看四周，再决定去哪里');}
  text('memory-count',learning.facts.length);text('attempt-count',learning.facts.reduce((n,f)=>n+f.attempts,0));text('food-collected',learning.facts.reduce((n,f)=>n+f.foodCollected,0));
  text('memory-note',learning.immediateReversals?`最近六步里，有 ${learning.immediateReversals} 次原路折返。`:'当前回想中的探索经历，最多展示六处。');
  drawWorld(canvas,state,{grid,trail,selected});seenTick=world.tick;
}
async function refresh(){
  const sequence=++fetchSequence;
  try{const response=await fetch('/api/state',{cache:'no-store'});if(!response.ok)throw new Error('读取世界失败');const next=await response.json();if(sequence===fetchSequence)render(next);}
  catch(error){if(sequence!==fetchSequence)return;text('save-status','连接暂时断开');text('scene-status','等待重新连接');$('step-button').disabled=true;$('run-button').disabled=true;}
}
async function control(action){
  if(requesting)return;requesting=true;fetchSequence++;$('step-button').disabled=true;$('run-button').disabled=true;
  try{
    const response=await fetch('/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});
    const data=await response.json();if(!response.ok)throw new Error(data.error||'操作未完成');render(data);
  }catch(error){toast(error.message);}
  finally{requesting=false;await refresh();}
}
$('step-button').addEventListener('click',()=>control('step'));
$('run-button').addEventListener('click',()=>{if(state)control(state.simulation.running||state.simulation.busy?'pause':'run');});
for(const [id,kind] of [['grid-toggle','grid'],['trail-toggle','trail']])$(id).addEventListener('click',()=>{if(kind==='grid')grid=!grid;else trail=!trail;const active=kind==='grid'?grid:trail;$(id).classList.toggle('active',active);$(id).setAttribute('aria-pressed',active);if(state)drawWorld(canvas,state,{grid,trail,selected});});
canvas.addEventListener('click',e=>{
  if(!state)return;const rect=canvas.getBoundingClientRect();selected=hitCell(state.world,e.clientX,e.clientY,rect);const tip=$('place-tooltip');tip.classList.toggle('hidden',!selected);
  if(selected){const place=state.world.places.find(p=>p.x===selected.x&&p.y===selected.y);tip.replaceChildren(Object.assign(document.createElement('strong'),{textContent:place?.name||'柔软的草地'}),document.createTextNode(`(${selected.x}, ${selected.y}) · 食物 ${place?.food||0} 份`),document.createElement('br'),document.createTextNode(`小鹿到访 ${state.world.visits[`${selected.x},${selected.y}`]||0} 次`));tip.style.left=Math.min(72,Math.max(3,(e.clientX-rect.left)/rect.width*100))+'%';tip.style.top=Math.min(75,Math.max(7,(e.clientY-rect.top)/rect.height*100-15))+'%';}
  drawWorld(canvas,state,{grid,trail,selected});
});
window.addEventListener('resize',()=>{if(state)drawWorld(canvas,state,{grid,trail,selected});});
await refresh();
// Serialize refreshes so a slow response can never overwrite a newer state.
async function poll(){await refresh();setTimeout(poll,900);}setTimeout(poll,900);
