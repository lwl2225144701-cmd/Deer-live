const W = 900, H = 620;
export function projection(world) {
  const sx = Math.min(60, 650 / (world.width + world.height));
  const sy = sx * .52;
  const startX = 450 + (world.height - world.width) * sx / 2;
  const startY = 305 - (world.width + world.height - 2) * sy / 2;
  return { sx, sy, point: (x, y) => ({ x: startX + (x - y) * sx, y: startY + (x + y) * sy }) };
}
function ellipse(c,x,y,rx,ry,color) { c.fillStyle=color;c.beginPath();c.ellipse(x,y,rx,ry,0,0,Math.PI*2);c.fill(); }
function line(c,pts,color,width=2) { c.strokeStyle=color;c.lineWidth=width;c.lineJoin='round';c.lineCap='round';c.beginPath();pts.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.stroke(); }
function poly(c,pts,color) { c.fillStyle=color;c.beginPath();pts.forEach(([x,y],i)=>i?c.lineTo(x,y):c.moveTo(x,y));c.closePath();c.fill(); }
function tree(c,x,y,s=1,shade=0) {
  c.save();c.translate(x,y);c.scale(s,s);
  ellipse(c,0,3,30,10,'#71844b15');
  poly(c,[[-5,-5],[-4,-54],[4,-54],[7,-5]],'#9a9d6e');
  line(c,[[0,-20],[-13,-41]],'#9a9d6e',4);
  ellipse(c,-17,-49,23,25,shade?'#9baa78':'#a6b77c');
  ellipse(c,16,-53,25,28,shade?'#a5b680':'#b3c58b');
  ellipse(c,-2,-73,26,30,shade?'#b0c08a':'#bfd095');
  ellipse(c,-10,-78,17,20,'#cad9a44a');
  c.restore();
}
function pine(c,x,y,s=1) {
  c.save();c.translate(x,y);c.scale(s,s);ellipse(c,0,0,22,7,'#82925b14');
  poly(c,[[-3,0],[-3,-49],[4,-49],[5,0]],'#ada67b');
  poly(c,[[-25,-14],[0,-66],[25,-14]],'#a5b989');
  poly(c,[[-22,-30],[0,-77],[21,-30]],'#b1c59a');
  poly(c,[[-16,-47],[0,-84],[16,-47]],'#bfd0ab');c.restore();
}
function grass(c,x,y,color='#94ae62',s=1) {
  line(c,[[x-4*s,y],[x-6*s,y-5*s]],color,.9);
  line(c,[[x,y],[x,y-7*s]],color,.9);
  line(c,[[x+3*s,y],[x+6*s,y-4*s]],color,.9);
}
function flowers(c,x,y,s=1) {
  line(c,[[x,y],[x-1,y-12*s]],'#98b273',1.1);
  for(let i=0;i<5;i++){const a=i*Math.PI*.4;ellipse(c,x-1+Math.cos(a)*3*s,y-12*s+Math.sin(a)*3*s,2.2*s,2.2*s,'#fff9db');}
  ellipse(c,x-1,y-12*s,1.7*s,1.7*s,'#d9be76');
}
function cabin(c,x,y) {
  ellipse(c,x,y+4,40,13,'#708a4020');
  poly(c,[[x-28,y-2],[x-28,y-38],[x,y-24],[x,y+12]],'#d7bf89');
  poly(c,[[x,y+12],[x,y-24],[x+30,y-40],[x+30,y-4]],'#e7d5a1');
  poly(c,[[x-37,y-37],[x-8,y-70],[x+36,y-45],[x+2,y-18]],'#a19a70');
  poly(c,[[x-37,y-37],[x-8,y-70],[x+1,y-66],[x-29,y-32]],'#c1b283');
  poly(c,[[x+1,y-18],[x+36,y-45],[x+44,y-41],[x+5,y-10]],'#817e59');
  poly(c,[[x+11,y+5],[x+11,y-14],[x+22,y-20],[x+22,y]],'#a69d73');
  poly(c,[[x-20,y-15],[x-20,y-29],[x-9,y-23],[x-9,y-10]],'#f9e9a8');
  line(c,[[x-15,y-27],[x-15,y-12]],'#bdab79',1);line(c,[[x-20,y-22],[x-9,y-17]],'#bdab79',1);
  ellipse(c,x+27,y+7,7,4,'#afb976');grass(c,x-29,y+8,'#a7b478',1.2);
}
function bush(c,x,y,food) {
  ellipse(c,x,y+4,36,11,'#748d441a');
  ellipse(c,x-17,y-7,20,16,'#91a763');ellipse(c,x+18,y-9,21,18,'#9eb873');ellipse(c,x,y-18,22,21,'#afc983');
  for(let i=0;i<food*3;i++){const a=i*2.3;ellipse(c,x+Math.sin(a)*23,y-13+Math.cos(a)*9,3.2,3.2,'#b77e77');ellipse(c,x+Math.sin(a)*23-.7,y-14+Math.cos(a)*9,1,1,'#e2b4a1');}
}
function apple(c,x,y,food) {
  tree(c,x,y,1.05);
  for(let i=0;i<food*3;i++){const a=i*2.4;ellipse(c,x+Math.cos(a)*21,y-57+Math.sin(a)*19,4,4.5,'#cb937b');ellipse(c,x+Math.cos(a)*21-1,y-59+Math.sin(a)*19,1.1,1.1,'#edc7a0');}
}
function pond(c,x,y) {
  ellipse(c,x,y,49,23,'#bed1a0');ellipse(c,x,y-2,42,18,'#a3c5ba');ellipse(c,x-2,y-4,35,13,'#b7d8ca');
  line(c,[[x-24,y-3],[x-6,y-3]],'#d5ead3',1.6);line(c,[[x+5,y+3],[x+22,y+3]],'#d9e9d5',1.6);
  ellipse(c,x+17,y-8,7,3.5,'#9ab98d');ellipse(c,x+21,y-9,2,2,'#eacfc0');
  for(const [dx,dy,s] of [[-39,2,1.2],[35,11,1],[-23,19,1]])grass(c,x+dx,y+dy,'#8fa36d',s);
  ellipse(c,x-37,y+12,7,4,'#c2c8a7');ellipse(c,x+40,y-8,6,4,'#cbd0b1');
}
function label(c,text,x,y) {
  c.font='11px "PingFang SC",system-ui,sans-serif';const w=c.measureText(text).width+20;
  c.fillStyle='#ffffffe0';c.beginPath();c.roundRect(x-w/2,y-10,w,21,9);c.fill();
  c.fillStyle='#839265';c.textAlign='center';c.fillText(text,x,y+4);
}
export function drawWorld(canvas,state,{grid=true,trail=true,selected=null}={}) {
  const dpr=Math.min(devicePixelRatio||1,2);
  if(canvas.width!==W*dpr){canvas.width=W*dpr;canvas.height=H*dpr;}
  const c=canvas.getContext('2d');c.setTransform(dpr,0,0,dpr,0,0);c.clearRect(0,0,W,H);
  const bg=c.createLinearGradient(0,0,0,H);bg.addColorStop(0,'#ecf1df');bg.addColorStop(1,'#e4edce');c.fillStyle=bg;c.fillRect(0,0,W,H);
  const sun=c.createRadialGradient(660,35,10,660,35,260);sun.addColorStop(0,'#fff9d654');sun.addColorStop(1,'#fff9d600');c.fillStyle=sun;c.fillRect(0,0,W,400);
  // Distant hills and layered tree silhouettes surround the little clearing.
  ellipse(c,145,134,230,48,'#dfe9ce');ellipse(c,660,127,320,42,'#e0e9d1');ellipse(c,415,147,250,34,'#e5edda');
  for(let i=0;i<11;i++) {const x=30+i*87;pine(c,x,149+(i%3)*8,.42+(i%3)*.1);}
  [[82,233,1.17],[155,180,.9],[766,203,1.1],[826,276,1.3],[55,339,.9],[764,397,.8],[161,437,.6],[705,497,.65]].forEach(p=>tree(c,...p));
  [[30,251,.9],[204,181,.6],[861,215,.8],[804,384,.85],[95,422,.75],[841,445,.8]].forEach(p=>pine(c,...p));
  ellipse(c,447,497,330,36,'#9faf6d0e');
  const world=state.world;const {sx,sy,point}=projection(world);
  const border=[point(-.5,-.5),point(world.width-.5,-.5),point(world.width-.5,world.height-.5),point(-.5,world.height-.5)];
  const pts=border.map(p=>[p.x,p.y]);
  ellipse(c,450,point(world.width-1,world.height-1).y+13,170,16,'#87994d0c');
  poly(c,[pts[3],pts[2],pts[1],[pts[1][0],pts[1][1]+14],[pts[2][0],pts[2][1]+14],[pts[3][0],pts[3][1]+14]],'#bbc994');
  poly(c,pts,'#cbdba6');
  const colors=['#d2dfa8','#d8e4b0','#d5e2ac','#dbe6b5','#d0dda6','#d9e4af'];
  for(let y=0;y<world.height;y++)for(let x=0;x<world.width;x++) {
    const p=point(x,y);const d=[[p.x,p.y-sy],[p.x+sx,p.y],[p.x,p.y+sy],[p.x-sx,p.y]];
    poly(c,d,colors[(x*7+y*3)%colors.length]);
    if(grid){c.strokeStyle='#afc08970';c.lineWidth=.8;c.beginPath();d.forEach(([dx,dy],i)=>i?c.lineTo(dx,dy):c.moveTo(dx,dy));c.closePath();c.stroke();}
    for(let j=0;j<3;j++){const ox=Math.sin(x*11+y*7+j*9)*sx*.5,oy=Math.cos(x*7+y*13+j*4)*sy*.32;grass(c,p.x+ox,p.y+oy,'#aabc7d',.65);}
    if((x+y*3)%4===1)flowers(c,p.x+sx*.25,p.y+sy*.2,.65);
  }
  if(trail){
    const moves=state.events.filter(e=>e.action.type==='move'&&e.experience).slice(-6);
    moves.forEach((e,i)=>{const a=point(e.experience.before.x,e.experience.before.y),b=point(e.experience.after.x,e.experience.after.y);c.globalAlpha=(i+1)/moves.length*.45;c.setLineDash([2,8]);line(c,[[a.x,a.y],[b.x,b.y]],'#8d9d60',2);c.setLineDash([]);});c.globalAlpha=1;
  }
  const goal=state.learning.goal;
  if(goal){const p=point(goal.x,goal.y);c.setLineDash([5,4]);c.strokeStyle='#baac71';c.lineWidth=1.5;c.beginPath();c.ellipse(p.x,p.y,sx*.7,sy*.7,0,0,Math.PI*2);c.stroke();c.setLineDash([]);}
  if(selected){const p=point(selected.x,selected.y);c.strokeStyle='#9bab6e';c.lineWidth=2;line(c,[[p.x,p.y-sy],[p.x+sx,p.y],[p.x,p.y+sy],[p.x-sx,p.y],[p.x,p.y-sy]],'#9bab6e',1.4);}
  const places=[...world.places].sort((a,b)=>a.x+a.y-b.x-b.y);
  places.forEach(p=>{const xy=point(p.x,p.y);c.save();c.translate(xy.x,xy.y);c.scale(Math.min(1,sx/54),Math.min(1,sx/54));if(p.name.includes('屋'))cabin(c,0,0);else if(p.name.includes('塘')||p.name.includes('水'))pond(c,0,0);else if(p.name.includes('树'))apple(c,0,0,p.food);else bush(c,0,0,p.food);c.restore();});
  places.forEach(p=>{const xy=point(p.x,p.y);label(c,p.name,xy.x,xy.y+sy*.85+13);});
  // Loose flowers and stones at the clearing edge.
  for(let i=0;i<28;i++){const x=62+(i*137)%776,y=470+(i*19)%85; if(x>220&&x<680&&y<510)continue;flowers(c,x,y,.8);if(i%3===0)grass(c,x+12,y+7,'#a6b480',1.1);}
  [[137,364,8],[725,317,6],[730,462,10],[189,476,6],[630,531,5]].forEach(([x,y,r])=>{ellipse(c,x,y,r,r*.55,'#c7ceac');ellipse(c,x-1,y-1,r*.75,r*.3,'#d6dabe');});
}
export function hitCell(world,clientX,clientY,rect) {
  const mx=(clientX-rect.left)/rect.width*W,my=(clientY-rect.top)/rect.height*H;
  const {sx,sy,point}=projection(world);let best=null;
  for(let y=0;y<world.height;y++)for(let x=0;x<world.width;x++){const p=point(x,y);if(Math.abs(p.x-mx)/sx+Math.abs(p.y-my)/sy<=1)best={x,y};}
  return best;
}
