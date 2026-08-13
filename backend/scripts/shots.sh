#!/usr/bin/env bash
# Boots the site against a throwaway DB, seeds one passing and one failing
# certificate, and screenshots the main pages at desktop width.
#
# Layout work on this site is hard to judge from source: the certificate is a
# fixed-shape document and the question is always how it sits in the viewport,
# which only a render answers.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=${1:-/tmp/gpu-cert-shots}
WIDTH=${WIDTH:-1680}
HEIGHT=${HEIGHT:-1200}
mkdir -p "$OUT"

SCRATCH=$(mktemp -d)
SERVER=""
cleanup() { [ -n "$SERVER" ] && kill -- "-$SERVER" 2>/dev/null; rm -rf "$SCRATCH"; return 0; }
trap cleanup EXIT

eval "$(node -e '
const {generateKeyPairSync}=require("crypto");
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const esc=s=>JSON.stringify(s);
console.log("export CERT_SIGNING_PRIVATE_KEY="+esc(privateKey.export({type:"pkcs8",format:"pem"}).toString()));
console.log("export CERT_SIGNING_PUBLIC_KEY="+esc(publicKey.export({type:"spki",format:"pem"}).toString()));
')"
export DATABASE_URL="file:$SCRATCH/shots.db"
export AUTH_SECRET="screenshot-secret"
export PUBLIC_BASE_URL="http://localhost:3112"
export PORT=3112
export SMOKE_BASE="http://localhost:3112"

setsid npx tsx src/dev.ts > "$SCRATCH/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 1 40); do curl -sf "http://localhost:3112/" -o /dev/null && break; sleep 0.5; done

PASS=$(cat <<'JSON'
{"client_version":"0.3.1","device_name":"AMD Radeon RX 6600","pcie_link_width_current":8,"pcie_link_width_max":8,
"fingerprint":{"uuid":"PCI_VEN_1002&DEV_73FF&SUBSYS_50221462&REV_C7","pci_device_id":29695,"vram_total_bytes":8573157376,"vbios_version":"113-EXT47001-002","hash":"9f2c41ab7d3e5580c6a1fe94b20d7738aa4c15e6039bd82f7ce4a1069d35bb47"},
"stress_test":{"dispatch_count":513,"duration_ms":300000,"telemetry_series":[{"elapsed_ms":30000,"temperature_c":54,"power_draw_mw":98000,"graphics_clock_mhz":2044,"memory_clock_mhz":1750,"utilization_pct":99},{"elapsed_ms":150000,"temperature_c":57,"power_draw_mw":101000,"graphics_clock_mhz":2038,"memory_clock_mhz":1750,"utilization_pct":100},{"elapsed_ms":290000,"temperature_c":58,"power_draw_mw":100000,"graphics_clock_mhz":2035,"memory_clock_mhz":1750,"utilization_pct":99}],"aborted_for_safety":false},
"vram_test":{"passes_run":12563,"total_errors":0,"bytes_tested":7287183768,"duration_ms":600072,"aborted_for_safety":false},
"fur_test":{"frames_rendered":3151,"duration_ms":45000,"mismatches":0,"pixels_checked":206503936,"aborted_for_safety":false}}
JSON
)
FAIL=$(sed -e 's/"total_errors":0/"total_errors":48213/' -e 's/"mismatches":0/"mismatches":9044/' -e 's/"pcie_link_width_current":8/"pcie_link_width_current":4/' -e 's/"pcie_link_width_max":8/"pcie_link_width_max":16/' <<<"$PASS")

# Reports now have to be attested to a real test session, so seeding one means
# opening a session and moving its start time back the way the smoke test does.
# Screenshots are of the certificate, not of the ingest rules, but going through
# the real endpoint keeps these renders honest about what the product accepts.
FP=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).fingerprint.hash)" "$PASS")

post() {
  read -r sid nonce <<<"$(npx tsx scripts/testkit.ts start "$FP")"
  npx tsx scripts/testkit.ts backdate "$sid" 1000 9 >/dev/null
  local body
  body=$(node -e '
    const r = JSON.parse(process.argv[1]);
    r.attestation = { session_id: process.argv[2], nonce: process.argv[3] };
    process.stdout.write(JSON.stringify(r));
  ' "$1" "$sid" "$nonce")
  curl -s -X POST http://localhost:3112/api/certify -H 'content-type: application/json' -d "$body" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).report_url.split('/').pop()))"
}

PASS_ID=$(post "$PASS")
FAIL_ID=$(post "$FAIL")

shot() {
  google-chrome --headless --disable-gpu --hide-scrollbars --no-sandbox \
    --window-size="$WIDTH,$HEIGHT" --screenshot="$OUT/$1.png" \
    --virtual-time-budget=3000 "$2" >/dev/null 2>&1
}

# The dashboard needs a session, so it is fetched with a cookie jar and
# screenshotted from a file. All CSS and fonts are inlined, so the saved HTML
# renders standalone.
JAR="$SCRATCH/cookies"
curl -s -c "$JAR" -b "$JAR" -X POST http://localhost:3112/signup \
  --data-urlencode "email=shots@example.com" --data-urlencode "username=hafeezpchub" --data-urlencode "password=screenshots123" -o /dev/null
curl -s -b "$JAR" -X POST "http://localhost:3112/r/$PASS_ID/claim" -o /dev/null
curl -s -b "$JAR" -X POST "http://localhost:3112/r/$FAIL_ID/claim" -o /dev/null
# A little traffic, so the "who is looking" panel renders with real numbers
# instead of its empty state.
BROWSER="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
for i in $(seq 1 9);  do curl -s -o /dev/null -A "$BROWSER$i" -e "https://www.reddit.com/r/hardwareswap/x" "http://localhost:3112/r/$PASS_ID"; done
for i in $(seq 1 4);  do curl -s -o /dev/null -A "$BROWSER$i" -e "https://www.ebay.com/itm/123"            "http://localhost:3112/r/$PASS_ID"; done
for i in $(seq 1 3);  do curl -s -o /dev/null -A "$BROWSER$i" "http://localhost:3112/r/$FAIL_ID"; done
for i in $(seq 1 26); do curl -s -o /dev/null -A "$BROWSER$i" "http://localhost:3112/r/$PASS_ID/badge"; done

curl -s -b "$JAR" http://localhost:3112/dashboard -o "$SCRATCH/dashboard.html"

shot "cert-pass"  "http://localhost:3112/r/$PASS_ID"
shot "cert-fail"  "http://localhost:3112/r/$FAIL_ID"
shot "home"       "http://localhost:3112/"
shot "verify"     "http://localhost:3112/verify/GPUC-$(echo "${PASS_ID:0:8}" | tr 'a-z' 'A-Z')"
shot "feedback"   "http://localhost:3112/feedback"
shot "dashboard"  "file://$SCRATCH/dashboard.html"

echo "wrote to $OUT at ${WIDTH}x${HEIGHT}:"
ls -1 "$OUT"
