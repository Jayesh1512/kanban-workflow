import {useCurrentFrame,interpolate} from 'remotion';
import {C,Frame,Headline,clamped} from './design';
export const Hook=()=>{
 const f=useCurrentFrame();
 return <Frame dark step="01 / FROM THE CONVERSATION">
  <div style={{position:'absolute',left:100,top:260,width:850}}><Headline>Your pipeline.<br/><span style={{color:C.lime}}>Buried in chats.</span></Headline><div style={{marginTop:42,fontSize:34,color:'#b6c9be',lineHeight:1.45}}>The next step shouldn’t<br/>get lost in the scroll.</div></div>
  <div style={{position:'absolute',left:1110,top:245,width:650,height:590}}>
   <div style={{position:'absolute',left:15,top:15,rotate:'-5deg',width:510,padding:31,border:'1px solid #446353',borderRadius:23,background:'#234337',fontSize:29,opacity:interpolate(f,[6,22],[0,1],clamped),translate:`0 ${interpolate(f,[6,30],[50,0],clamped)}px`}}>“Could you send pricing?”<div style={{marginTop:17,fontSize:17,color:'#a8c0b1'}}>Cedar Labs · 09:41</div></div>
   <div style={{position:'absolute',left:70,top:195,rotate:'5deg',width:510,padding:31,border:'1px solid #446353',borderRadius:23,background:'#1a392e',fontSize:29,opacity:interpolate(f,[22,39],[0,1],clamped),translate:`0 ${interpolate(f,[22,48],[50,0],clamped)}px`}}>“Engineering is testing it.”<div style={{marginTop:17,fontSize:17,color:'#a8c0b1'}}>Northstar · 11:07</div></div>
   <div style={{position:'absolute',left:0,top:385,rotate:'-3deg',width:510,padding:31,borderRadius:23,background:C.lime,color:C.ink,fontSize:29,opacity:interpolate(f,[40,56],[0,1],clamped),translate:`0 ${interpolate(f,[40,66],[50,0],clamped)}px`}}>“Who do I follow up with?”<div style={{marginTop:17,fontSize:17,opacity:.65}}>You · just now</div></div>
  </div>
 </Frame>;
};
