import {interpolate,useCurrentFrame} from 'remotion';
import {C,Frame,Headline,Leaf,clamped} from './design';
export const Closing=()=>{
 const f=useCurrentFrame();return <Frame dark step="05 / KEEP THE WORK MOVING">
  <div style={{position:'absolute',inset:0,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',paddingTop:30}}>
   <div style={{display:'flex',gap:17,alignItems:'center',fontSize:33,marginBottom:40}}><Leaf size={51}/><b>AntSeed Kanban</b></div>
   <Headline style={{textAlign:'center',fontSize:120}}>Less chasing.<br/><span style={{color:C.lime}}>More progress.</span></Headline>
   <div style={{display:'flex',alignItems:'center',gap:27,fontSize:29,marginTop:50,color:'#bacebd',opacity:interpolate(f,[25,45],[0,1],clamped)}}><span>Telegram</span><span style={{color:C.lime}}>→</span><span>AI insight</span><span style={{color:C.lime}}>→</span><span>Your approval</span><span style={{color:C.lime}}>→</span><span>Vikunja</span></div>
   <div style={{fontSize:28,color:C.ink,background:C.lime,padding:'20px 34px',borderRadius:99,marginTop:45,fontWeight:600,opacity:interpolate(f,[45,65],[0,1],clamped)}}>Keep the conversation. Move the work.</div>
  </div>
 </Frame>;
};
