#!/usr/bin/env bash
#
# Qualifies one live authentication handoff of a dedicated guest account, from temporary
# custom-UI authentication to the long-lived Homebridge runtime (issue #1024).
#
# It walks a maintainer through the steps only a human can perform — an interactive login,
# a captcha or two-factor challenge, and the judgement about what reached the logs — and
# gates each acceptance criterion on a check from authentication-handoff-evidence.mjs.
# It never asks for the account password: that is typed only into the Homebridge UI.
#
# Procedure: docs/troubleshooting/live-authentication-handoff.md
#
# Everything above the "STAGES" marker is the wizard library: do not hand-edit
# it. Author the per-step stages below the marker.

set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────
# Wizard library — delightful, consistent UX. Identical across every wizard.
# ──────────────────────────────────────────────────────────────────────────

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0)
  BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1)
else
  BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""
fi

# Author sets this at the top of the stages section.
TOTAL_STAGES=0

_STAGE_INDEX=0
ENV_FILE="${ENV_FILE:-.env}"
WRITTEN_ENV=()    # KEYs written to ENV_FILE this run
WRITTEN_SECRET=() # secret NAMEs set this run
SKIPPED=()        # things we couldn't do (e.g. gh missing)

# _clear — wipe the terminal so only the current step is on screen. No-op when
# output isn't a terminal, so piped logs stay readable.
_clear() {
  [[ -t 1 ]] || return 0
  if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi
}

# banner "Title" — opening frame: what this wizard does.
banner() {
  _clear
  printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"
  printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"
  printf '%s  You drive the browser; this wizard tells you exactly what to do and\n' "$DIM"
  printf '  captures the values you copy back. Stop any time with Ctrl-C and re-run\n'
  printf '  later — it remembers values already saved.%s\n' "$RESET"
  pause "Ready to start?"
}

# stage "Name" — clear the screen, then announce a stage and show progress.
# Clearing keeps only the current step on screen.
stage() {
  _clear
  _STAGE_INDEX=$((_STAGE_INDEX + 1))
  printf '\n%s%s▸ Stage %s/%s · %s%s\n' \
    "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"
}

# say "..." — a plain instruction line.
say()  { printf '  %s\n' "$1"; }
# step "..." — a numbered-feeling action the human takes in the browser.
step() { printf '  %s•%s %s\n' "$BLUE" "$RESET" "$1"; }
note() { printf '  %s%s%s\n' "$DIM" "$1" "$RESET"; }
warn() { printf '  %s⚠ %s%s\n' "$YELLOW" "$1" "$RESET"; }

# open_url URL — open in the human's browser, cross-platform incl. WSL.
open_url() {
  local url="$1"
  printf '  %s↗ opening%s %s\n' "$GREEN" "$RESET" "$url"
  { if   command -v wslview     >/dev/null 2>&1; then wslview "$url"
    elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"
    elif command -v xdg-open    >/dev/null 2>&1; then xdg-open "$url"
    elif command -v open        >/dev/null 2>&1; then open "$url"
    else warn "couldn't open a browser — visit it manually: $url"; fi
  } >/dev/null 2>&1 || warn "couldn't open a browser — visit it manually: $url"
}

# pause "msg" — wait for the human to confirm they've done the manual part.
pause() {
  printf '  %s%s%s ' "$DIM" "${1:-Press Enter to continue}" "$RESET"
  read -r _ || true
}

# confirm "question" — y/N gate; returns success on yes.
confirm() {
  local reply=""
  printf '  %s? %s [y/N] ' "$YELLOW" "$1"
  read -r reply || true
  [[ "$reply" =~ ^[Yy] ]]
}

# _existing KEY — current value of KEY in ENV_FILE, if any.
_existing() {
  [[ -f "$ENV_FILE" ]] || return 1
  local line; line=$(grep -E "^${1}=" "$ENV_FILE" | tail -n1) || return 1
  printf '%s' "${line#*=}"
}

# ask KEY "Prompt" — read a value into $KEY. Offers the existing .env value as
# a default on re-runs (Enter keeps it). Visible input (non-secret).
ask() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -r input || true
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# ask_secret KEY "Prompt" — like ask, but input is hidden.
ask_secret() {
  local key="$1" prompt="$2" current input
  current=$(_existing "$key" || true)
  if [[ -n "$current" ]]; then
    printf '  %s%s%s %s[Enter keeps current]%s ' "$BOLD" "$prompt" "$RESET" "$DIM" "$RESET"
  else
    printf '  %s%s%s ' "$BOLD" "$prompt" "$RESET"
  fi
  read -rs input || true
  printf '\n'
  [[ -z "$input" && -n "$current" ]] && input="$current"
  printf -v "$key" '%s' "$input"
}

# write_env KEY VALUE — upsert KEY=VALUE into ENV_FILE (creates it; replaces
# any existing line). Idempotent.
write_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  WRITTEN_ENV+=("$key")
  printf '  %s✓ wrote%s %s → %s\n' "$GREEN" "$RESET" "$key" "$ENV_FILE"
}

# set_secret NAME VALUE — set a GitHub Actions repo secret via gh. Falls back
# to a warning (and records it) if gh is unavailable or unauthenticated.
set_secret() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if printf '%s' "$value" | gh secret set "$name" >/dev/null 2>&1; then
      WRITTEN_SECRET+=("$name")
      printf '  %s✓ set%s GitHub secret %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub secret $name (set it manually: gh secret set $name)")
  warn "skipped GitHub secret $name — gh not ready; set it later"
}

# set_var NAME VALUE — set a GitHub Actions repo variable (non-secret).
set_var() {
  local name="$1" value="$2"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if gh variable set "$name" --body "$value" >/dev/null 2>&1; then
      printf '  %s✓ set%s GitHub variable %s\n' "$GREEN" "$RESET" "$name"
      return
    fi
  fi
  SKIPPED+=("GitHub variable $name")
  warn "skipped GitHub variable $name — gh not ready; set it later"
}

# finish — clear, then a closing summary of everything configured.
finish() {
  _clear
  printf '\n%s%s  ✓ Setup complete%s\n' "$BOLD" "$GREEN" "$RESET"
  (( ${#WRITTEN_ENV[@]} ))    && note "wrote ${#WRITTEN_ENV[@]} value(s) to $ENV_FILE: ${WRITTEN_ENV[*]}"
  (( ${#WRITTEN_SECRET[@]} )) && note "set ${#WRITTEN_SECRET[@]} GitHub secret(s): ${WRITTEN_SECRET[*]}"
  if (( ${#SKIPPED[@]} )); then
    printf '\n'; warn "still to do by hand:"
    for s in "${SKIPPED[@]}"; do note "  - $s"; done
  fi
  printf '\n'
}

# ──────────────────────────────────────────────────────────────────────────
# STAGES — author this section. One stage() per step the human takes.
# Replace the example below. Set TOTAL_STAGES to match the stages you write.
# ──────────────────────────────────────────────────────────────────────────

TOTAL_STAGES=10

# ── Qualification context ─────────────────────────────────────────────────
# Everything this wizard produces lives under RUN_DIR, never in the checkout.

# refuse_production PATH — abort if PATH is a real Homebridge service storage path.
# This qualification replaces the active Eufy account of the instance it runs
# against, so it must refuse a production root before creating any file.
refuse_production() {
  case "$(cd "$(dirname "$1")" 2>/dev/null && pwd || printf '%s' "$(dirname "$1")")/$(basename "$1")" in
    /var/lib/homebridge* | /opt/homebridge/var* | "$HOME/.homebridge"*)
      printf '\n  ✗ refusing to qualify against production storage: %s\n\n' "$1" >&2
      exit 1
      ;;
  esac
}

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUN_DIR="${EUFY_QUALIFICATION_DIR:-/tmp/hb-1024}"
refuse_production "$RUN_DIR"

# _descends_from PID ANCESTOR — true when PID is ANCESTOR or one of its descendants.
#
# Homebridge and hb-service overwrite their process titles, so a running instance shows no arguments
# and cannot be told apart from another by its storage root. Ancestry is what distinguishes an instance
# this wizard started from one it must refuse.
_descends_from() {
  local pid="$1" ancestor="$2" hops=0
  while [[ -n "$pid" && "$pid" != "0" && "$pid" != "1" ]]; do
    if [[ "$pid" == "$ancestor" ]]; then
      return 0
    fi
    hops=$((hops + 1))
    if [[ "$hops" -gt 24 ]]; then
      return 1
    fi
    pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  done
  return 1
}

# refuse_concurrent_homebridge — abort while any other Homebridge instance is running.
#
# An ownership lease lives inside one storage root, so two instances with different roots cannot
# exclude each other even when they share a single Eufy account. Authenticating here while another
# instance holds that account's session makes two realtime owners, and the session the other instance
# restored can be invalidated underneath it. The wizard cannot read a service-owned storage root to
# compare accounts, so the only rule it can enforce without privileges is that nothing else runs.
refuse_concurrent_homebridge() {
  local found=() unit pid
  if command -v systemctl >/dev/null 2>&1; then
    for unit in homebridge homebridge-config-ui-x; do
      if [[ "$(systemctl is-active "$unit" 2>/dev/null || true)" == "active" ]]; then
        found+=("systemd unit '$unit' is active")
      fi
    done
  fi
  if command -v pgrep >/dev/null 2>&1; then
    for pid in $({ pgrep -x homebridge || true; pgrep -x hb-service || true; } 2>/dev/null | sort -u); do
      if [[ "$pid" == "$$" ]] || _descends_from "$pid" "$$"; then
        continue
      fi
      found+=("pid $pid is a Homebridge process this wizard did not start")
    done
  fi

  if [[ ${#found[@]} -eq 0 ]]; then
    return 0
  fi

  printf '\n  %s✗ another Homebridge instance is running%s\n\n' "$RED" "$RESET" >&2
  for unit in "${found[@]}"; do
    printf '      %s\n' "$unit" >&2
  done
  cat >&2 <<'REASON'

  Ownership is scoped to a storage root, so this instance cannot be refused the
  account by the one already running. Authenticating now would create a second
  realtime owner on the same Eufy session.

  Stop the other instance first, then re-run:

      sudo systemctl stop homebridge     # or: hb-service stop

  Remember to start it again when the qualification finishes.

REASON
  exit 1
}

ENV_FILE="$RUN_DIR/qualification.env"
STORAGE_ROOT="$RUN_DIR/homebridge-eufy"
EVIDENCE="$RUN_DIR/evidence.log"
UI_PORT="${EUFY_QUALIFICATION_UI_PORT:-8582}"
BRIDGE_PORT="${EUFY_QUALIFICATION_BRIDGE_PORT:-52929}"
mkdir -p "$RUN_DIR"
: > "$EVIDENCE"

RESULTS=()

# check "AC" "label" <evidence-subcommand...> — run one evidence check, record and show its result.
check() {
  local criterion="$1" label="$2"; shift 2
  printf '  %s▸ %s · %s%s\n' "$DIM" "$criterion" "$label" "$RESET"
  {
    printf '\n## %s · %s\n' "$criterion" "$label"
    printf '$ node scripts/authentication-handoff-evidence.mjs %s --storage <run>/homebridge-eufy\n' "$*"
  } >> "$EVIDENCE"
  if node "$REPO/scripts/authentication-handoff-evidence.mjs" "$@" --storage "$STORAGE_ROOT" 2>&1 \
    | tee -a "$EVIDENCE" | sed 's/^/    /'; then
    RESULTS+=("PASS $criterion $label")
    printf '  %s✓ %s satisfied%s\n' "$GREEN" "$criterion" "$RESET"
  else
    RESULTS+=("FAIL $criterion $label")
    warn "$criterion NOT satisfied — see $EVIDENCE"
  fi
}

banner "Qualify the live authentication handoff (issue #1024)"

# ── Stage 1 ───────────────────────────────────────────────────────────────
stage "Record the build under test"
say "Every claim in the report is only as good as the build that produced it."
( cd "$REPO" && git status --short --branch && git rev-parse HEAD ) | sed 's/^/    /'
note "node $(node --version)"
say ""
say "Building the plugin. The evidence harness imports the shipped ownership code"
say "from dist/, so a stale build would qualify the wrong algorithm."
( cd "$REPO" && npm run build >/dev/null 2>&1 ) && say "  build complete" || { warn "build failed"; exit 1; }
BUILD_SHA=$( cd "$REPO" && git rev-parse --short HEAD )
BUILD_BRANCH=$( cd "$REPO" && git rev-parse --abbrev-ref HEAD )
write_env BUILD_SHA "$BUILD_SHA"
write_env BUILD_BRANCH "$BUILD_BRANCH"
pause "Is this the branch you mean to qualify?"

# ── Stage 2 ───────────────────────────────────────────────────────────────
stage "Provision an isolated Homebridge instance"
refuse_concurrent_homebridge
say "This qualification replaces the active Eufy account of whatever instance it"
say "runs against, so it runs against a throwaway instance and never your service."
note "run directory   $RUN_DIR"
note "storage root    $STORAGE_ROOT"
note "UI port         $UI_PORT   (your production UI keeps its own port)"
note "bridge port     $BRIDGE_PORT"
say ""

HOMEBRIDGE_BIN=""
for candidate in \
  /var/lib/homebridge/node_modules/homebridge/bin/homebridge.js \
  /opt/homebridge/lib/node_modules/homebridge/bin/homebridge.js \
  "$(npm root -g 2>/dev/null)/homebridge/bin/homebridge.js"; do
  [[ -f "$candidate" ]] && HOMEBRIDGE_BIN="$candidate" && break
done
UI_BIN=""
for candidate in \
  /opt/homebridge/lib/node_modules/homebridge-config-ui-x/dist/bin/standalone.js \
  /var/lib/homebridge/node_modules/homebridge-config-ui-x/dist/bin/standalone.js \
  "$(npm root -g 2>/dev/null)/homebridge-config-ui-x/dist/bin/standalone.js"; do
  [[ -f "$candidate" ]] && UI_BIN="$candidate" && break
done

# The detected paths become the offered defaults, so Enter accepts them.
if [[ -n "$HOMEBRIDGE_BIN" ]]; then write_env HOMEBRIDGE_BIN "$HOMEBRIDGE_BIN"; fi
if [[ -n "$UI_BIN" ]]; then write_env UI_BIN "$UI_BIN"; fi
ask HOMEBRIDGE_BIN "Homebridge entry point:"
ask UI_BIN "Homebridge UI standalone entry point:"
[[ -f "$HOMEBRIDGE_BIN" && -f "$UI_BIN" ]] || { warn "both entry points must exist"; exit 1; }
write_env HOMEBRIDGE_BIN "$HOMEBRIDGE_BIN"
write_env UI_BIN "$UI_BIN"

mkdir -p "$RUN_DIR/plugins/@homebridge-plugins"
ln -sfn "$REPO" "$RUN_DIR/plugins/@homebridge-plugins/homebridge-eufy-security"
ln -sfn "$(dirname "$(dirname "$(dirname "$UI_BIN")")")" "$RUN_DIR/plugins/homebridge-config-ui-x"
cat > "$RUN_DIR/config.json" <<JSON
{
  "bridge": {
    "name": "Eufy Handoff Qualification",
    "username": "0E:1A:24:10:24:AA",
    "port": $BRIDGE_PORT,
    "pin": "031-45-154"
  },
  "platforms": [
    { "platform": "config", "name": "Config", "port": $UI_PORT, "auth": "none" },
    { "platform": "HomebridgeEufy" }
  ]
}
JSON
say "  wrote $RUN_DIR/config.json with only the UI and this plugin"
note "the plugin is symlinked to the checkout, so the UI loads the build under test"
pause "Provisioned. Continue?"

# ── Stage 3 ───────────────────────────────────────────────────────────────
stage "Confirm the dedicated guest account"
say "#1024 requires a DEDICATED GUEST account — a second Eufy account invited to the"
say "home as a guest. Do not use your owner account."
note "setup guide: docs/guide/dedicated-account.md"
say ""
warn "This wizard never asks for your password. You type it only into the"
warn "Homebridge UI in your browser. That absence is part of the AC1 evidence:"
warn "no credential passes through this script, its environment, or its files."
say ""
confirm "Do you have a dedicated guest account ready (not your owner account)?" || {
  warn "provision the guest account first, then re-run"
  exit 1
}
say ""
say "Pick a synthetic alias for the report. The real address must never appear in"
say "the issue, the report, or a commit."
ask ACCOUNT_ALIAS "Synthetic alias for this account [guest-a]:"
ACCOUNT_ALIAS="${ACCOUNT_ALIAS:-guest-a}"
write_env ACCOUNT_ALIAS "$ACCOUNT_ALIAS"

# ── Stage 4 ───────────────────────────────────────────────────────────────
stage "AC1 — authenticate interactively through the custom UI"
refuse_concurrent_homebridge
say "Homebridge stays STOPPED for this stage. Only the UI runs, so temporary"
say "authentication ownership is the sole owner of the account session."
note "re-checked just now: no other Homebridge instance is running"
say ""
node "$UI_BIN" -U "$RUN_DIR" -P "$RUN_DIR/plugins" -I > "$RUN_DIR/ui.log" 2>&1 &
UI_PID=$!
say "  Homebridge UI started (pid $UI_PID); waiting for it to listen"
for _ in $(seq 1 30); do
  curl -sS -o /dev/null "http://127.0.0.1:$UI_PORT/" 2>/dev/null && break
  sleep 1
done
open_url "http://127.0.0.1:$UI_PORT/"
say ""
say "Watching for the temporary ownership lease in the background, so stage 6 can judge"
say "its release against having held it. Take as long as you need with the challenge."
node "$REPO/scripts/authentication-handoff-evidence.mjs" ownership \
  --observe-kind temporary-authentication --timeout-seconds 900 --storage "$STORAGE_ROOT" \
  > "$RUN_DIR/observe.log" 2>&1 &
OBSERVER_PID=$!
say ""
step "Open Plugins → Homebridge Eufy → Settings to reach the plugin's custom UI."
step "Enter the GUEST account address, its password, and your country."
step "Complete the captcha and/or two-factor challenge when the UI presents it."
step "Wait until the UI reports that discovery finished and a restart is required."
say ""
note "if the UI reports the plugin is already running, something else holds the lease"
pause "Press Enter once the UI reports the account was published."

if kill -0 "$OBSERVER_PID" 2>/dev/null; then
  kill "$OBSERVER_PID" 2>/dev/null || true
  wait "$OBSERVER_PID" 2>/dev/null || true
  OBSERVED=1
else
  wait "$OBSERVER_PID" 2>/dev/null && OBSERVED=0 || OBSERVED=1
fi
{
  printf '\n## AC2 · temporary authentication holds the lease during the flow\n'
  cat "$RUN_DIR/observe.log"
} >> "$EVIDENCE"
sed 's/^/    /' "$RUN_DIR/observe.log"
if [[ "$OBSERVED" == "0" ]]; then
  RESULTS+=("PASS AC2 temporary authentication held the lease during the flow")
  printf '  %s✓ AC2 satisfied%s\n' "$GREEN" "$RESET"
else
  RESULTS+=("FAIL AC2 temporary authentication was never observed holding the lease")
  warn "AC2 NOT satisfied — the temporary lease was never observed"
fi

# ── Stage 5 ───────────────────────────────────────────────────────────────
stage "AC1 — audit every credential sink"
say "Probing the isolated storage root, and the UI process log, for the account"
say "password you just typed. The value is compared by exact match; neither it nor"
say "its digest nor its length is ever printed."
say ""
check "AC1" "no credential or account address escapes its declared sink" \
  sinks --ui-log "$RUN_DIR/ui.log"
note "advisory runtime evidence and the plugin log are audited again at stage 9, once the"
note "runtime has actually written them"
say ""
say "The challenge answer cannot be probed the same way: the plugin persists a captcha"
say "or two-factor answer nowhere, so there is no stored value to compare against."
say "Confirming it never reached a log is therefore your read, not an assertion."
say ""
step "Search both logs for the answer you typed. Substitute it for ANSWER:"
note "  grep -F 'ANSWER' $RUN_DIR/ui.log $STORAGE_ROOT/logs/homebridge-eufy.jsonl"
step "Then skim the same files for anything else resembling the password."
say ""
note "the password rests deliberately, in cleartext, in the persisted account"
note "configuration and in config.json — both owner-only. That is by design, not a leak."
confirm "Did you search both logs and find no credential or challenge answer?" \
  && RESULTS+=("PASS AC1 maintainer searched the logs for the challenge answer") \
  || RESULTS+=("FAIL AC1 maintainer found credential material in the logs")

# ── Stage 6 ───────────────────────────────────────────────────────────────
stage "AC2 — closing the UI releases temporary ownership"
step "Close the browser tab you used for the plugin settings."
pause "Closed? Press Enter to stop the UI process."
kill "$UI_PID" 2>/dev/null || true
wait "$UI_PID" 2>/dev/null || true
say "  Homebridge UI stopped"
say ""
check "AC2" "no lease record survives the UI" ownership --expect-kind none

# ── Stage 7 ───────────────────────────────────────────────────────────────
stage "AC2 — a normal restart acquires the persisted session exactly once"
say "Starting Homebridge with no UI running. It must restore the persisted session"
say "without another login and publish a complete observation-only snapshot."
RESTART_AT=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
node "$HOMEBRIDGE_BIN" -U "$RUN_DIR" -P "$RUN_DIR/plugins" -I --strict-plugin-resolution \
  > "$RUN_DIR/homebridge.log" 2>&1 &
RUNTIME_PID=$!
say "  Homebridge started (pid $RUNTIME_PID); allowing 60s to reach a steady state"
for _ in $(seq 1 60); do
  grep -q 'runtime-ready\|is running on port' "$RUN_DIR/homebridge.log" 2>/dev/null && break
  sleep 1
done
sleep 20
say ""
check "AC2" "one acquisition, complete snapshot, no second login" \
  acquisition --since "$RESTART_AT"
check "AC2" "exactly one live runtime lease" ownership --expect-kind runtime

# ── Stage 8 ───────────────────────────────────────────────────────────────
stage "AC3 — a concurrent second owner is refused without theft"
say "Acquiring the same account scope from this separate process while Homebridge"
say "holds the lease. The refusal must leave the incumbent lease byte-identical."
warn "This is the only step that writes to the storage root: it takes and releases"
warn "one bakery-guard record. It performs no device operation."
say ""
check "AC3" "second owner refused, live lease intact" conflict

# ── Stage 9 ───────────────────────────────────────────────────────────────
stage "AC4 — no real-device write was performed"
say "Re-auditing every sink now that the runtime has published advisory evidence and"
say "written its log, which did not exist when stage 5 ran."
check "AC1" "no credential reaches runtime evidence or the plugin log" \
  sinks --ui-log "$RUN_DIR/ui.log" --require-runtime-evidence
say ""
say "During stage 4 the plugin reached the SDK only through the narrowed authentication"
say "client, which exposes login, captcha, two-factor, discovery, and disconnect and no"
say "persistent write, momentary action, rename, reboot, or raw transport call."
note "hermetic proof: test/contracts/temporary-authentication.test.ts"
note "  'performs no device write across a complete captcha authentication and discovery flow'"
say ""
say "Stages 7 and 8 ran the full runtime rather than that narrowed client, so this last"
say "confirmation covers the whole run, not just the handoff."
step "Check the guest account's home in the Home app or Eufy app for changed state."
confirm "Did every device remain unchanged throughout this qualification?" \
  && RESULTS+=("PASS AC4 no device changed state") \
  || RESULTS+=("FAIL AC4 a device changed state")

# ── Stage 10 ──────────────────────────────────────────────────────────────
stage "Emit the redacted evidence report"
kill "$RUNTIME_PID" 2>/dev/null || true
wait "$RUNTIME_PID" 2>/dev/null || true
say "  Homebridge stopped"
REPORT="$RUN_DIR/report.md"
{
  printf '# Live authentication handoff qualification (#1024)\n\n'
  printf -- '- build: `%s` on `%s`\n' "$BUILD_SHA" "$BUILD_BRANCH"
  printf -- '- node: `%s`\n' "$(node --version)"
  printf -- '- account: dedicated guest account, alias `%s`\n' "$ACCOUNT_ALIAS"
  printf -- '- instance: isolated, storage root `<run>/homebridge-eufy`, UI port %s\n' "$UI_PORT"
  printf -- '- device writes: none attempted\n\n'
  printf '## Result\n\n'
  for entry in "${RESULTS[@]}"; do
    case "$entry" in
      PASS*) printf -- '- [x] %s\n' "${entry#PASS }" ;;
      *)     printf -- '- [ ] **%s**\n' "${entry#FAIL }" ;;
    esac
  done
  printf '\n## Harness output\n\n```\n'
  cat "$EVIDENCE"
  printf '```\n'
} > "$REPORT"
say ""
say "  wrote $REPORT"
FAILURES=$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL' || true)
if [[ "$FAILURES" == "0" ]]; then
  printf '  %s✓ every acceptance criterion is satisfied%s\n' "$GREEN" "$RESET"
else
  warn "$FAILURES criterion/criteria not satisfied — do not close #1024"
fi
say ""
warn "Before pasting the report into the issue, confirm it contains no real account"
warn "address, device serial, device name, or address. The harness redacts its own"
warn "output; your pasted commentary is your responsibility."
say ""
step "gh issue comment 1024 --body-file $REPORT"
note "delete $RUN_DIR when you are done; it holds a real session for the guest account"

finish
