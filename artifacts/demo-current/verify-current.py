"""Acceptance checks and review frames for the updated, artifact-only export."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent
WORK=ROOT/'.render'
VIDEO=ROOT/'antseed-current-demo.mp4'

def sha(path):
    return hashlib.file_digest(path.open('rb'),'sha256').hexdigest()

manifest=json.loads((ROOT/'evidence-manifest.json').read_text())
timeline=json.loads((ROOT/'timeline.json').read_text())
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(VIDEO)],text=True))
video=next(s for s in probe['streams'] if s['codec_type']=='video')
audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
assert (video['width'],video['height'],video['r_frame_rate'],video['codec_name'])==(1920,1080,'30/1','h264')
assert audio['codec_name']=='aac' and audio['sample_rate']=='48000'
assert abs(float(probe['format']['duration'])-timeline[-1]['end'])<0.1
for a,b in zip(timeline,timeline[1:]):
    assert a['end']==b['start']
assert timeline[0]['start']==0
assert manifest['sha256']==sha(VIDEO)
original=json.loads((ROOT/'original-hashes.json').read_text())
for relative,digest in original.items():
    assert sha(ROOT.parent/'demo'/relative)==digest,relative
with (WORK/'decode-errors.log').open('w') as log:
    subprocess.run(['ffmpeg','-v','error','-xerror','-i',str(VIDEO),'-map','0:v:0','-map','0:a:0','-f','null','-'],stdout=subprocess.DEVNULL,stderr=log,check=True)
assert not (WORK/'decode-errors.log').read_text().strip()

def seconds(value):
    h,m,s=value.replace(',','.').split(':')
    return int(h)*3600+int(m)*60+float(s)

cues=re.findall(r'(\d+)\n(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)\n(.+?)(?=\n\n|\Z)',(ROOT/'antseed-current-demo.srt').read_text(),re.S)
previous=0
for i,(number,start,end,caption) in enumerate(cues,1):
    start,end=seconds(start),seconds(end)
    assert int(number)==i and previous<=start<end<=timeline[-1]['end']+0.001
    previous=end
assert len(cues)>30

# New text-only render inputs have no credentials, phones or personal chat identifiers.
patterns={
    'private_key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'api_key_shape':r'\bsk-[A-Za-z0-9_-]{20,}',
    'jwt_shape':r'\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.',
    'international_phone':r'(?<!\w)\+[1-9][0-9]{10,14}(?!\w)',
    'raw_private_status_field':r'"(?:imports|phone|password|session|accessToken|apiKey|chatId|accountId)"\s*:',
}
privacy_findings=[]
for path in [*ROOT.glob('*.json'),*ROOT.glob('*.srt'),*WORK.glob('*.txt')]:
    content=path.read_text()
    for label,pattern in patterns.items():
        if re.search(pattern,content):
            privacy_findings.append({'file':path.name,'type':label})
assert not privacy_findings,privacy_findings

times=[3,30,53,67,90,109,122,140,156,178,201,211]
sheet=Image.new('RGB',(1920,4*400),'#101c2e')
for i,t in enumerate(times):
    path=WORK/f'check-{t}.png'
    subprocess.run(['ffmpeg','-v','error','-y','-ss',str(t),'-i',str(VIDEO),'-frames:v','1',str(path)],check=True)
    frame=Image.open(path).convert('RGB').resize((640,360),Image.Resampling.LANCZOS)
    x,y=(i%3)*640,(i//3)*400
    sheet.paste(frame,(x,y))
    ImageDraw.Draw(sheet).text((x+14,y+366),f'{t}s  /  '+next(s['name'] for s in timeline if s['start']<=t<s['end']),font=ImageFont.truetype('/System/Library/Fonts/Supplemental/Arial.ttf',20),fill='white')
sheet.save(WORK/'review-contact-sheet.jpg',quality=95)
vol=subprocess.run(['ffmpeg','-hide_banner','-i',str(VIDEO),'-vn','-af','volumedetect','-f','null','-'],capture_output=True,text=True,check=True)
metrics={k:float(v) for k,v in re.findall(r'(mean_volume|max_volume): (-?[\d.]+) dB',vol.stderr)}
assert metrics['max_volume']<0
report={'result':'AUTOMATED CHECKS PASS; visual review recorded separately',
        'durationSeconds':float(probe['format']['duration']),'width':video['width'],'height':video['height'],
        'fps':video['r_frame_rate'],'videoCodec':video['codec_name'],'audioCodec':audio['codec_name'],'sampleRate':audio['sample_rate'],
        'fullDecode':'PASS, empty error log','captionCues':len(cues),'srtOrderAndBounds':'PASS','timelineContinuity':'PASS',
        'audioVolumeDB':metrics,'privacyPatternFindings':privacy_findings,'sampledFramesSeconds':times,
        'originalFilesUnchanged':len(original),'originalVideoSha256':original['antseed-kanban-demo.mp4'],
        'videoSha256':sha(VIDEO)}
(ROOT/'validation.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
