#!/usr/bin/env bash
#
# V5 dropped eufy-security-client and the dependencies that only existed to paper over it.
# Each pattern below is a concern the SDK now owns; a re-appearance means logic crept back
# into the plugin instead of being fixed (or asked for) in the SDK.
set -uo pipefail

cd "$(dirname "$0")/.."

BANNED=(
  "eufy-security-client"      # replaced by @mega-yfue/eufy-sdk
  "tslog"                     # homebridge's Logger satisfies the SDK's Logger shape
  "pick-port"                 # node:net
  "rotating-file-stream"      # homebridge owns log rotation
  "PropertyName"              # ECS property enum; use typed dev.<cap>() getters
  "CommandName"               # ECS command enum; use typed capability operations
  "getProperty("              # untyped escape hatch; a missing read is an SDK gap to file
)

status=0
for pattern in "${BANNED[@]}"; do
  if hits=$(grep -rn --fixed-strings "$pattern" src homebridge-ui 2>/dev/null); then
    echo "guard:no-ecs — banned pattern '$pattern':"
    echo "$hits" | sed 's/^/  /'
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "guard:no-ecs — clean"
fi
exit "$status"
