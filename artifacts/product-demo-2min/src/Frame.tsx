import type {ReactNode} from 'react';
import {AbsoluteFill,interpolate,staticFile,useCurrentFrame,useVideoConfig} from 'remotion';
import {Audio} from '@remotion/media';
import timeline from './timeline.json';
export const C={bg:'#0b1921',panel:'#142630',ink:'#f1f5ef',muted:'#aac0c6',lime:'#d8f48c',line:'#2c4148'};
export const Frame=({id,boundary,children}:{id:string;boundary:string;children:ReactNode})=>{
 const f=useCurrentFrame();const {fps}=useVideoConfig();const item=timeline.find(t=>t.id===id)!;const cap=item.captions.find(c=>f/fps*1000>=c.startMs&&f/fps*1000<c.endMs);
 return <AbsoluteFill style={{background:C.bg,color:C.ink,fontFamily:'DM Sans, sans-serif'}}>
 <Audio src={staticFile(id+'.wav')} premountFor={fps}/>
 <div style={{position:'absolute',left:64,top:38,fontSize:25,fontWeight:600,letterSpacing:3}}>ANTSEED<span style={{color:C.muted,fontWeight:400,letterSpacing:0,marginLeft:20}}>/ Relationship workspace</span></div>
 <div style={{position:'absolute',right:64,top:40,fontSize:20,color:C.lime}}>{boundary}</div>
 <div style={{position:'absolute',left:64,top:106,fontSize:46,fontWeight:600,letterSpacing:-1}}>{item.title}</div>
 <div style={{position:'absolute',inset:'190px 64px 158px',opacity:interpolate(f,[0,12],[0,1],{extrapolateRight:'clamp'})}}>{children}</div>
 <div style={{position:'absolute',left:64,right:64,bottom:46,minHeight:80,display:'flex',alignItems:'center',justifyContent:'center',textAlign:'center',fontSize:29,lineHeight:1.35,color:'#e5ece7'}}>{cap?.text}</div>
 <div style={{position:'absolute',bottom:0,left:0,height:5,background:C.lime,width:interpolate(f,[0,item.seconds*fps],[0,1920],{extrapolateRight:'clamp'})}}/>
 </AbsoluteFill>;
};
export const Pill=({children}:{children:ReactNode})=><span style={{border:'1px solid '+C.line,padding:'9px 16px',borderRadius:8,fontSize:23,color:C.lime}}>{children}</span>;
export const Note=({title,children}:{title:string;children:ReactNode})=><div style={{background:C.panel,border:'1px solid '+C.line,borderRadius:18,padding:26}}><div style={{fontSize:23,color:C.lime,marginBottom:14}}>{title}</div><div style={{fontSize:28,lineHeight:1.4}}>{children}</div></div>;
