from pathlib import Path
import subprocess,json,hashlib,re,datetime
from PIL import Image,ImageDraw
root=Path(__file__).parent.resolve();video=root/'out/antseed-real-platform-demo-2min.mp4';e=root/'evidence'
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames,sample_rate','-of','json',str(video)],text=True));v=next(x for x in probe['streams'] if x['codec_type']=='video');a=next(x for x in probe['streams'] if x['codec_type']=='audio');assert v['width']==1920 and v['height']==1080 and v['r_frame_rate']=='30/1';assert abs(float(probe['format']['duration'])-120)<.1;assert v['nb_frames']=='3600';assert a['codec_name']=='aac'
decode=subprocess.run(['ffmpeg','-v','error','-i',str(video),'-f','null','-'],capture_output=True,text=True);(e/'decode.log').write_text(decode.stderr);assert decode.returncode==0 and not decode.stderr.strip()
vol=subprocess.run(['ffmpeg','-i',str(video),'-af','volumedetect','-vn','-sn','-dn','-f','null','-'],capture_output=True,text=True);levels={k:float(x) for k,x in re.findall(r'(mean_volume|max_volume):\s*([-\d.]+) dB',vol.stderr)}
seconds=[3,12,27,38,49,61,74,91,105,116];sheet=Image.new('RGB',(1440,5*440),'#0b1921');d=ImageDraw.Draw(sheet)
for i,s in enumerate(seconds):
 p=e/f'frame-{s:03}.png';subprocess.run(['ffmpeg','-y','-loglevel','error','-ss',str(s),'-i',str(video),'-frames:v','1',str(p)],check=True);im=Image.open(p).convert('RGB');im.thumbnail((704,396));x=(i%2)*720+8;y=(i//2)*440+27;sheet.paste(im,(x,y));d.text((x,y-20),f'{s:03}s',fill='#d8f48c')
sheet.save(root/'out/review-contact-sheet-real.jpg',quality=94)
timeline=json.loads((e/'real-timeline.json').read_text());captions=json.loads((e/'real-captions.json').read_text());assert timeline[-1]['end']==120;assert all(x['startMs']<x['endMs']<=120000 for x in captions);assert all(x['endMs']<=y['startMs'] for x,y in zip(captions,captions[1:]));assert len(timeline)==8
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'metadata':probe,'fullDecode':'PASS','timeline':'PASS','captionCues':len(captions),'volumeDb':levels,'sha256':hashlib.sha256(video.read_bytes()).hexdigest(),'visualReviewFrames':seconds,'visualReview':'pending human-equivalent agent image inspection','credentialScan':'See source-manifest/README; final scan is separate'};(e/'validation.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
