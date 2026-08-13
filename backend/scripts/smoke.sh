#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

SCRATCH=$(mktemp -d)
SERVER=""
# One trap, not two: a second `trap ... EXIT` replaces the first rather than
# adding to it, which would leave the dev server running after the script ends.
# Killed as a process group: the server is started under `setsid`, because
# `npx` spawns the real node process as a child and killing only the npx
# wrapper would leave a dev server holding port 3111 after every run.
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
export PORT=3111

setsid npx tsx src/dev.ts > "$SCRATCH/server.log" 2>&1 &
SERVER=$!

for i in $(seq 1 40); do
  curl -sf "http://localhost:3111/" -o /dev/null && break
  sleep 0.5
done

pass=0; fail=0
check() { if [ "$2" = "1" ]; then echo "  ok    $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
has()   { grep -qF "$2" <<<"$1" && echo 1 || echo 0; }

echo "smoke test:"

# --- a clean report ingests and passes
CLEAN=$(cat <<'JSON'
{"client_version":"0.2.0","device_name":"NVIDIA GeForce RTX 4070","pcie_link_width_current":16,"pcie_link_width_max":16,
"fingerprint":{"uuid":"GPU-smoke-0001","pci_device_id":8961,"vram_total_bytes":12884901888,"vbios_version":"95.06.18.00.10","hash":"c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"},
"stress_test":{"dispatch_count":480000,"duration_ms":300000,"telemetry_series":[],"aborted_for_safety":false},
"vram_test":{"passes_run":4,"total_errors":0,"bytes_tested":10952835072,"duration_ms":600000,"aborted_for_safety":false},
"fur_test":{"frames_rendered":2700,"duration_ms":45000,"mismatches":0,"pixels_checked":176947200,"aborted_for_safety":false}}
JSON
)
RESP=$(curl -s -X POST http://localhost:3111/api/certify -H 'content-type: application/json' -d "$CLEAN")
ID=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).report_url.split('/').pop())" "$RESP")
check "clean report ingests" "$([ -n "$ID" ] && echo 1 || echo 0)"

PAGE=$(curl -s "http://localhost:3111/r/$ID")
check "certificate page renders" "$(has "$PAGE" "Certificate of Hardware Verification")"
check "certificate shows PASS" "$(has "$PAGE" ">PASS<")"
check "certificate links to verification" "$(has "$PAGE" "check this signature")"
check "certificate says 'Pixels checked'" "$(has "$PAGE" "Pixels checked")"

# --- verification
NUM="GPUC-$(echo "${ID:0:8}" | tr 'a-z' 'A-Z')"
V=$(curl -s "http://localhost:3111/verify/$NUM")
check "verify by certificate number" "$(has "$V" "Signature valid")"
V2=$(curl -s "http://localhost:3111/verify?reference=$ID")
check "verify by full report id" "$(has "$V2" "Signature valid")"
V3=$(curl -s "http://localhost:3111/verify?reference=GPUC-DEADBEEF")
check "unknown certificate reports not found" "$(has "$V3" "No certificate found")"
KEY=$(curl -s http://localhost:3111/.well-known/gpu-cert-key.pem)
check "public key is published" "$(has "$KEY" "BEGIN PUBLIC KEY")"

# --- tampering is caught by the real endpoint, not just the unit test
node -e '
const {createClient}=require("@libsql/client");
(async()=>{const c=createClient({url:process.env.DATABASE_URL});
await c.execute({sql:"UPDATE reports SET vram_total_errors = 0, verdict = ? WHERE id = ?",args:["Pass",process.argv[1]]});})()
' "$ID" >/dev/null 2>&1 || true
node -e '
const {createClient}=require("@libsql/client");
(async()=>{const c=createClient({url:process.env.DATABASE_URL});
await c.execute({sql:"UPDATE reports SET device_name = ? WHERE id = ?",args:["NVIDIA GeForce RTX 4090",process.argv[1]]});})()
' "$ID"
VT=$(curl -s "http://localhost:3111/verify/$NUM")
check "tampered certificate reports invalid" "$(has "$VT" "Signature does not match")"

# --- a failing report
BAD=$(sed 's/"mismatches":0/"mismatches":3/' <<<"$CLEAN")
RESP2=$(curl -s -X POST http://localhost:3111/api/certify -H 'content-type: application/json' -d "$BAD")
ID2=$(node -e "process.stdout.write(JSON.parse(process.argv[1]).report_url.split('/').pop())" "$RESP2")
PAGE2=$(curl -s "http://localhost:3111/r/$ID2")
check "3 wrong pixels out of 176m fails the card" "$(has "$PAGE2" ">FAIL<")"
check "failure reason is stated" "$(has "$PAGE2" "pixels computed incorrectly")"

# --- other routes
check "home renders" "$(has "$(curl -s http://localhost:3111/)" "Prove the card works")"
check "verify is in the nav" "$(has "$(curl -s http://localhost:3111/)" 'href="/verify"')"
check "login renders" "$(has "$(curl -s http://localhost:3111/login)" "Log in")"
check "badge renders as png" "$(curl -s -o /dev/null -w '%{content_type}' "http://localhost:3111/r/$ID2/badge" | grep -q image && echo 1 || echo 0)"
check "open redirect is blocked" "$(curl -s "http://localhost:3111/login?next=https://evil.example" | grep -q 'value="https://evil.example"' && echo 0 || echo 1)"
check "unknown report 404s" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3111/r/00000000-0000-0000-0000-000000000000 | grep -q 404 && echo 1 || echo 0)"

# Proves these results came from the server this script started against its
# own throwaway database, rather than from something already holding the port
# with older code. Exactly the two reports created above, no more.
COUNT=$(node -e '
const {createClient}=require("@libsql/client");
(async()=>{const c=createClient({url:process.env.DATABASE_URL});
const r=await c.execute("SELECT COUNT(*) AS n FROM reports");
process.stdout.write(String(r.rows[0].n));})()
')
check "tested this run's own server (2 reports in its db)" "$([ "$COUNT" = "2" ] && echo 1 || echo 0)"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
