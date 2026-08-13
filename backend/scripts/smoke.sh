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
kit()   { npx tsx scripts/testkit.ts "$@"; }

FP="c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1"
# Read from the backend's own constant rather than hardcoded, so raising the
# floor does not silently turn every payload below into a rejected one.
CURRENT=$(node -e 'const s=require("fs").readFileSync("lib/client-version.ts","utf8");process.stdout.write(s.match(/MIN_CLIENT_VERSION = "([^"]+)"/)[1])')
OUTDATED="0.4.0"

# A clean 16-minute run. pixels_checked is frames * 65536 because the render
# test checks every pixel of every frame; the backend knows that relationship
# and rejects payloads where it doesn't hold.
report() {
  local session_id="$1" nonce="$2" errors="${3:-0}" mismatches="${4:-0}" frames="${5:-2700}"
  cat <<JSON
{"attestation":{"session_id":"$session_id","nonce":"$nonce"},
"client_version":"$CURRENT","device_name":"AMD Radeon RX 6600","pcie_link_width_current":8,"pcie_link_width_max":8,
"fingerprint":{"uuid":"PCI_VEN_1002&DEV_73FF","pci_device_id":29695,"vram_total_bytes":8573157376,"vbios_version":"113-EXT47001-002","hash":"$FP"},
"stress_test":{"dispatch_count":513,"duration_ms":300000,"telemetry_series":[{"elapsed_ms":1000,"temperature_c":58,"power_draw_mw":100000,"graphics_clock_mhz":2000,"memory_clock_mhz":1750,"utilization_pct":99}],"aborted_for_safety":false},
"vram_test":{"passes_run":12563,"total_errors":$errors,"bytes_tested":7287183768,"duration_ms":300000,"aborted_for_safety":false},
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
# The client is told nothing useful on purpose, so the reason has to survive
# somewhere. Without this it lived only in a platform log that had rotated by
# the time a real rejection needed explaining.
check "the reason a report was refused is recorded against the session" \
  "$(kit session-field "$SID" rejection | grep -qi "session was only open" && echo 1 || echo 0)"
check "the refusal itself still tells the client nothing useful" \
  "$(curl -s -X POST http://localhost:3111/api/certify -H 'content-type: application/json' -d "$(report "$SID" "$NONCE")" | grep -qi "wall\|heartbeat\|fingerprint" && echo 0 || echo 1)"

# Same session, moved back in time, with heartbeats recorded.
kit backdate "$SID" 1000 9 >/dev/null
RESP=$(post_report_body "$(report "$SID" "$NONCE")")
PASS_ID=$(id_of "$RESP")
check "an attested run is accepted" "$([ -n "$PASS_ID" ] && echo 1 || echo 0)"
# The exe prints this rather than recomputing pass/fail, so if it ever stops
# being returned the console starts disagreeing with the certificate.
check "the response carries the verdict for the client to print" \
  "$(has "$RESP" '"verdict":"Pass"')"
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
# Served as text so a browser shows it, rather than downloading a file the
# operating system cannot open.
check "the key displays in a browser rather than downloading"   "$(curl -s -D- -o /dev/null http://localhost:3111/.well-known/gpu-cert-key.pem | grep -qi 'content-type: text/plain' && echo 1 || echo 0)"
check "the verify page shows the key inline"   "$(has "$(curl -s http://localhost:3111/verify)" 'BEGIN PUBLIC KEY')"
check "the verify page does not link the key as a file"   "$(curl -s http://localhost:3111/verify | grep -q 'href="/.well-known' && echo 0 || echo 1)"

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
check "the source is surfaced" "$(has "$(curl -s http://localhost:3111/)" "Read the source")"
check "early access is stated up front" "$(has "$(curl -s http://localhost:3111/)" "Early access")"
# Never on the certificate: a buyer checking a stranger's card needs the
# document to read as settled.
check "the certificate says nothing about beta" "$(curl -s "http://localhost:3111/r/$PASS_ID" | grep -qi "early access\|beta" && echo 0 || echo 1)"
check "login renders" "$(has "$(curl -s http://localhost:3111/login)" "Log in")"
# The site name is appended to every title so a truncated tab is still
# identifiable, which on the home page used to read "GPU Cert, GPU Cert".
check "the home tab is not named twice" \
  "$(has "$(curl -s http://localhost:3111/)" "<title>GPU Cert</title>")"
check "an inner page is named before the site" \
  "$(has "$(curl -s http://localhost:3111/verify)" "<title>Verify a certificate, GPU Cert</title>")"
# FAIL_ID, not PASS_ID: the latter has had its device name tampered by then to
# prove signature checking works, so its title no longer matches the card.
check "a certificate is named by its card" \
  "$(has "$(curl -s "http://localhost:3111/r/$FAIL_ID")" "<title>AMD Radeon RX 6600, GPU Cert</title>")"
# A recovery flow nobody can find is the same as not having one.
check "login links to password reset" "$(has "$(curl -s http://localhost:3111/login)" 'href="/forgot-password"')"
check "badge renders as png" "$(curl -s -o /dev/null -w '%{content_type}' "http://localhost:3111/r/$FAIL_ID/badge" | grep -q image && echo 1 || echo 0)"
check "open redirect is blocked" "$(curl -s "http://localhost:3111/login?next=https://evil.example" | grep -q 'value="https://evil.example"' && echo 0 || echo 1)"
# One canonical host: the same certificate must not live at several addresses.
check "a non-canonical host is redirected" \
  "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: www.example.test' http://localhost:3111/verify | grep -q 308 && echo 1 || echo 0)"
check "the API is never redirected, so older clients keep working" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Host: www.example.test' -H 'content-type: application/json' -d '{}' http://localhost:3111/api/certify | grep -q 400 && echo 1 || echo 0)"

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
echo "debug-length runs:"
# --fast exists for iterating on the client and prints "not a real
# certificate". The server used to disagree and sign one anyway.
read -r FSID FNONCE <<<"$(kit start "$FP")"
kit backdate "$FSID" 1000 9 >/dev/null
FAST=$(report "$FSID" "$FNONCE" \
  | sed 's/"duration_ms":300000/"duration_ms":20000/' \
  | sed 's/"duration_ms":45000/"duration_ms":10000/')
check "a --fast run cannot be certified" \
  "$([ "$(post_report "$FAST")" = "422" ] && echo 1 || echo 0)"
check "the refusal names the flag to drop" \
  "$(curl -s -X POST http://localhost:3111/api/certify -H 'content-type: application/json' -d "$FAST" | grep -qi "without --fast" && echo 1 || echo 0)"

# A run stopped by the safety watchdog is legitimately short, and it is the
# most important result the tool produces. It must still certify.
read -r ASID ANONCE <<<"$(kit start "$FP")"
kit backdate "$ASID" 1000 9 >/dev/null
ABORTED=$(report "$ASID" "$ANONCE" \
  | sed 's/"duration_ms":300000/"duration_ms":20000/' \
  | sed 's/"duration_ms":45000/"duration_ms":10000/' \
  | sed 's/"aborted_for_safety":false/"aborted_for_safety":true/g')
check "a run aborted for safety still certifies" \
  "$([ "$(post_report "$ABORTED")" = "200" ] && echo 1 || echo 0)"

echo ""
echo "client version floor:"
# Superseded builds are refused at the start of a run rather than after it,
# because a report from a client with a known bug is worse than no report.
OLDSTART=$(curl -s -w '\n%{http_code}' -X POST http://localhost:3111/api/session/start \
  -H 'content-type: application/json' \
  -d '{"client_version":"'$OUTDATED'","device_name":"AMD Radeon RX 6600","fingerprint_hash":"'$FP'"}')
check "an outdated client cannot open a session" \
  "$([ "$(echo "$OLDSTART" | tail -1)" = "426" ] && echo 1 || echo 0)"
check "the refusal says where to get the current release" \
  "$([ "$(echo "$OLDSTART" | grep -c 'gpucert.com')" = "1" ] && echo 1 || echo 0)"

CURSTART=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:3111/api/session/start \
  -H 'content-type: application/json' \
  -d '{"client_version":"'$CURRENT'","device_name":"AMD Radeon RX 6600","fingerprint_hash":"'$FP'"}')
check "a current client can open a session" "$([ "$CURSTART" = "200" ] && echo 1 || echo 0)"

# The floor is NOT re-checked at submission. Raising it while a run is in
# flight would otherwise refuse a finished sixteen minute test at the last
# step, which is exactly what happened to a real RX 6600 run. What is checked
# is that the report speaks for the same version that opened the session, so
# the relaxation cannot be used to launder an old client's report.
read -r OSID ONONCE <<<"$(curl -s -X POST http://localhost:3111/api/session/start -H 'content-type: application/json' \
  -d '{"client_version":"'$CURRENT'","device_name":"AMD Radeon RX 6600","fingerprint_hash":"'$FP'"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.session_id+' '+j.nonce)})")"
kit backdate "$OSID" 1000 9 >/dev/null
check "a report cannot claim a version the session did not open with" \
  "$([ "$(post_report "$(report "$OSID" "$ONONCE" | sed "s/\"client_version\":\"$CURRENT\"/\"client_version\":\"$OUTDATED\"/")")" = "403" ] && echo 1 || echo 0)"

# The run that motivated all of this: session opened, tests done, and the
# submission must still be accepted.
read -r ISID INONCE <<<"$(curl -s -X POST http://localhost:3111/api/session/start -H 'content-type: application/json' \
  -d '{"client_version":"'$CURRENT'","device_name":"AMD Radeon RX 6600","fingerprint_hash":"'$FP'"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.session_id+' '+j.nonce)})")"
kit backdate "$ISID" 1000 9 >/dev/null
check "a run already in flight can still file after the floor moves" \
  "$([ "$(post_report "$(report "$ISID" "$INONCE")")" = "200" ] && echo 1 || echo 0)"

echo ""
echo "run diagnostics:"
# A session carries the machine's environment before any testing happens, so a
# run that later hangs has still said where it was.
ENVJSON='{"client_version":"'$CURRENT'","device_name":"AMD Radeon RX 6600","fingerprint_hash":"'$FP'","environment":{"os":"windows","vulkan":{"count":2,"devices":[{"name":"Quadro T2000"},{"name":"Intel UHD"}]}}}'
read -r DSID DNONCE <<<"$(curl -s -X POST http://localhost:3111/api/session/start -H 'content-type: application/json' -d "$ENVJSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.session_id+' '+j.nonce)})")"
check "the environment is stored with the session" \
  "$([ "$(kit session-field "$DSID" environment | grep -c 'Quadro T2000')" = "1" ] && echo 1 || echo 0)"

curl -s -o /dev/null -X POST http://localhost:3111/api/session/progress -H 'content-type: application/json' \
  -d "{\"session_id\":\"$DSID\",\"nonce\":\"$DNONCE\",\"log\":[\"=== stress test ===\",\"first line\"]}"
curl -s -o /dev/null -X POST http://localhost:3111/api/session/progress -H 'content-type: application/json' \
  -d "{\"session_id\":\"$DSID\",\"nonce\":\"$DNONCE\",\"log\":[\"second line\"]}"
check "heartbeats append to the run log rather than replacing it" \
  "$([ "$(kit session-field "$DSID" run_log | grep -c 'line')" = "2" ] && echo 1 || echo 0)"

# The whole point: a run that dies still explains itself.
curl -s -o /dev/null -X POST http://localhost:3111/api/session/failed -H 'content-type: application/json' \
  -d "{\"session_id\":\"$DSID\",\"nonce\":\"$DNONCE\",\"error\":\"panic: attempt to subtract with overflow\",\"log\":[\"=== VRAM pattern test ===\",\"boom\"]}"
check "a crashed run records why it died" \
  "$(kit session-field "$DSID" failure | grep -q 'subtract with overflow' && echo 1 || echo 0)"
check "the failure keeps the log that led to it" \
  "$(kit session-field "$DSID" run_log | grep -q 'VRAM pattern test' && echo 1 || echo 0)"

echo ""
echo "view tracking:"
BROWSER="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
curl -s -o /dev/null -A "$BROWSER" -e "https://www.reddit.com/r/hardwareswap/comments/x" "http://localhost:3111/r/$PASS_ID"
check "a real visit is counted" "$([ "$(kit views "$PASS_ID" page)" = "1" ] && echo 1 || echo 0)"
check "the referring site is recorded" "$([ "$(kit referrers "$PASS_ID")" = "reddit.com" ] && echo 1 || echo 0)"

# curl's own UA matches the crawler filter, as do Discord and Slack unfurls.
curl -s -o /dev/null "http://localhost:3111/r/$PASS_ID"
curl -s -o /dev/null -A "Mozilla/5.0 (compatible; Discordbot/2.0)" "http://localhost:3111/r/$PASS_ID"
check "crawlers and link previews are not counted" "$([ "$(kit views "$PASS_ID" page)" = "1" ] && echo 1 || echo 0)"

curl -s -o /dev/null -A "$BROWSER" "http://localhost:3111/r/$PASS_ID/badge"
check "badge impressions are counted separately" "$([ "$(kit views "$PASS_ID" badge)" = "1" ] && echo 1 || echo 0)"

echo ""
echo "accounts:"
curl -s -c "$SCRATCH/jar" -o /dev/null -X POST http://localhost:3111/signup \
  --data-urlencode "email=owner@example.com" --data-urlencode "username=rx6600seller" --data-urlencode "password=correcthorse1"
check "signup creates an account" "$([ -n "$(kit user-id owner@example.com)" ] && echo 1 || echo 0)"
check "the username is stored" "$([ "$(kit username-of owner@example.com)" = "rx6600seller" ] && echo 1 || echo 0)"

signup() {
  curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3111/signup \
    --data-urlencode "email=$1" --data-urlencode "username=$2" --data-urlencode "password=correcthorse1"
}
check "a reserved username is refused"  "$([ "$(signup a@example.com admin)" = "400" ] && echo 1 || echo 0)"
check "a too-short username is refused" "$([ "$(signup b@example.com ab)" = "400" ] && echo 1 || echo 0)"
check "punctuation in a username is refused" "$([ "$(signup c@example.com 'bad.name')" = "400" ] && echo 1 || echo 0)"
check "a taken username is refused"     "$([ "$(signup d@example.com rx6600seller)" = "409" ] && echo 1 || echo 0)"
check "usernames are case-insensitive"  "$([ "$(signup e@example.com RX6600Seller)" = "409" ] && echo 1 || echo 0)"

# Login accepts either identifier, since people remember one or the other.
BYNAME=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3111/login \
  --data-urlencode "email=rx6600seller" --data-urlencode "password=correcthorse1")
check "you can log in with the username" "$([ "$BYNAME" = "302" ] && echo 1 || echo 0)"

# An unverified account cannot attach a public certificate to itself.
curl -s -o /dev/null -X POST http://localhost:3111/signup \
  --data-urlencode "email=unverified@example.com" --data-urlencode "username=notconfirmed" --data-urlencode "password=correcthorse1"
kit set-verified unverified@example.com 0 >/dev/null
curl -s -c "$SCRATCH/unv" -o /dev/null -X POST http://localhost:3111/login \
  --data-urlencode "email=unverified@example.com" --data-urlencode "password=correcthorse1"
curl -s -b "$SCRATCH/unv" -o /dev/null -X POST "http://localhost:3111/r/$PASS_ID/claim"
check "an unverified account cannot claim a certificate" "$([ "$(kit owner-of "$PASS_ID")" = "none" ] && echo 1 || echo 0)"
check "the certificate page says why" \
  "$(has "$(curl -s -b "$SCRATCH/unv" "http://localhost:3111/r/$PASS_ID")" "Confirm your email address")"

kit set-verified unverified@example.com 1 >/dev/null
curl -s -b "$SCRATCH/unv" -o /dev/null -X POST "http://localhost:3111/r/$PASS_ID/claim"
check "a verified account can claim it" "$([ "$(kit owner-of "$PASS_ID")" != "none" ] && echo 1 || echo 0)"
# No provider is configured in the smoke run, so an account that could never be
# verified is created verified rather than nagged forever.
check "unverifiable accounts aren't left unverified" "$([ "$(kit verified owner@example.com)" = "1" ] && echo 1 || echo 0)"

UID_=$(kit user-id owner@example.com)
# Forced back to unverified so the confirmation flow itself can be exercised
# even though this run has no mail provider.
kit set-verified owner@example.com 0 >/dev/null
VTOK=$(kit token "$UID_" verify)
curl -s -o /dev/null "http://localhost:3111/verify-email?token=$VTOK"
check "a verification link confirms the address" "$([ "$(kit verified owner@example.com)" = "1" ] && echo 1 || echo 0)"
check "the same link cannot be used twice" \
  "$(has "$(curl -s "http://localhost:3111/verify-email?token=$VTOK")" "That link has expired")"
check "a made-up verification token is refused" \
  "$(has "$(curl -s "http://localhost:3111/verify-email?token=deadbeef")" "That link has expired")"

# The reply must not differ between a real address and an unknown one, or the
# form becomes a way to discover who has an account here.
KNOWN=$(curl -s -X POST http://localhost:3111/forgot-password --data-urlencode "email=owner@example.com")
UNKNOWN=$(curl -s -X POST http://localhost:3111/forgot-password --data-urlencode "email=nobody@example.com")
check "password reset does not reveal whether an account exists" \
  "$([ "$(md5sum <<<"$KNOWN" | cut -d" " -f1)" = "$(md5sum <<<"$UNKNOWN" | cut -d" " -f1)" ] && echo 1 || echo 0)"

RTOK=$(kit token "$UID_" reset)
curl -s -o /dev/null -X POST http://localhost:3111/reset-password \
  --data-urlencode "token=$RTOK" --data-urlencode "password=brandnewpass9"
LOGIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3111/login \
  --data-urlencode "email=owner@example.com" --data-urlencode "password=brandnewpass9")
check "the new password works" "$([ "$LOGIN" = "302" ] && echo 1 || echo 0)"
OLD=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3111/login \
  --data-urlencode "email=owner@example.com" --data-urlencode "username=rx6600seller" --data-urlencode "password=correcthorse1")
check "the old password stops working" "$([ "$OLD" = "401" ] && echo 1 || echo 0)"
# A seller refreshing their own certificate is not a buyer looking at it.
curl -s -c "$SCRATCH/owner" -o /dev/null -X POST http://localhost:3111/login \
  --data-urlencode "email=owner@example.com" --data-urlencode "password=brandnewpass9"
curl -s -b "$SCRATCH/owner" -o /dev/null -X POST "http://localhost:3111/r/$FAIL_ID/claim"
BEFORE=$(kit views "$FAIL_ID" page)
curl -s -b "$SCRATCH/owner" -o /dev/null -A "$BROWSER" "http://localhost:3111/r/$FAIL_ID"
check "the owner's own visits are not counted" "$([ "$(kit views "$FAIL_ID" page)" = "$BEFORE" ] && echo 1 || echo 0)"
# But a stranger's visit to that same certificate still is.
curl -s -o /dev/null -A "$BROWSER" "http://localhost:3111/r/$FAIL_ID"
check "a stranger's visit to the same certificate is counted" "$([ "$(kit views "$FAIL_ID" page)" = "$((BEFORE+1))" ] && echo 1 || echo 0)"
check "the dashboard reports the traffic" \
  "$(has "$(curl -s -b "$SCRATCH/owner" http://localhost:3111/dashboard)" "certificate opens")"

check "a spent reset link cannot be reused" \
  "$(has "$(curl -s -X POST http://localhost:3111/reset-password --data-urlencode "token=$RTOK" --data-urlencode "password=another12345")" "expired or was already used")"

echo ""
echo "$pass passed, $fail failed"
[ "$fail" = "0" ]
