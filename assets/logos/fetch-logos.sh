#!/usr/bin/env bash
# Usage: BRANDFETCH_CLIENT_ID=xxx bash assets/logos/fetch-logos.sh
set -u
: "${BRANDFETCH_CLIENT_ID:?set BRANDFETCH_CLIENT_ID (see .env.example)}"
cd "$(dirname "$0")"
declare -A BRANDS=( [dolcegabbana]=dolcegabbana.com [jeanpaulgaultier]=jeanpaulgaultier.com [scentbird]=scentbird.com [decantx]=decantx.com [luckyscent]=luckyscent.com )
for name in "${!BRANDS[@]}"; do
  for type in logo icon; do
    for theme in light dark; do
      out="$name-$type-$theme.webp"
      code=$(curl -s -o "$out" -w '%{http_code}' \
        "https://cdn.brandfetch.io/domain/${BRANDS[$name]}/w/800/theme/$theme/fallback/404/type/$type?c=$BRANDFETCH_CLIENT_ID")
      if [ "$code" = 200 ]; then echo "ok   $out"; else rm -f "$out"; echo "miss $out ($code)"; fi
    done
  done
done
