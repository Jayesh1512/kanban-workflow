import React from 'react';
import {AbsoluteFill, Easing, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {loadFont} from '@remotion/fonts';
loadFont({family:'DM Sans',url:staticFile('dm-sans-400.woff2'),weight:'400'});
loadFont({family:'DM Sans',url:staticFile('dm-sans-600.woff2'),weight:'600'});
export const C={ink:'#102e26',paper:'#f5f3ec',lime:'#c8fa79',muted:'#648077',line:'#dbe2d7',white:'#fffef9'};
export const clamped={extrapolateLeft:'clamp',extrapolateRight:'clamp',easing:Easing.bezier(.16,1,.3,1)} as const;
export const Leaf=({size=42,color=C.lime}:{size?:number;color?:string})=><svg width={size} height={size} viewBox="0 0 48 48"><path d="M8 35C7 13 17 6 39 8c1 22-7 32-26 30L32 16 8 35Z" fill={color}/></svg>;
export const Frame=({children,dark=false,step}:{children:React.ReactNode;dark?:boolean;step:string})=>{
 const f=useCurrentFrame(),{durationInFrames}=useVideoConfig();
 return <AbsoluteFill style={{background:dark?C.ink:C.paper,color:dark?C.paper:C.ink,fontFamily:'DM Sans, sans-serif',overflow:'hidden'}}>
  <AbsoluteFill style={{backgroundImage:`radial-gradient(${dark?'#aecabb17':'#102e2614'} 1px,transparent 1px)`,backgroundSize:'32px 32px',opacity:.7}}/>
  <div style={{position:'absolute',left:96,right:96,top:62,display:'flex',alignItems:'center',justifyContent:'space-between',fontSize:30,letterSpacing:-.7}}><div style={{display:'flex',alignItems:'center',gap:13}}><Leaf color={dark?C.lime:C.ink}/><b>antseed</b><span style={{opacity:.4,marginLeft:12}}>/</span><span style={{opacity:.65,marginLeft:12}}>kanban</span></div><span style={{fontFamily:'monospace',fontSize:19,letterSpacing:2,opacity:.6}}>{step}</span></div>
  <AbsoluteFill style={{opacity:interpolate(f,[0,10,durationInFrames-9,durationInFrames-1],[0,1,1,0],clamped)}}>{children}</AbsoluteFill>
  <div style={{position:'absolute',left:100,bottom:48,fontFamily:'monospace',fontSize:16,letterSpacing:2,opacity:.5}}>ILLUSTRATIVE PRODUCT FLOW · SYNTHETIC DATA</div>
  <div style={{position:'absolute',right:100,bottom:48,fontFamily:'monospace',fontSize:17,opacity:.5}}>TELEGRAM → KANBAN</div>
 </AbsoluteFill>;
};
export const Tag=({children,dark=false}:{children:React.ReactNode;dark?:boolean})=><span style={{display:'inline-flex',padding:'10px 17px',borderRadius:99,background:dark?'#28483a':C.lime,color:dark?C.lime:C.ink,fontSize:20,fontWeight:600,letterSpacing:.2}}>{children}</span>;
export const Label=({children}:{children:React.ReactNode})=><div style={{fontSize:16,fontFamily:'monospace',textTransform:'uppercase',letterSpacing:2,color:C.muted,marginBottom:13}}>{children}</div>;
export const Headline=({children,style}:{children:React.ReactNode;style?:React.CSSProperties})=>{
 const f=useCurrentFrame();return <div style={{fontSize:104,lineHeight:1.03,letterSpacing:-5,fontWeight:600,translate:`0 ${interpolate(f,[0,24],[36,0],clamped)}px`,...style}}>{children}</div>;
};
export const Plane=()=> <svg width="34" height="34" viewBox="0 0 32 32" fill="none"><path d="m4 14 24-9-6 23-8-8-10-6Z" fill="currentColor"/><path d="m14 20 8-9" stroke={C.ink} strokeWidth="2"/></svg>;
