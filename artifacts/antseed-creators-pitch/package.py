"""Build a single offline HTML and source ZIP from this folder."""
from pathlib import Path
import base64,mimetypes,re,zipfile
root=Path(__file__).resolve().parent
out=root.parent
stem='Antseed-Creators-Pitch-Updated'
def data_url(rel):
 p=root/rel
 mime=mimetypes.guess_type(p.name)[0] or 'application/octet-stream'
 return 'data:'+mime+';base64,'+base64.b64encode(p.read_bytes()).decode()
css=(root/'deck.css').read_text()
css=re.sub(r'url\(([^)]+)\)',lambda m:'url("'+data_url(m.group(1).strip('\"\''))+'")',css)
h=(root/'index.html').read_text().replace('<script src="deck.js"></script>','<script>'+(root/'deck.js').read_text()+'</script>')
h=re.sub(r'<link\b[^>]*href="deck\.css"[^>]*>',lambda m:'<style>'+css+'</style>',h)
h=re.sub(r'src="(assets/[^"]+)"',lambda m:'src="'+data_url(m.group(1))+'"',h)
(out/(stem+'.html')).write_text(h)
with zipfile.ZipFile(out/(stem+'-source.zip'),'w',zipfile.ZIP_DEFLATED) as z:
 for p in sorted(root.rglob('*')):
  if p.is_file() and '__pycache__' not in str(p):z.write(p,Path('antseed-creators-pitch')/p.relative_to(root))
print(out/(stem+'.html'))
