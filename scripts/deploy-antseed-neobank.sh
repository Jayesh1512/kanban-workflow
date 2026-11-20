#!/usr/bin/env bash
# Pull the editable deck, rebuild its PDF and publish both shared URLs.
set -euo pipefail

repo_dir="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
scope="${ANTSEED_VERCEL_SCOPE:-jayesh1512s-projects}"
deploy_root="${ANTSEED_DEPLOY_ROOT:-${XDG_CACHE_HOME:-$HOME/.cache}/antseed-vercel}"
chrome="${ANTSEED_CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
source_file="$repo_dir/artifacts/antseed-neobank-deck/index.html"
command -v vercel >/dev/null || { echo 'Install the Vercel CLI first.' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js is required.' >&2; exit 1; }
test -x "$chrome" || { echo 'Set ANTSEED_CHROME to your Chrome executable.' >&2; exit 1; }

git -C "$repo_dir" pull --ff-only
node "$repo_dir/scripts/refresh-antseed-stats.cjs" antseed-neobank-deck
cp "$source_file" "$repo_dir/artifacts/Antseed-Neobanks-Offering.html"
source_commit="$(git -C "$repo_dir" rev-parse --short HEAD)"
echo "Publishing main neobank deck from $source_commit"
python3 - "$source_file" <<'PY'
from pathlib import Path
import re, sys
text = Path(sys.argv[1]).read_text()
if re.search(r'(?m)^(?:<<<<<<< |=======\s*$|>>>>>>> )', text):
    raise SystemExit('Resolve the merge-conflict markers in index.html before deploying.')
PY

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/antseed-neobank.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
source_uri="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().as_uri())' "$source_file")"
pdf_file="$work_dir/Antseed-Neobanks-Offering.pdf"
if ! "$chrome" --headless --no-pdf-header-footer --force-prefers-reduced-motion \
  --virtual-time-budget=3000 --timeout=15000 --user-data-dir="$work_dir/profile" \
  --print-to-pdf="$pdf_file" "$source_uri" >"$work_dir/chrome.log" 2>&1; then
  cat "$work_dir/chrome.log" >&2
  exit 1
fi
test -s "$pdf_file" || { echo 'Chrome did not produce the PDF.' >&2; exit 1; }
cp "$pdf_file" "$repo_dir/artifacts/Antseed-Neobanks-Offering.pdf"

for project in antseed-neobanks-presentation antseed-neobanks-offering; do
  target="$deploy_root/$project"
  mkdir -p "$target/public"
  cp "$source_file" "$target/public/index.html"
  cp "$pdf_file" "$target/public/Antseed-Neobanks-Offering.pdf"
  cat >"$target/vercel.json" <<'JSON'
{"framework":null,"buildCommand":null,"installCommand":"","outputDirectory":"public","cleanUrls":true,"headers":[{"source":"/Antseed-Neobanks-Offering.pdf","headers":[{"key":"Content-Disposition","value":"attachment; filename=\"Antseed-Neobanks-Offering.pdf\""}]}]}
JSON
  printf '.env*\ndeployment.json\n' >"$target/.vercelignore"
  if ! test -f "$target/.vercel/project.json"; then
    (cd "$target"; vercel link --project "$project" --scope "$scope" --yes --local-config "$target/vercel.json")
  fi
  python3 - "$target/.vercel/project.json" "$project" <<'PY'
import json, sys
with open(sys.argv[1]) as handle:
    linked = json.load(handle)
if linked.get('projectName') != sys.argv[2]:
    raise SystemExit('Deployment folder is linked to the wrong Vercel project.')
PY
  # Change the real working directory as well as pinning the config, so the
  # repository-root CRM functions configuration cannot leak into this deploy.
  (cd "$target"; vercel deploy --prod --yes --scope "$scope" --local-config "$target/vercel.json")
done

python3 - "$source_file" "$pdf_file" <<'PY'
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
from pathlib import Path
import sys, urllib.request

expected = {'/': sha256(Path(sys.argv[1]).read_bytes()).hexdigest(),
            '/Antseed-Neobanks-Offering.pdf': sha256(Path(sys.argv[2]).read_bytes()).hexdigest()}
jobs = [(f'https://{project}.vercel.app', route)
        for project in ('antseed-neobanks-presentation', 'antseed-neobanks-offering')
        for route in expected]

def verify(job):
    base, route = job
    with urllib.request.urlopen(base + route, timeout=60) as response:
        actual = sha256(response.read()).hexdigest()
    if actual != expected[route]:
        raise RuntimeError(f'Live file differs from the source: {base + route}')

with ThreadPoolExecutor(max_workers=4) as executor:
    list(executor.map(verify, jobs))
print('Verified live HTML and PDF on both URLs:')
print('https://antseed-neobanks-presentation.vercel.app/')
print('https://antseed-neobanks-offering.vercel.app/')
PY
