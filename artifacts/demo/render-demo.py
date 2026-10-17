"""Edit genuine browser captures; cards identify recorded and synthetic evidence."""
from pathlib import Path
import json
import subprocess
import re
import textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
WORK = ROOT / '.render'
WORK.mkdir(exist_ok=True)
CAPTURES = json.loads((ROOT / 'capture-sources.json').read_text())
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
MONO = '/System/Library/Fonts/Menlo.ttc'
BOUNDARY = 'SYNTHETIC MESSAGES + AUTHORED AI DECISIONS  |  ACTUAL BACKEND + POSTGRESQL + VIKUNJA'

segments = [
    dict(name='intro', duration=8, card=True, title='AntSeed',
         lines=['A relationship board operated by your backend and agent.',
                'A working Docker stack. Synthetic conversations. Explicit approval.'],
         speech='AntSeed brings company conversations, contacts, and follow ups into one board. This recording uses synthetic messages and authored AI decisions.'),
    dict(name='board', duration=15, clip='board', start=1,
         caption='Six lanes. One ticket per company chat.\nWorkstreams remain separate from progress.',
         speech='The actual Vikunja board has six lanes, from To be started through Completed. Cedar is a Buyer. That workstream label is separate from its current progress.'),
    dict(name='contacts', duration=28, clip='task', start=2,
         caption='Shared company contacts, source evidence and clear ownership.\nTomorrow stays a calendar date anchored to the original message.',
         speech='Open the company ticket. Mira is the C T O, and Jo is the engineering lead. Both contacts belong to Cedar. The backend keeps source evidence beside the next action. AntSeed owes pricing and integration notes tomorrow. Jo owns a separate external review. Those commitments keep their original actor and calendar date, instead of inventing an exact time.'),
    dict(name='chat_policy', duration=20, clip='status', pieces=[(1,8),(28,12)],
         caption='Chats start included; each can be excluded.\nHistory import and operational group setup stay explicit.',
         speech='The setup page exposes actual connection state, chat inclusion, and bounded history import. This demo contains one synthetic chat. An operator can exclude a chat or configure the operational group here. Live Telegram login is not shown in this recording.'),
    dict(name='proposal', duration=14, clip='proposal', start=1,
         caption='A sourced recommendation is pending, not applied.\nThe authored fixture is labelled; no live Jev inference is claimed.',
         speech='The recommendation proposes Work in progress, with evidence and a reason. Decision is pending, and apply state is not requested. The board has not moved. This recommendation is an authored fixture.'),
    dict(name='approval', duration=30, clip='approval', start=0,
         caption='Explicit operator HTTP approval; Telegram control is not connected here.\nThe canonical worker owns movement and remote readback.',
         speech='Now an explicit operator approval is submitted through the existing H T T P endpoint. Approval queues the operation. The normal backend worker handles the move and checks Vikunja. After refreshing the real board, Cedar is in Work in progress. Database readback confirms stage version one, one committed mutation, and an applied proposal. The helper did not move the task.'),
    dict(name='priorities', duration=20, clip='priorities', pieces=[(1,9),(20,11)],
         caption='Evidence-backed priorities expose the next AntSeed action.\nExternal promises stay distinct from AntSeed commitments.',
         speech='The priorities endpoint returns the current ticket, next action, evidence, and an upcoming commitment. The date is interpreted in Asia Kolkata. AntSeed responsibilities remain distinct from the external contact review. These same records are available to Hermes through M C P.'),
    dict(name='hermes', duration=19, card=True, title='Nous Hermes: proposal only',
         lines=['RECORDED INDEPENDENT QA RUN — actual installed Hermes Agent 0.21.3',
                'Discovered: 27 MCP tools',
                'Called: mcp__antseed__propose_lane_change',
                'Result: pending / not_requested / origin = hermes',
                'Board unchanged  ·  stage 0  ·  mutations 0  ·  CLI exit 0'],
         speech='A separate recorded independent verification used the actual installed Nous Hermes agent. It discovered all twenty seven tools and called propose lane change. Real database readback found a pending Hermes proposal, while the board stayed unchanged, with stage zero and no mutations. No new model run was used for this video.'),
    dict(name='closing', duration=15, card=True, title='Ready for live onboarding',
         lines=['Start the complete stack: docker compose up',
                'Verified locally: persistence, approvals, MCP and installed Hermes.',
                'Live Telegram login / control-group flow: still outstanding.',
                'Successful Jev through Vercel: blocked by Gateway credits.',
                'Synthetic inputs are labelled throughout this recording.'],
         speech='Start everything with docker compose up. Local deployment, persistence, approvals, and Hermes have passed independent checks. Live Telegram onboarding remains outstanding, and successful Jev inference is blocked by Gateway credits. Those limits are separate from the working local demonstration.'),
]

def write(name, text):
    p = WORK / name
    p.write_text(text, encoding='utf-8')
    return p

def paint_text(image, text, size, x, y, color='white', mono=False):
    ImageDraw.Draw(image).multiline_text((x,y),text,font=ImageFont.truetype(MONO if mono else FONT,size),fill=color,spacing=14)

def run(cmd, log):
    result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError('Rendering failed; inspect artifacts/demo/.render/render.log')

def clock(seconds):
    ms = int(round(seconds * 1000))
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'

timeline=[]
cursor=0
with (WORK/'render.log').open('w') as log:
    # The refresh in the original capture showed a loading screen. Keep the
    # original pending/approval footage and cut idle refresh time to a later
    # genuine capture of the same already-applied board; never reset the task.
    original_approval=CAPTURES['approval']['path']
    final_board=json.loads((ROOT/'final-board-capture.json').read_text())['path']
    assembled=WORK/'approval-real-cuts.mkv'
    run(['ffmpeg','-y','-i',original_approval,'-i',final_board,'-filter_complex',
         '[0:v]trim=start=0:duration=12,setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,fps=30[a];[1:v]trim=start=1:duration=18,setpts=PTS-STARTPTS,scale=1920:1080:flags=lanczos,fps=30[b];[a][b]concat=n=2:v=1:a=0[out]',
         '-map','[out]','-c:v','ffv1','-threads','2',str(assembled)],log)
    CAPTURES['approval']={**CAPTURES['approval'],'path':str(assembled),'sourceSegments':[
        {'path':original_approval,'start':0,'duration':12},
        {'path':final_board,'start':1,'duration':18}]}
    for index, segment in enumerate(segments):
        name, duration = segment['name'], segment['duration']
        voice_text=write(name+'-narration.txt',segment['speech'])
        voice=WORK/(name+'.aiff')
        run(['say','-v','Samantha','-r','162','-f',str(voice_text),'-o',str(voice)],log)
        voice_duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',str(voice)],text=True))
        speed=max(1.0,voice_duration/(duration-0.6))
        inputs=[]
        filters=[]
        if segment.get('card'):
            image=Image.new('RGB',(1920,1080),'#101c2e')
            ImageDraw.Draw(image).rectangle((94,160,190,167),fill='#67e8c5')
            paint_text(image,'ANTSEED  /  WORKING PROJECT DEMO' if name!='hermes' else 'RECORDED VERIFICATION  /  SYNTHETIC COMPANY DATA',24,96,94,'#92a8c5')
            paint_text(image,segment['title'],78,94,210)
            paint_text(image,'\n\n'.join(segment['lines']),31,98,360,'#d8e4f4')
            card=WORK/(name+'-card.png'); image.save(card)
            inputs=['-loop','1','-framerate','30','-i',str(card)]
            video='[0:v]format=yuv420p[video]'
        else:
            source=CAPTURES[segment['clip']]['path']
            inputs=['-i',source]
            if 'pieces' in segment:
                parts=[]
                for j,(start,length) in enumerate(segment['pieces']):
                    parts.append(f'[0:v]trim=start={start}:duration={length},setpts=PTS-STARTPTS[p{j}]')
                parts.append(''.join(f'[p{j}]' for j in range(len(segment['pieces'])))+f"concat=n={len(segment['pieces'])}:v=1:a=0[base]")
                prefix=';'.join(parts)+';[base]'
            else:
                prefix=f"[0:v]trim=start={segment.get('start',0)}:duration={duration},setpts=PTS-STARTPTS,"
            overlay=Image.new('RGBA',(1920,1080),(0,0,0,0))
            draw=ImageDraw.Draw(overlay)
            draw.rectangle((0,0,1920,72),fill=(16,28,46,248))
            draw.rectangle((0,912,1920,1080),fill=(16,28,46,248))
            paint_text(overlay,BOUNDARY,21,44,24,'#9ff2d9')
            paint_text(overlay,segment['caption'],34,48,948)
            overlay_path=WORK/(name+'-overlay.png');overlay.save(overlay_path)
            filters=(['crop=2560:1440:40:140'] if name=='contacts' else ['crop=2560:1440:640:0'] if name=='chat_policy' else [])+['scale=1920:1080:flags=lanczos','fps=30']
            video=prefix+','.join(filters)+'[basevideo];[basevideo][2:v]overlay=0:0[layer0]'
            extra_inputs=['-loop','1','-framerate','30','-i',str(overlay_path)]
            if name=='approval':
                updates=[(0,9,'Pending proposal / remote lane unchanged'),
                         (9,12,'Operator: POST /api/proposals/:id/decision  { decision: approve }'),
                         (12,30,'After approval: Work in progress / stage 1 / one committed mutation')]
                for j,(start,end,text) in enumerate(updates):
                    step=Image.new('RGBA',(1920,1080),(0,0,0,0))
                    ImageDraw.Draw(step).rectangle((28,844,1880,906),fill=(241,245,249,246))
                    paint_text(step,text,26,48,858,'#101c2e')
                    step_path=WORK/(f'approval-step{j}.png');step.save(step_path)
                    extra_inputs+=['-loop','1','-framerate','30','-i',str(step_path)]
                    video+=f";[layer{j}][{j+3}:v]overlay=0:0:enable='between(t,{start},{end})'[layer{j+1}]"
                video+=';[layer3]format=yuv420p[video]'
            else: video+=';[layer0]format=yuv420p[video]'
        audio_index=1
        graph=video+f';[{audio_index}:a]atempo={speed:.6f},apad,atrim=duration={duration},afade=t=out:st={duration-0.5}:d=0.5[audio]'
        target=WORK/(name+'.mp4')
        cmd=['ffmpeg','-y',*inputs,'-i',str(voice),*(extra_inputs if not segment.get('card') else []),'-filter_complex',graph,'-map','[video]','-map','[audio]',
             '-t',str(duration),'-c:v','libx264','-preset','medium','-crf','18','-pix_fmt','yuv420p','-threads','2',
             '-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart',str(target)]
        run(cmd,log)
        timeline.append({'name':name,'start':cursor,'end':cursor+duration,'duration':duration,'narration':segment['speech'],
                         'source':CAPTURES[segment['clip']]['path'] if 'clip' in segment else 'Clearly labelled title/evidence card',
                         **({'sourceSegments':CAPTURES['approval']['sourceSegments'],'editNote':'Idle refresh cut to a later actual capture of the same approved task; no replay/reset.'} if name=='approval' else {})})
        cursor+=duration
        print(json.dumps({'rendered':name,'duration':duration}),flush=True)
    concat=write('concat.txt','\n'.join("file '"+str(WORK/(s['name']+'.mp4'))+"'" for s in segments))
    run(['ffmpeg','-y','-f','concat','-safe','0','-i',str(concat),'-c','copy','-movflags','+faststart',str(ROOT/'antseed-kanban-demo.mp4')],log)

(ROOT/'timeline.json').write_text(json.dumps(timeline,indent=2)+'\n')
srt=[]
for item in timeline:
    # Sentence captions complement the shorter burned-in chapter captions.
    sentences=re.split(r'(?<=[.!?])\s+',item['narration'])
    words=sum(len(s.split()) for s in sentences)
    position=item['start']
    for sentence in sentences:
        end=position+item['duration']*len(sentence.split())/words
        srt.append(f"{len(srt)+1}\n{clock(position)} --> {clock(end)}\n{textwrap.fill(sentence,width=78)}\n")
        position=end
(ROOT/'antseed-kanban-demo.srt').write_text('\n'.join(srt))
print(json.dumps({'output':str(ROOT/'antseed-kanban-demo.mp4'),'seconds':cursor,'resolution':'1920x1080','fps':30}),flush=True)
