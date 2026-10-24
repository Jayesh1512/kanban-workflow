import {interpolate,useCurrentFrame} from 'remotion';
import {C,Frame,Headline,Label,Tag,clamped} from './design';
export const Clarity=()=>{
 const f=useCurrentFrame();return <Frame dark step="03 / SEE WHAT MATTERS">
  <div style={{position:'absolute',left:100,top:230,width:800}}><Headline>Know who.<br/><span style={{color:C.lime}}>Know what’s next.</span></Headline>
  <div style={{marginTop:45,fontSize:34,color:'#bbcec0',lineHeight:1.55}}>The company. Your next action.<br/>Contacts, tasks and deadlines.<br/>Together, in one card.</div>
  <div style={{display:'flex',gap:14,marginTop:44}}><Tag dark>Clear ownership</Tag><Tag dark>Sourced context</Tag></div></div>
  <div style={{position:'absolute',left:990,top:170,width:825,height:750,background:C.paper,borderRadius:27,padding:38,color:C.ink,boxShadow:'0 30px 100px #0003',translate:`0 ${interpolate(f,[0,25],[50,0],clamped)}px`}}>
   <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}><Label>Company → next action</Label><Tag>Buyer</Tag></div>
   <div style={{fontSize:43,fontWeight:600,letterSpacing:-1.3,marginTop:13,paddingBottom:27,borderBottom:`1px solid ${C.line}`}}>Cedar Labs — Send pricing</div>
   <div style={{paddingTop:26,opacity:interpolate(f,[18,36],[0,1],clamped)}}><Label>Contacts</Label><div style={{display:'flex',gap:18}}><div style={{width:45,height:45,borderRadius:99,background:'#dbe9c6',display:'grid',placeItems:'center',fontSize:20}}>MK</div><div style={{fontSize:25}}>Mira Kapoor <span style={{color:C.muted,fontSize:21}}>· CTO</span><div style={{fontSize:19,color:C.muted,marginTop:5}}>Jo Patel · Engineering lead</div></div></div></div>
   <div style={{marginTop:26,padding:24,borderRadius:16,background:'#e5edd7',opacity:interpolate(f,[40,58],[0,1],clamped)}}><Label>Tasks for AntSeed</Label><div style={{display:'flex',justifyContent:'space-between',fontSize:27,fontWeight:600}}><span>Send pricing + integration notes</span><span style={{fontSize:22}}>26 OCT</span></div><div style={{fontSize:20,marginTop:11,color:C.muted}}>Owner: AntSeed · Open · Date only (IST)</div></div>
   <div style={{paddingTop:26,opacity:interpolate(f,[68,86],[0,1],clamped)}}><Label>Waiting on the other party</Label><div style={{fontSize:25}}>Jo to review the integration notes</div><div style={{fontSize:20,marginTop:9,color:C.muted}}>27 Oct · External commitment</div></div>
   <div style={{marginTop:25,borderTop:`1px solid ${C.line}`,paddingTop:22,display:'flex',justifyContent:'space-between',fontSize:19,color:C.muted,opacity:interpolate(f,[90,108],[0,1],clamped)}}><span>Sources: 3 linked messages</span><span>No invented deadlines</span></div>
  </div>
 </Frame>;
};
