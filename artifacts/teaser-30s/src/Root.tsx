import {Audio} from '@remotion/media';
import {Composition,Folder,Series,staticFile,useVideoConfig} from 'remotion';
import {Hook} from './Hook';
import {Capture} from './Capture';
import {Clarity} from './Clarity';
import {Approval} from './Approval';
import {Closing} from './Closing';
export const Teaser=()=>{
 const {fps}=useVideoConfig();
 return <>
  <Audio name="Original ambient pulse" src={staticFile('original-score.wav')} volume={0.7} premountFor={fps}/>
  <Series>
   <Series.Sequence name="The conversation" durationInFrames={5*fps} premountFor={fps}><Hook/></Series.Sequence>
   <Series.Sequence name="The first enquiry" durationInFrames={6*fps} premountFor={fps}><Capture/></Series.Sequence>
   <Series.Sequence name="The organized card" durationInFrames={7*fps} premountFor={fps}><Clarity/></Series.Sequence>
   <Series.Sequence name="Human approval" durationInFrames={7*fps} premountFor={fps}><Approval/></Series.Sequence>
   <Series.Sequence name="AntSeed Kanban" durationInFrames={5*fps} premountFor={fps}><Closing/></Series.Sequence>
  </Series>
 </>;
};
export const Root=()=> <>
 <Composition id="AntSeedTeaser" component={Teaser} width={1920} height={1080} fps={30} durationInFrames={900}/>
 <Folder name="Scenes">
  <Composition id="Hook" component={Hook} width={1920} height={1080} fps={30} durationInFrames={150}/>
  <Composition id="Capture" component={Capture} width={1920} height={1080} fps={30} durationInFrames={180}/>
  <Composition id="Clarity" component={Clarity} width={1920} height={1080} fps={30} durationInFrames={210}/>
  <Composition id="Approval" component={Approval} width={1920} height={1080} fps={30} durationInFrames={210}/>
  <Composition id="Closing" component={Closing} width={1920} height={1080} fps={30} durationInFrames={150}/>
 </Folder>
</>;
