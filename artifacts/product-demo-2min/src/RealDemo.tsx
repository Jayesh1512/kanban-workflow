import {AbsoluteFill,Composition,Series,staticFile,useCurrentFrame,useVideoConfig} from 'remotion';
import {Audio,Video} from '@remotion/media';
import data from './real-timeline.json';
const Screen=({id,file,boundary,offset=0}:{id:string;file:string;boundary:string;offset?:number})=>{const f=useCurrentFrame(),{fps}=useVideoConfig(),scene=data.find(s=>s.id===id)!;const caption=scene.captions.find(c=>f/fps*1000>=c.startMs&&f/fps*1000<c.endMs);return <AbsoluteFill style={{background:'#0b1921',fontFamily:'DM Sans,sans-serif',color:'#f1f5ef'}}>
<Video src={staticFile(file)} trimBefore={offset*fps} muted objectFit="contain" premountFor={fps} style={{position:'absolute',width:1920,height:1080}}/>
<Audio src={staticFile('real-'+id+'.wav')} premountFor={fps}/>
<div style={{position:'absolute',left:0,right:0,top:0,height:76,background:'#0b1921f5',padding:'18px 42px',display:'flex',alignItems:'center',justifyContent:'space-between'}}><div style={{fontSize:29,fontWeight:600}}>ANTSEED <span style={{fontWeight:400,color:'#c2d0d2',marginLeft:22,fontSize:25}}>{scene.title}</span></div><div style={{fontSize:18,color:'#d8f48c',textAlign:'right',maxWidth:780}}>{boundary}</div></div>
<div style={{position:'absolute',left:0,right:0,bottom:0,minHeight:126,background:'#0b1921f7',padding:'25px 65px 30px',fontSize:29,lineHeight:1.34,textAlign:'center',display:'flex',justifyContent:'center',alignItems:'center'}}>{caption?.text}</div>
<div style={{position:'absolute',bottom:0,left:0,width:(f/(scene.seconds*fps))*1920,height:4,background:'#d8f48c'}}/>
</AbsoluteFill>};
export const RealDemo=()=>{const{fps}=useVideoConfig();return <Series>
<Series.Sequence name="Real product overview" durationInFrames={6*fps} premountFor={fps}><Screen id="overview" file="real-work.mp4" boundary="LIVE VIKUNJA · READ-ONLY CAPTURE · 26 OCT IST"/></Series.Sequence>
<Series.Sequence name="Work Kanban" durationInFrames={16*fps} premountFor={fps}><Screen id="board" file="real-work.mp4" boundary="LIVE VIKUNJA · READ-ONLY CAPTURE · 26 OCT IST"/></Series.Sequence>
<Series.Sequence name="Real Phala card" durationInFrames={22*fps} premountFor={fps}><Screen id="card" file="real-detail.mp4" boundary="LIVE PHALA CARD · 26 OCT CAPTURE · CONTACT DETAILS MASKED"/></Series.Sequence>
<Series.Sequence name="Real sales pipeline" durationInFrames={24*fps} premountFor={fps}><Screen id="pipeline" file="real-pipeline.mp4" boundary="REAL OUTREACH DASHBOARD · SAVED 23–25 OCT EVIDENCE"/></Series.Sequence>
<Series.Sequence name="Search source filter export" durationInFrames={16*fps} premountFor={fps}><Screen id="find" file="real-find.mp4" boundary="REAL DASHBOARD INTERACTION · SAVED EVIDENCE · IDLE TIME SHORTENED"/></Series.Sequence>
<Series.Sequence name="Actual Telegram control settings" durationInFrames={18*fps} premountFor={fps}><Screen id="control" file="real-control.mp4" boundary="LIVE OPERATIONS PAGE · READ-ONLY CAPTURE · 26 OCT IST"/></Series.Sequence>
<Series.Sequence name="Connection status" durationInFrames={10*fps} premountFor={fps}><Screen id="operations" file="real-operations.mp4" boundary="LIVE OPERATIONS PAGE · READ-ONLY CAPTURE · 26 OCT IST"/></Series.Sequence>
<Series.Sequence name="Closing real dashboard" durationInFrames={8*fps} premountFor={fps}><Screen id="finish" file="real-pipeline.mp4" boundary="REAL SCREEN RECORDINGS · CRM INTEGRATION ROLLOUT PENDING"/></Series.Sequence>
</Series>};
export const RealRoot=()=> <Composition id="AntSeedRealPlatformDemo" component={RealDemo} durationInFrames={3600} fps={30} width={1920} height={1080}/>;
