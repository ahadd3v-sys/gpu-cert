#!/usr/bin/env bash
# Boots the site against a throwaway database and exercises it end to end:
# ingest, attestation, the certificate page, signature verification, tamper
# detection, feedback, and the redirect guard.
set -euo pipefail
cd "$(dirname "$0")/.."

SCRATCH=$(mktemp -d)
SERVER=""
# Killed as a process group: the server is started under `setsid`, because
# `npx` spawns the real node process as a child and killing only the npx
# wrapper would leave a dev server holding the port after every run.
cleanup() { [ -n "$SERVER" ] && kill -- "-$SERVER" 2>/dev/null; rm -rf "$SCRATCH"; return 0; }
trap cleanup EXIT

# Throwaway signing key for the smoke run; production secrets are never touched.
eval "$(node -e '
const {generateKeyPairSync}=require("crypto");
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const esc=s=>JSON.stringify(s);
console.log("export CERT_SIGNING_PRIVATE_KEY="+esc(privateKey.export({type:"pkcs8",format:"pem"}).toString()));
console.log("export CERT_SIGNING_PUBLIC_KEY="+esc(publicKey.export({type:"spki",format:"pem"}).toString()));
')"
export DATABASE_URL="file:$SCRATCH/smoke.db"
export AUTH_SECRET="smoke-test-secret-not-a-real-one"
export PUBLIC_BASE_URL="http://localhost:3111"
export SMOKE_BASE="http://localhost:3111"
export PORT=3111

setsid npx tsx src/dev.ts > "$SCRATCH/server.log" 2>&1 &
SERVER=$!

for _ in $(seq 1 40); do
  curl -sf "http://localhost:3111/" -o /dev/null && break
  sleep 0.5
done

pass=0; fail=0
check() { if [ "$2" = "1" ]; then echo "  ok    $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
has()   { grep -qF "$2" <<<"$1" && echo 1 || echo 0; }
kit()   { node scripts/testkit.mjs "$@"; }

FP="c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"

# A clean 16-minute run. pixels_checked is frames * 65536 because the render
# test checks every pixel of every frame; the backend knows that relationship
# and rejects payloads where it doesn't hold.
report() {
  local session_id="$1" nonce="$2" errors="${3:-0}" mismatches="${4:-0}" frames="${5:-2700}"
  cat <<JSON
{"attestation":{"session_id":"$session_id","nonce":"$nonce"},
"client_version":"0.4.0","device_name":"AMD Radeon RX 6600","pcie_link_width_current":8,"pcie_link_width_max":8,
"fingerprint":{"uuid":"PCI_VEN_1002&DEV_73FF","pci_device_id":29695,"vram_total_bytes":8573157376,"vbios_version":"113-EXT47001-002","hash":"$FP"},
"stress_test":{"dispatch_count":513,"duration_ms":300000,"telemetry_series":[{"elapsed_ms":1000,"temperature_c":58,"power_draw_mw":100000,"graphics_clock_mhz":2000,"memory_clock_mhz":1750,"utilization_pct":99}],"aborted_for_safety":false},
"vram_test":{"passes_run":12563,"total_errors":$errors,"bytes_tested":7287183768,"duration_ms":600000,"aborted_for_safety":false},
"fur_test":{"frames_rendered":$frames,"duration_ms":45000,"mismatches":$mismatches,"pixels_checked":$(( frames * 65536 )),"aborted_for_safety":false}}
JSON
}

post_report() { curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3111/api/certify -H 'content-type: application/json' -d "$1"; }
post_report_body() { curl -s -X POST http://localhost:3111/api/certify -H 'content-type: application/json' -d "$1"; }
id_of() { node -e "process.stdout.write(JSON.parse(process.argv[1]).report_url.split('/').pop())" "$1"; }

echo "attestation:"

# The whole point. Before this existed, this exact request produced a genuine,
# verifying certificate.
NO_SESSION=$(sed 's/"attestation":{[^}]*},//' <<<"$(report x y)")
check "a report with no session is refused" "$([ "$(post_report "$NO_SESSION")" = "426" ] && echo 1 || echo 0)"

read -r SID NONCE <<<"$(kit start "$FP")"
check "a session can be opened" "$([ -n "$SID" ] && echo 1 || echo 0)"

# A session opened seconds ago cannot have witnessed 16 minutes of testing.
# This is the check that costs a forger real time.
check "a fresh session can't claim 16 minutes of testing" \
  "$([ "$(post_report "$(report "$SID" "$NONCE")")" = "403" ] && echo 1 || echo 0)"

# Same session, moved back in time, with heartbeats recorded.
kit backdate "$SID" 1000 9 >/dev/null
RESP=$(post_report_body "$(report "$SID" "$NONCE")")
PASS_ID=$(id_of "$RESP")
check "an attested run is accepted" "$([ -n "$PASS_ID" ] && echo 1 || echo 0)"
check "the session is single use" \
  "$([ "$(post_report "$(report "$SID" "$NONCE")")" = "409" ] && echo 1 || echo 0)"

# Internal consistency: pixels_checked is bound to frames_rendered, so a
# hand-picked pair trips over itself even with a valid session.
read -r SID2 NONCE2 <<<"$(kit start "$FP")"
kit backdate "$SID2" 1000 9 >/dev/null
BAD_PIXELS=$(sed 's/"pixels_checked":[0-9]*/"pixels_checked":999999/' <<<"$(report "$SID2" "$NONCE2")")
check "impossible pixel counts are refused" \
  "$([ "$(post_report "$BAD_PIXELS")" = "403" ] && echo 1 || echo 0)"

# A session opened for one card can't file a report for another.
read -r SID3 NONCE3 <<<"$(kit start "$FP")"
kit backdate "$SID3" 1000 9 >/dev/null
OTHER_CARD=$(sed "s/$FP/d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2d2/" <<<"$(report "$SID3" "$NONCE3")")
check "a report for a different card is refused" \
  "$([ "$(post_report "$OTHER_CARD")" = "403" ] && echo 1 || echo 0)"

echo ""
echo "certificate:"
PAGE=$(curl -s "http://localhost:3111/r/$PASS_ID")
check "certificate page renders" "$(has "$PAGE" "Certificate of Hardware Verification")"
check "certificate shows PASS" "$(has "$PAGE" ">PASS<")"
check "certificate links to verification" "$(has "$PAGE" "check this signature")"

NUM="GPUC-$(echo "${PASS_ID:0:8}" | tr 'a-z' 'A-Z')"
check "verify by certificate number" "$(has "$(curl -s "http://localhost:3111/verify/$NUM")" "Signature valid")"
check "verify by full report id" "$(has "$(curl -s "http://localhost:3111/verify?reference=$PASS_ID")" "Signature valid")"
check "unknown certificate reports not found" "$(has "$(curl -s "http://localhost:3111/verify?reference=GPUC-DEADBEEF")" "No certificate found")"
check "public key is published" "$(has "$(curl -s http://localhost:3111/.well-known/gpu-cert-key.pem)" "BEGIN PUBLIC KEY")"

kit tamper "$PASS_ID" device_name "NVIDIA GeForce RTX 4090" >/dev/null
check "tampered certificate reports invalid" "$(has "$(curl -s "http://localhost:3111/verify/$NUM")" "Signature does not match")"

echo ""
echo "verdicts:"
read -r SID4 NONCE4 <<<"$(kit start "$FP")"
kit backdate "$SID4" 1000 9 >/dev/null
FAIL_ID=$(id_of "$(post_report_body "$(report "$SID4" "$NONCE4" 0 3)")")
PAGE2=$(curl -s "http://localhost:3111/r/$FAIL_ID")
check "3 wrong pixels out of 176m fails the card" "$(has "$PAGE2" ">FAIL<")"
check "failure reason is stated" "$(has "$PAGE2" "pixels computed incorrectly")"

echo ""
echo "site:"
check "home renders" "$(has "$(curl -s http://localhost:3111/)" "Prove the card works")"
check "verify is in the nav" "$(has "$(curl -s http://localhost:3111/)" 'href="/verify"')"
check "open source is surfaced" "$(has "$(curl -s http://localhost:3111/)" "Open source on GitHub")"
check "login renders" "$(has "$(curl -s http://localhost:3111/login)" "Log in")"
check "badge renders as png" "$(curl -s -o /dev/null -w '%{content_type}' "http://localhost:3111/r/$FAIL_ID/badge" | grep -q image && echo 1 || echo 0)"
check "open redirect is blocked" "$(curl -s "http://localhost:3111/login?next=https://evil.example" | grep -q 'value="https://evil.example"' && echo 0 || echo 1)"
check "unknown report 404s" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3111/r/00000000-0000-0000-0000-000000000000 | grep -q 404 && echo 1 || echo 0)"

echo ""
echo "feedback:"
check "feedback page renders" "$(has "$(curl -s http://localhost:3111/feedback)" "Tell us what went wrong")"
curl -s -o /dev/null -X POST http://localhost:3111/feedback \
  --data-urlencode "message=The VRAM test only covered half my card" \
  --data-urlencode "console_output=testing 4032 MB of 8176 MB VRAM (49%)"
check "feedback is stored" "$([ "$(kit count feedback)" = "1" ] && echo 1 || echo 0)"
curl -s -o /dev/null -X POST http://localhost:3111/feedback \
  --data-urlencode "message=this is spam from a bot filling every field" \
  --data-urlencode "website=http://spam.example"
check "honeypot submissions are dropped" "$([ "$(kit count feedback)" = "1" ] && echo 1 || echo 0)"
curl -s -o /dev/null -X POST http://localhost:3111/feedback --data-urlencode "message=short"
check "too-short feedback is refused" "$([ "$(kit count feedback)" = "1" ] && echo 1 || echo 0)"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
