#!/usr/bin/env bash
# Deploy the Threadbot backend to a FREE Hugging Face Space (Docker SDK, no credit card,
# 16GB RAM). Reads keys from .env, sets them as Space secrets, pushes the code.
#   HF_TOKEN=hf_xxxxx bash scripts/deploy-hf.sh
set -euo pipefail

: "${HF_TOKEN:?set HF_TOKEN (a free Hugging Face write token)}"
SPACE_NAME="${SPACE_NAME:-threadbot-backend}"
API="https://huggingface.co/api"

USER=$(curl -s -H "Authorization: Bearer $HF_TOKEN" "$API/whoami-v2" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("name",""))
except Exception: print("")')
[ -n "$USER" ] || { echo "bad HF token (whoami failed)"; exit 1; }
echo "HF user: $USER   space: $USER/$SPACE_NAME"

# Create the space (public so the phone can reach the API; protected by Supabase JWT).
curl -s -X POST "$API/repos/create" -H "Authorization: Bearer $HF_TOKEN" -H "Content-Type: application/json" \
  -d "{\"type\":\"space\",\"name\":\"$SPACE_NAME\",\"sdk\":\"docker\",\"private\":false}" >/dev/null || true

getenv() { local v; v=$(grep "^$1=" .env | head -1 | cut -d= -f2-); v="${v%\"}"; v="${v#\"}"; printf '%s' "$v"; }
set_secret() {
  curl -s -X POST "$API/spaces/$USER/$SPACE_NAME/secrets" -H "Authorization: Bearer $HF_TOKEN" \
    -H "Content-Type: application/json" -d "{\"key\":\"$1\",\"value\":$(printf '%s' "$2" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')}" >/dev/null
}
for k in PRINTFUL_API_KEY PRINTFUL_STORE_ID OPENAI_API_KEY SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY SUPABASE_BUCKET GENERATE_VARIATIONS; do
  set_secret "$k" "$(getenv "$k")"; echo "  secret set: $k"
done

TMP=$(mktemp -d)
for attempt in 1 2 3 4 5; do
  git clone --quiet "https://user:$HF_TOKEN@huggingface.co/spaces/$USER/$SPACE_NAME" "$TMP/space" && break
  echo "clone retry $attempt..."; sleep 3
done
cp Dockerfile package.json tsconfig.json "$TMP/space/"
[ -f package-lock.json ] && cp package-lock.json "$TMP/space/" || true
cp -r src data "$TMP/space/"
cat > "$TMP/space/README.md" <<EOF
---
title: Threadbot Backend
emoji: "🧵"
colorFrom: blue
colorTo: green
sdk: docker
app_port: 3000
---
Threadbot generation API.
EOF
( cd "$TMP/space" && git add -A && git -c user.email=deploy@threadbot.app -c user.name=threadbot commit -q -m "deploy backend" && git push -q )

SUB=$(printf '%s-%s' "$USER" "$SPACE_NAME" | tr '[:upper:]' '[:lower:]')
echo "https://${SUB}.hf.space" > /tmp/hf_url.txt
echo "BUILDING. URL: https://${SUB}.hf.space"
echo "(first build takes a few minutes; then set app_config.backend_url to .../generate)"
