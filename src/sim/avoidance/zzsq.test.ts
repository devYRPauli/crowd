// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { computeNewVelocityRef } from './zzref.mjs'
import { buildObstacles, computeNewVelocity } from './orca'
const square = buildObstacles([[{x:-1,y:-1},{x:1,y:-1},{x:1,y:1},{x:-1,y:1}]])
const refObs = (() => { const n = square.map((o)=>({point:[o.point.x,o.point.y],unitDir:[o.direction.x,o.direction.y],isConvex:o.convex,next:null,prev:null}));
  square.forEach((o,i)=>{n[i].next=n[o.nextIndex];n[i].prev=n[o.prevIndex]}); return n })()
const nearest=(x,y)=>square.map((o,i)=>({i,d:(o.point.x-x)**2+(o.point.y-y)**2})).sort((p,q)=>p.d-q.d||p.i-q.i).map(e=>e.i)
const sim=(useRef)=>{ let worstCentre=-Infinity, worstDisc=-Infinity
  for(let k=0;k<64;k++){ const ang=(k/64)*Math.PI*2
    let pos={x:Math.cos(ang)*4,y:Math.sin(ang)*4}, vel={x:0,y:0}
    const r=0.35, ms=1.5
    for(let s=0;s<300;s++){ const gx=-Math.cos(ang)*4, gy=-Math.sin(ang)*4
      const dx=gx-pos.x, dy=gy-pos.y, d=Math.hypot(dx,dy)
      const pref= d>1e-9?{x:dx/d*ms,y:dy/d*ms}:{x:0,y:0}
      const a={position:pos,velocity:vel,radius:r,maxSpeed:ms,prefVelocity:pref,timeHorizon:5,timeHorizonObst:2,responsibility:0.5}
      const ord=nearest(pos.x,pos.y)
      let v
      if(useRef){ const rr=computeNewVelocityRef({position:[pos.x,pos.y],velocity:[vel.x,vel.y],radius:r,maxSpeed:ms,prefVelocity:[pref.x,pref.y],timeHorizon:5,timeHorizonObst:2},[],ord.map(i=>refObs[i]),1/60); v={x:rr.velocity[0],y:rr.velocity[1]} }
      else v=computeNewVelocity(a,[],square,ord)
      vel=v; pos={x:pos.x+v.x*0.05,y:pos.y+v.y*0.05}
      const ox=Math.max(Math.abs(pos.x)-1,0), oy=Math.max(Math.abs(pos.y)-1,0)
      const outside=Math.hypot(ox,oy)
      const centreDepth = outside>0? -outside : Math.min(1-Math.abs(pos.x),1-Math.abs(pos.y))
      if(centreDepth>worstCentre) worstCentre=centreDepth
      if(r-outside>worstDisc) worstDisc=r-outside
    } }
  return {worstCentre,worstDisc} }
describe('p',()=>{it('x',()=>{ console.log('PORT',JSON.stringify(sim(false))); console.log('REF ',JSON.stringify(sim(true))); expect(true).toBe(true) })})
