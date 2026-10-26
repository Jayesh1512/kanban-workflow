"""Artifact-only edit. Status GET is filtered in memory; no private UI or model calls."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import re
import subprocess
import textwrap
import urllib.request
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OLD = ROOT.parent / 'demo'
WORK = ROOT / '.render'
WORK.mkdir(exist_ok=True)
FONT = '/System/Library/Fonts/Supplemental/Arial.ttf'
BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
NAVY, WHITE, MUTED, GREEN, AMBER = '#101c2e', '#f0f5fc', '#aabbd1', '#7aebc6', '#ffd18b'
EXPECTED_ORIGINAL = 'df613a2e15f179f0a12a00d885a52004601320da3c5b9496f24c8fb23fa4516f'

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()

def safe_token(value):
    return value if isinstance(value, str) and re.fullmatch(r'[a-z_]{1,70}', value) else 'unknown'

def refresh(filename):
    # Raw response is ephemeral. Never write imports, details, accounts or login metadata.
    with urllib.request.urlopen('http://127.0.0.1:19280/api/status', timeout=15) as r:
        raw = json.load(r)
    safe = {
        'checkedAtUTC': datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'),
        'components': {k: {field: safe_token(raw.get('components', {}).get(k, {}).get(field))
                           for field in ('state', 'code')}
                       for k in ('database', 'vikunja', 'telegram', 'telegramSync', 'extraction', 'control', 'jev')},
        'loginState': safe_token(raw.get('telegramLogin', {}).get('state')),
        'accountBound': raw.get('accountBound') is True,
        **{k: raw.get(k) if type(raw.get(k)) is int and raw[k] >= 0 else None
           for k in ('replayPending', 'analysisPending', 'proposalsPending')},
    }
    del raw
    (ROOT / filename).write_text(json.dumps(safe, indent=2)+'\n')
    return safe

def text(im, value, x, y, size=34, color=WHITE, bold=False):
    ImageDraw.Draw(im).multiline_text((x, y), value, font=ImageFont.truetype(BOLD if bold else FONT, size), fill=color, spacing=12)

def base(kicker, title, chapter, stamp=None):
    im = Image.new('RGB', (1920,1080), NAVY)
    d = ImageDraw.Draw(im)
    d.rectangle((0,0,18,1080), fill=GREEN)
    text(im, 'ANTSEED', 92, 63, 28, GREEN, True)
    text(im, kicker, 310, 69, 22, MUTED)
    text(im, title, 90, 166, 76, WHITE, True)
    d.line((94, 982, 1826, 982), fill='#33455f', width=2)
    text(im, chapter, 94, 1009, 22, MUTED)
    text(im, stamp or 'Recorded evidence + fresh aggregate status  /  no private account footage', 650, 1009, 22, MUTED)
    return im

def draw_cards(status):
    stamp = status['checkedAtUTC']
    c = status['components']
    connected = c['telegram']['state'] == status['loginState'] == 'ready' and status['accountBound']
    sync_ready = c['telegramSync']['state'] == 'ready'
    intro = base('CURRENT MILESTONE  /  WORKFLOW DEMO', 'Conversations. Contacts. Action.', '01 / Current milestone', stamp)
    text(intro, 'Telegram connected' if connected else 'Telegram connection check', 94, 320, 66, GREEN, True)
    text(intro, 'History import underway  ·  sync '+c['telegramSync']['state'], 98, 416, 38)
    text(intro, 'Then: a recorded company workflow, from evidence to approved movement.', 98, 512, 34, MUTED)
    d = ImageDraw.Draw(intro)
    d.rounded_rectangle((94, 636, 1826, 894), 20, fill='#1d2d43')
    text(intro, 'LIVE END-TO-END ACCEPTANCE REMAINS OPEN', 126, 667, 24, AMBER, True)
    text(intro, 'Extraction timeout  ·  control group missing  ·  Jev credits needed', 126, 728, 38)
    text(intro, 'The working board story uses labelled synthetic inputs and recorded evidence.', 126, 805, 30, MUTED)
    intro.save(WORK/'intro.png')

    status_im = base('SANITIZED LIVE STATUS  /  READ-ONLY SNAPSHOT', 'Connected. Processing still pending.', '02 / Current status', stamp)
    entries = [
        ('DATABASE + VIKUNJA', c['database']['state']+' / '+c['vikunja']['state'], 'Persistence and board services', GREEN),
        ('TELEGRAM', c['telegram']['state']+' / login '+status['loginState'], 'Account bound: '+str(status['accountBound']).lower(), GREEN if connected else AMBER),
        ('SYNC', c['telegramSync']['state'].upper(), 'History work remains queued', GREEN if sync_ready else AMBER),
        ('EXTRACTION', c['extraction']['state'], c['extraction']['code'], AMBER),
        ('CONTROL GROUP', c['control']['state'], c['control']['code'], AMBER),
        ('JEV / GATEWAY', c['jev']['state'], c['jev']['code']+' / credits needed', AMBER),
    ]
    for i,(label,value,note,color) in enumerate(entries):
        x, y = 94+(i%3)*584, 304+(i//3)*231
        ImageDraw.Draw(status_im).rounded_rectangle((x,y,x+560,y+206),18,fill='#1d2d43')
        text(status_im,label,x+24,y+22,22,MUTED,True)
        text(status_im,value,x+24,y+67,35,color,True)
        text(status_im,note,x+24,y+132,23,MUTED)
    text(status_im, f"{status['replayPending']} replay pending     /     {status['analysisPending']} analysis pending     /     {status['proposalsPending']} proposals pending", 98, 820, 37, WHITE, True)
    text(status_im, 'Counts are a timestamped snapshot; connection does not establish successful live extraction or approval.', 98, 902, 28, MUTED)
    status_im.save(WORK/'status.png')

    bridge = base('EVIDENCE BOUNDARY', 'Recorded synthetic workflow', '03 / Demonstration', stamp)
    text(bridge, 'Actual backend + PostgreSQL + Vikunja', 98, 330, 50, GREEN, True)
    text(bridge, 'Synthetic company conversations. Authored extraction and recommendations.', 98, 440, 34)
    text(bridge, 'Explicit operator HTTP approval; Telegram group approval is not demonstrated.', 98, 526, 34)
    text(bridge, 'No fresh model invocation. Independent Hermes evidence is labelled as recorded.', 98, 612, 34, MUTED)
    text(bridge, 'Cedar  →  contacts and dated actions  →  pending proposal  →  approved board move', 98, 814, 32, GREEN)
    bridge.save(WORK/'bridge.png')

    close = base('CURRENT READINESS  /  CLEAR NEXT STEPS', 'A real milestone. A clear boundary.', '05 / Readiness', stamp)
    rows = [
        ('CONNECTED', 'Telegram login ready; account bound; imports underway.', GREEN),
        ('SYNC '+c['telegramSync']['state'].upper(), f"{status['replayPending']} replay pending; {status['analysisPending']} analysis pending; {status['proposalsPending']} proposals.", GREEN if sync_ready else AMBER),
        ('STILL OPEN', 'Extraction timeout; operational control group setup.', AMBER),
        ('JEV BLOCKED', 'Provider entitlement / credits needed; no fresh request.', AMBER),
        ('DEMONSTRATED', 'Recorded synthetic contacts, pending proposal and HTTP-approved move.', WHITE),
    ]
    for i,(label,value,color) in enumerate(rows):
        y = 317+i*107
        text(close,label,98,y,24,color,True)
        text(close,value,390,y-4,32,WHITE)
    text(close,'Live extraction → recommendation → Telegram approval remains unvalidated.',98,902,34,AMBER,True)
    close.save(WORK/'closing.png')
    return connected, sync_ready

def run(cmd):
    with (WORK/'render.log').open('a') as log:
        subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, check=True)

def probe(path):
    return json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration,size:stream=codec_name,width,height,r_frame_rate,sample_rate','-of','json',str(path)], text=True))

def narration(status, connected, sync_ready):
    sync = 'ready' if sync_ready else status['components']['telegramSync']['state']
    return {
        'intro': 'AntSeed turns conversations into contacts and clear next actions. Telegram is now connected, and history import is underway. Extraction is timing out, the control group still needs setup, and Jev needs credits. The workflow you will see is a recorded synthetic demonstration.',
        'status': f"Here is the current, sanitized status snapshot. The database and Vikunja are ready. Telegram login is ready and the account is bound. Sync is {sync}. There are {status['replayPending']} replay items, {status['analysisPending']} analysis items, and {status['proposalsPending']} proposals pending. Extraction still reports a timeout. The operational control group is missing. Jev remains paused for provider entitlement. A connection is not full live acceptance.",
        'bridge': 'The next section is recorded synthetic workflow evidence. The backend, database, and board are real. Source conversations and model decisions are authored fixtures. Approval uses an explicit operator H T T P request.',
        'closing': f"Telegram is connected, the account is bound, and history import is underway. Sync is {sync} at this timestamp. Extraction still times out, the operational control group needs setup, and Jev needs provider credits. The recorded workflow demonstrates contacts, sourced actions, and an approved board move with synthetic inputs. Successful live extraction, inference, and Telegram group approval remain unvalidated.",
    }

def card(name, duration, speech):
    script, voice = WORK/(name+'.txt'), WORK/(name+'.aiff')
    script.write_text(speech)
    run(['say','-v','Samantha','-r','162','-f',str(script),'-o',str(voice)])
    voice_duration = float(probe(voice)['format']['duration'])
    speed = max(1,voice_duration/(duration-0.8))
    run(['ffmpeg','-y','-loop','1','-framerate','30','-i',str(WORK/(name+'.png')),'-i',str(voice),
         '-vf','format=yuv420p','-af',f'atempo={speed:.7f},apad,atrim=duration={duration},afade=t=out:st={duration-0.35}:d=0.35',
         '-t',str(duration),'-c:v','libx264','-preset','fast','-crf','18','-threads','2','-c:a','aac','-b:a','160k','-ar','48000','-movflags','+faststart',str(WORK/(name+'.mp4'))])
    return voice_duration/speed

def signature(status):
    return {k:v for k,v in status.items() if k != 'checkedAtUTC'}

def clock(seconds):
    ms = round(seconds*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'

if __name__ == '__main__':
    baseline = {str(p.relative_to(OLD)):sha(p) for p in sorted(OLD.rglob('*')) if p.is_file()}
    assert baseline['antseed-kanban-demo.mp4'] == EXPECTED_ORIGINAL
    (ROOT/'original-hashes.json').write_text(json.dumps(baseline,indent=2)+'\n')
    status = refresh('status-before-render.json')
    print(json.dumps(status),flush=True)
    durations = {'intro':18,'status':29,'bridge':14,'closing':27}
    connected, sync_ready = draw_cards(status)
    assert connected, 'Unexpected connection change: revise opening before export'
    speeches = narration(status, connected, sync_ready)
    spoken = {}
    for name,duration in durations.items():
        spoken[name] = card(name,duration,speeches[name])
        print('Rendered '+name,flush=True)
    # Make the historical nature explicit on every reused native frame.
    overlay = Image.new('RGBA',(1920,1080),(0,0,0,0))
    ImageDraw.Draw(overlay).rectangle((0,0,1920,72),fill=(16,28,46,255))
    text(overlay,'RECORDED SYNTHETIC WORKFLOW DEMONSTRATION  /  EARLIER CAPTURE',44,8,21,GREEN,True)
    text(overlay,'SYNTHETIC MESSAGES + AUTHORED AI DECISIONS  |  ACTUAL BACKEND + POSTGRESQL + VIKUNJA',44,39,19,WHITE)
    overlay.save(WORK/'recorded-overlay.png')
    old_timeline = {item['name']:item for item in json.loads((OLD/'timeline.json').read_text())}
    core = ['board','contacts','proposal','approval','priorities','hermes']
    for name in core:
        if name == 'hermes':
            # This existing evidence card already labels the independent recorded run.
            run(['ffmpeg','-y','-i',str(OLD/'.render'/f'{name}.mp4'),'-map','0','-c','copy',str(WORK/f'{name}.mp4')])
        else:
            run(['ffmpeg','-y','-i',str(OLD/'.render'/f'{name}.mp4'),'-loop','1','-framerate','30','-i',str(WORK/'recorded-overlay.png'),
                 '-filter_complex','[0:v][1:v]overlay=0:0:shortest=1,format=yuv420p[v]','-map','[v]','-map','0:a','-t',str(old_timeline[name]['duration']),
                 '-c:v','libx264','-preset','fast','-crf','18','-threads','2','-c:a','copy',str(WORK/f'{name}.mp4')])
        print('Reused recorded '+name,flush=True)
    latest = refresh('status-pre-export.json')
    if signature(latest) != signature(status):
        status = latest
        connected, sync_ready = draw_cards(status)
        assert connected, 'Connection changed: do not export stale connection claim'
        speeches = narration(status, connected, sync_ready)
        for name,duration in durations.items():
            spoken[name] = card(name,duration,speeches[name])
        print('Updated cards for latest status before final export',flush=True)
    (ROOT/'status-rendered.json').write_text(json.dumps(status,indent=2)+'\n')
    timeline=[]
    cursor=0
    for name in ['intro','status','bridge',*core,'closing']:
        historical = name in core
        duration = old_timeline[name]['duration'] if historical else durations[name]
        item = {'name':name,'start':cursor,'end':cursor+duration,'duration':duration,
                'narration':old_timeline[name]['narration'] if historical else speeches[name],
                'evidenceKind':'Recorded independent Hermes verification' if name=='hermes' else 'Recorded synthetic workflow demonstration' if historical else 'Sanitized status presentation',
                'source':str(OLD/'.render'/f'{name}.mp4') if historical else str(WORK/(name+'.png')),
                'audioContentDuration':duration if historical else spoken[name]}
        if historical:
            item['originalTimeline'] = old_timeline[name]
        else:
            item['statusTimestampUTC'] = status['checkedAtUTC']
        timeline.append(item)
        cursor += duration
    (ROOT/'timeline.json').write_text(json.dumps(timeline,indent=2)+'\n')
    srt=[]
    for item in timeline:
        sentences=re.split(r'(?<=[.!?])\s+',item['narration'])
        total=sum(len(s.split()) for s in sentences)
        position=item['start']
        for sentence in sentences:
            end=position+item['audioContentDuration']*len(sentence.split())/total
            srt.append(f"{len(srt)+1}\n{clock(position)} --> {clock(end)}\n{textwrap.fill(sentence,78)}\n")
            position=end
    (ROOT/'antseed-current-demo.srt').write_text('\n'.join(srt))
    concat=WORK/'concat.txt'
    concat.write_text('\n'.join("file '"+str(WORK/(s['name']+'.mp4'))+"'" for s in timeline))
    target=ROOT/'antseed-current-demo.mp4'
    run(['ffmpeg','-y','-f','concat','-safe','0','-i',str(concat),'-map','0:v','-map','0:a','-c','copy','-movflags','+faststart',str(target)])
    after = {str(p.relative_to(OLD)):sha(p) for p in sorted(OLD.rglob('*')) if p.is_file()}
    assert after == baseline, 'Original artifacts changed'
    manifest = {'video':target.name,'sha256':sha(target),'probe':probe(target),'timelineSeconds':cursor,
                'renderedStatus':status,'preExportStatus':latest,'originalVideoSha256':after['antseed-kanban-demo.mp4'],
                'originalDirectoryUnchanged':True,'originalFilesCompared':len(baseline),
                'reusedSourceHashes':{name:baseline['.render/'+name+'.mp4'] for name in core},
                'privacy':'Only allowlisted status states/codes, accountBound boolean and aggregate counts retained. No personal UI captured.',
                'boundary':'Recorded synthetic workflow, actual backend/database/board and operator HTTP approval; recorded independent Hermes evidence. No new model call.',
                'notEstablished':['successful live extraction','successful live Jev inference','Telegram control-group approval'],
                'historicalSourceManifest':'../demo/evidence-manifest.json'}
    (ROOT/'evidence-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({'output':str(target),'duration':cursor,'sha256':manifest['sha256'],'originalUnchanged':True}),flush=True)
