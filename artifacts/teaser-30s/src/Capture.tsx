import {interpolate,useCurrentFrame} from 'remotion';
import {C,Frame,Headline,Plane,Tag,clamped} from './design';
export const Capture=()=>{
 const f=useCurrentFrame();return <Frame step="02 / CAPTURE THE OPPORTUNITY">
 <div style={{position:'absolute',left:100,top:185}}><Headline style={{fontSize:92}}>A first message.<br/>A clear next step.</Headline></div>
 <div style={{position:'absolute',left:100,top:490,width:720,height:330,background:C.white,border:`1px solid ${C.line}`,borderRadius:24,padding:34,boxShadow:'0 22px 60px #102e2609'}}>
  <div style={{display:'flex',gap:16,alignItems:'center',fontSize:25}}><span style={{display:'flex',padding:12,background:C.ink,color:C.lime,borderRadius:18}}><Plane/></span><b>Mira · Cedar Labs</b><span style={{marginLeft:'auto',fontSize:17,color:C.muted}}>Telegram</span></div>
  <div style={{marginTop:25,marginLeft:55,background:'#eaf1dd',padding:'23px 28px',borderRadius:'20px 20px 4px 20px',fontSize:29,lineHeight:1.4}}>Hey Mira, could AntSeed help<br/>with your integration?</div>
  <div style={{textAlign:'right',marginTop:12,color:C.muted,fontSize:18}}>Sent · 09:41 ✓✓</div>
 </div>
 <div style={{position:'absolute',left:860,top:650,width:125,height:3,background:'#a5b3a7'}}><div style={{position:'absolute',height:9,top:-3,width:interpolate(f,[32,69],[0,125],clamped),background:C.ink}}/><span style={{position:'absolute',right:-9,top:-18,fontSize:34}}>→</span></div>
 <div style={{position:'absolute',left:1050,top:445,width:760,padding:35,borderRadius:24,background:C.ink,color:C.paper,opacity:interpolate(f,[45,65],[0,1],clamped),translate:`0 ${interpolate(f,[45,75],[35,0],clamped)}px`}}>
  <div style={{fontSize:18,color:'#adc3b2',fontFamily:'monospace',letterSpacing:2,marginBottom:24}}>TO BE STARTED</div>
  <div style={{fontSize:48,fontWeight:600,letterSpacing:-1.8}}>Cedar Labs — Follow up</div>
  <div style={{marginTop:30,display:'flex',gap:16,alignItems:'center'}}><Tag>New prospect</Tag><span style={{fontSize:24,color:'#c4d2c7'}}>Contact: Mira</span></div>
  <div style={{borderTop:'1px solid #41604e',marginTop:30,paddingTop:24,fontSize:25,lineHeight:1.4}}>One conversation. One actionable card.</div>
 </div>
 <div style={{position:'absolute',left:1060,top:870,fontSize:24,color:C.muted,opacity:interpolate(f,[85,105],[0,1],clamped)}}>Company unknown? Start with the person.</div>
 </Frame>;
};
