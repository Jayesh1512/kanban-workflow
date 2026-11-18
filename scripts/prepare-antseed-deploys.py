"""Prepare isolated Vercel folders from the current, verified deck exports."""
from pathlib import Path
import json
import os
import shutil

root = Path(__file__).resolve().parent.parent
cache = Path(os.environ.get('ANTSEED_DEPLOY_ROOT', Path.home() / '.cache/antseed-vercel'))
decks = {
    'antseed-creators-pitch': ('Antseed-Creators-Pitch-Updated', 'Antseed-Creators-Pitch'),
    'antseed-neobanks-short': ('Antseed-Neobanks-Short', 'Antseed-Neobanks-Short'),
    'antseed-neobanks-offering': ('Antseed-Neobanks-Offering', 'Antseed-Neobanks-Offering'),
    'antseed-neobanks-presentation': ('Antseed-Neobanks-Offering', 'Antseed-Neobanks-Offering'),
}
for project, (source, output) in decks.items():
    target = cache / project
    public = target / 'public'
    public.mkdir(parents=True, exist_ok=True)
    linked = target / '.vercel/project.json'
    if linked.exists() and json.loads(linked.read_text()).get('projectName') != project:
        raise SystemExit(f'Wrong Vercel project: {target}')
    shutil.copy2(root / 'artifacts' / (source + '.html'), public / 'index.html')
    shutil.copy2(root / 'artifacts' / (source + '.pdf'), public / (output + '.pdf'))
    (target / 'vercel.json').write_text(json.dumps({
        'framework': None, 'buildCommand': None, 'installCommand': '',
        'outputDirectory': 'public', 'cleanUrls': True,
        'headers': [{
            'source': '/' + output + '.pdf',
            'headers': [{
                'key': 'Content-Disposition',
                'value': 'attachment; filename="' + output + '.pdf"',
            }],
        }],
    }) + '\n')
    (target / '.vercelignore').write_text('.env*\ndeployment.json\n')
    if project == 'antseed-creators-pitch':
        (target / 'api').mkdir(exist_ok=True)
        (target / 'lib').mkdir(exist_ok=True)
        handler = (root / 'scripts/lib/antseed-stats-api.cjs').read_text()
        handler = handler.replace("require('./antseed-stats.cjs')", "require('../lib/antseed-stats.cjs')")
        (target / 'api/stats.js').write_text(handler)
        shutil.copy2(root / 'scripts/lib/antseed-stats.cjs', target / 'lib/antseed-stats.cjs')
    print(target)
