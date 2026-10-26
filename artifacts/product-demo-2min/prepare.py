from pathlib import Path
import json,subprocess,shutil,re
ROOT=Path(__file__).parent.resolve();PUBLIC=ROOT/'public';EVIDENCE=ROOT/'evidence'
scenes=[
('intro',8,'Conversations become action','AntSeed connects conversations, company knowledge, and follow ups. In two minutes, see the work board, the sales pipeline, and the approval flow.'),
('work',14,'01 / Work Kanban','The work Kanban tracks delivery across six lanes. Start with a prospect, move into work in progress and integrations, and keep blockers, completed work, and archived conversations visible. Workstream labels describe the relationship separately.'),
('crm',16,'02 / Sales CRM','The separate sales CRM uses five stages: Lead or Prospect, Qualification, Negotiation, Deal Won, and Archived. This local preview uses synthetic companies. Search the pipeline, inspect a relationship, and export the visible records. CRM rollout is still pending.'),
('context',16,'03 / One card, the full context','Each relationship links people, source conversations, and next actions. Here, Mira is the CTO and Jo leads engineering. AntSeed owes pricing and integration notes tomorrow. Jo owns the external review. Responsibilities and calendar dates stay separate.'),
('intelligence',12,'04 / Evidence before recommendations','The AI workflow extracts company information, contacts, commitments, and supporting evidence. It then recommends the next work lane. Uncertain or invalid results stay held for review. A recommendation is a proposal, not a completed move.'),
('approval',18,'05 / Review, approve, verify','Work lane proposals can be reviewed through the Telegram control group. In this recorded example, approval is submitted through the operator API. The normal worker then moves Cedar into Work in progress and verifies the result. This footage uses authored decisions, not a fresh live model run.'),
('priorities',14,'06 / Follow-ups that keep their meaning','Ask what needs attention today. Priorities connect the next action, the responsible person, the date, and its source evidence. Chat inclusion and exclusions control what enters the system. Conversation edits and deletions invalidate stale recommendations.'),
('hermes',12,'07 / Ask Hermes','Nous Research Hermes accesses the same records through MCP. Recorded independent testing verified context reads and a pending lane change proposal. Hermes can help inspect and propose work, while approval remains a separate step.'),
('close',10,'One place to keep the relationship moving','Work and sales progress, connected to the conversation. Verified recordings and a local CRM preview. Live AI validation and CRM deployment remain in progress.')]
(EVIDENCE/'script.json').write_text(json.dumps([{'id':x[0],'seconds':x[1],'title':x[2],'narration':x[3]} for x in scenes],indent=2))
captions=[];timeline=[];cursor=0
for name,duration,title,speech in scenes:
 text=EVIDENCE/(name+'.txt');text.write_text(speech);aiff=PUBLIC/(name+'.aiff');wav=PUBLIC/(name+'.wav')
 subprocess.run(['say','-v','Samantha','-r','165','-f',str(text),'-o',str(aiff)],check=True)
 length=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(aiff)],text=True))
 speed=max(1,length/(duration-.4))
 subprocess.run(['ffmpeg','-y','-loglevel','error','-i',str(aiff),'-af',f'atempo={speed},apad,atrim=duration={duration},afade=t=out:st={duration-.3}:d=0.3','-ar','48000',str(wav)],check=True);aiff.unlink()
 chunks=re.split(r'(?<=[.!?])\s+',speech);words=sum(len(s.split()) for s in chunks);pos=0;local=[]
 for chunk in chunks:
  end=pos+duration*len(chunk.split())/words
  cue={'text':chunk,'startMs':round(pos*1000),'endMs':round(end*1000),'timestampMs':None,'confidence':None};local.append(cue);captions.append({**cue,'startMs':round((cursor+pos)*1000),'endMs':round((cursor+end)*1000)});pos=end
 timeline.append({'id':name,'start':cursor,'end':cursor+duration,'seconds':duration,'title':title,'captions':local});cursor+=duration
 print(name,round(length,2),speed,flush=True)
(EVIDENCE/'timeline.json').write_text(json.dumps(timeline,indent=2));(ROOT/'src/timeline.json').write_text(json.dumps(timeline));(EVIDENCE/'captions.json').write_text(json.dumps(captions,indent=2))
def stamp(ms):
 s,milli=divmod(ms,1000);m,s=divmod(s,60);h,m=divmod(m,60);return f'{h:02}:{m:02}:{s:02},{milli:03}'
(ROOT/'out/antseed-product-demo-2min.srt').write_text('\n\n'.join(f'{i+1}\n{stamp(c["startMs"])} --> {stamp(c["endMs"])}\n{c["text"]}' for i,c in enumerate(captions))+'\n')
# Existing privacy-reviewed native recordings. No live application writes.
sources=json.loads(Path('artifacts/demo/capture-sources.json').read_text())
for key,start,duration in [('board',1,14),('task',5,16),('proposal',1,12),('priorities',2,14)]:
 subprocess.run(['ffmpeg','-y','-loglevel','error','-i',sources[key]['path'],'-t',str(duration),'-an','-vf',f'fps=30,trim=start={start}:duration={duration},setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2','-c:v','libx264','-preset','fast','-crf','18',str(PUBLIC/(key+'.mp4'))],check=True)
# Genuine same-task approval edit, normalize sparse recording frames before trimming.
subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', '/Users/jys/.t3/userdata/attachments/675d7f86-acfd-4669-b9af-91caf5a8ee02-a016a44d-55de-46d1-937e-9de1775a071a-mp4.mp4', '-i', '/Users/jys/.t3/userdata/attachments/675d7f86-acfd-4669-b9af-91caf5a8ee02-0005e899-0924-42d7-83b4-83ad535243c7-mp4.mp4', '-filter_complex', '[0:v]fps=30,trim=start=0:duration=9,setpts=PTS-STARTPTS,scale=1920:1080,setsar=1[a];[1:v]fps=30,trim=start=9:duration=9,setpts=PTS-STARTPTS,scale=1920:1080,setsar=1[b];[a][b]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '18']+[str(PUBLIC/'approval.mp4')],check=True)
shutil.copy('artifacts/teaser-30s/public/dm-sans-400.woff2',PUBLIC/'dm-sans-400.woff2');shutil.copy('artifacts/teaser-30s/public/dm-sans-600.woff2',PUBLIC/'dm-sans-600.woff2');shutil.copy('artifacts/teaser-30s/public/DM-Sans-LICENSE.txt',PUBLIC/'DM-Sans-LICENSE.txt')
print('Prepared 120 seconds',flush=True)

# Crop empty board canvas for legibility in the film.
for name,height in [("board",780),("approval",632)]:
    source=PUBLIC/(name+".mp4");target=PUBLIC/(name+"-crop.mp4")
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",str(source),"-vf",f"crop=1920:{height}:0:0","-an","-c:v","libx264","-preset","fast","-crf","18",str(target)],check=True);target.replace(source)
