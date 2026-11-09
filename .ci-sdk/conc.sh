#!/bin/bash
# Cold builds of ./packages/* at several concurrency limits; 3 rounds, order rotated per round.
set -u
set -f  # filters like ./packages/* go to the tools as written, not expanded by the shell
clean() {
  set +f
  find packages -path '*/node_modules' -prune -o \( -name dist -o -name .wireit -o -name .turbo -o -name '*.tsbuildinfo' \) -print0 | xargs -0 rm -rf
  rm -rf .wireit .turbo node_modules/.cache/ci-sdk node_modules/.cache/turbo
  set -f
}
V=(
  "pnpm|pnpm run --filter ./packages/** build"
  "sdk4|ci-sdk run build --filter ./packages/* --concurrency 4"
  "sdk8|ci-sdk run build --filter ./packages/* --concurrency 8"
  "sdk16|ci-sdk run build --filter ./packages/* --concurrency 16"
  "turbo4|turbo run build --filter=./packages/* --concurrency=4"
  "turbo10|turbo run build --filter=./packages/*"
)
echo "| round | variant | seconds | exit |" >> "$GITHUB_STEP_SUMMARY"
echo "|---|---|---|---|" >> "$GITHUB_STEP_SUMMARY"
n=${#V[@]}
for round in 1 2 3; do
  for ((i=0;i<n;i++)); do
    idx=$(( (i + round - 1) % n )); name=${V[$idx]%%|*}; cmd=${V[$idx]#*|}
    clean
    s=$(date +%s.%N)
    $cmd > "/tmp/$name-$round.log" 2>&1; c=$?
    d=$(echo "$(date +%s.%N) - $s" | bc)
    printf 'round %s %-8s %6.1fs exit %s\n' "$round" "$name" "$d" "$c"
    [ $c -ne 0 ] && tail -20 "/tmp/$name-$round.log"
    printf '| %s | %s | %.1f | %s |\n' "$round" "$name" "$d" "$c" >> "$GITHUB_STEP_SUMMARY"
  done
done
