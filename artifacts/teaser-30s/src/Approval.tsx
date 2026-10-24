import {interpolate,useCurrentFrame} from 'remotion';
import {C,Frame,Headline,Tag,clamped} from './design';
export const Approval=()=>{
 const f=useCurrentFrame();return <Frame step="04 / YOU CONTROL THE MOVE">
  <div style={{position:'absolute',left:100,top:170}}><Headline style={{fontSize:96}}>AI suggests.<br/>You decide.</Headline></div>
  <div style={{position:'absolute',left:100,top:435,width:670,height:440,background:C.white,border:`1px solid ${C.line}`,borderRadius:26,padding:32}}>
   <div style={{display:'flex',alignItems:'center',gap:17,fontSize:26,fontWeight:600}}><div style={{width:45,height:45,borderRadius:15,background:C.ink,color:C.lime,display:'grid',placeItems:'center'}}>✓</div>KanbanControl <span style={{marginLeft:'auto',fontSize:18,fontWeight:400,color:C.muted}}>Telegram</span></div>
   <div style={{marginTop:23,padding:25,borderRadius:16,background:'#eef1e8',fontSize:25,lineHeight:1.45}}><b>Cedar Labs</b><br/>Engineering has started testing.<br/><span style={{color:C.muted,fontSize:22}}>Work in progress → Integrations</span></div>
   <div style={{marginTop:20,marginLeft:'auto',width:220,padding:'17px 22px',background:C.ink,color:C.lime,borderRadius:'16px 16px 3px 16px',fontSize:27,opacity:interpolate(f,[64,80],[0,1],clamped)}}>approve <span style={{fontSize:17,opacity:.65,float:'right'}}>✓✓</span></div>
  </div>
  <div style={{position:'absolute',left:880,top:400,display:'flex',gap:22}}>
   <div style={{width:440,height:470,border:'1px solid #d6dfd0',background:'#e8ecdf',borderRadius:21,padding:25}}><div style={{fontSize:25,fontWeight:600}}>Work in progress</div><div style={{marginTop:20,height:2,background:'#c9d3c2'}}/></div>
   <div style={{width:440,height:470,border:'1px solid #c8d5bd',background:'#e2ebd4',borderRadius:21,padding:25}}><div style={{fontSize:25,fontWeight:600}}>Integrations</div><div style={{marginTop:20,height:2,background:'#c0cfb3'}}/></div>
  </div>
  <div style={{position:'absolute',left:905+interpolate(f,[105,137],[0,462],clamped),top:505+interpolate(f,[105,121,137],[0,-35,0],clamped),width:390,padding:26,borderRadius:18,background:C.white,boxShadow:'0 18px 35px #102e2614',border:`1px solid ${C.line}`}}><Tag>Buyer</Tag><div style={{fontSize:31,fontWeight:600,letterSpacing:-.8,marginTop:20}}>Cedar Labs —<br/>Support integration</div><div style={{marginTop:22,color:C.muted,fontSize:21}}>Mira · Jo · AntSeed</div></div>
  <div style={{position:'absolute',left:1372,top:798,fontSize:23,fontWeight:600,color:C.ink,opacity:interpolate(f,[139,154],[0,1],clamped)}}>✓ Approved & updated</div>
  <div style={{position:'absolute',left:890,top:910,fontSize:25,color:C.muted}}>No lane change until you approve.</div>
 </Frame>;
};
