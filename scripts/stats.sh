#!/usr/bin/env bash
# How many people downloaded StudyPet, and who came by the download page.
#
#   scripts/stats.sh
#
# Downloads are GitHub's own count for each release zip (every click counts, repeats too).
# Page visits cover the last 14 days, as far back as GitHub keeps them, and lag a few hours.
# Each run is remembered in release/stats.csv, so the next run can say what's new since.
set -euo pipefail

REPO="aenorhabditis6/studypet-releases"
cd "$(dirname "$0")/.."
HISTORY="release/stats.csv"

echo "📦 下载次数"
total=0
while IFS=$'\t' read -r tag date count; do
  printf "   %-8s %s 发布   %4d 次\n" "$tag" "$date" "$count"
  total=$((total + count))
done < <(gh api "repos/$REPO/releases" --paginate \
  --jq '.[] | [.tag_name, .published_at[0:10], ([.assets[].download_count] | add // 0)] | @tsv')
printf "   一共 %d 次\n" "$total"

mkdir -p release
if [[ -s "$HISTORY" ]]; then
  IFS=, read -r last_time last_total < <(tail -1 "$HISTORY")
  echo "   比上次查看（$last_time）多了 $((total - last_total)) 次"
fi
echo "$(date '+%Y-%m-%d %H:%M'),$total" >>"$HISTORY"

echo
echo "👀 下载页访问（最近 14 天，GitHub 会晚几个小时更新）"
gh api "repos/$REPO/traffic/views" \
  --jq '"   一共 \(.count) 次 · \(.uniques) 个人", (.views[] | select(.count > 0) | "   \(.timestamp[0:10])  \(.count) 次 · \(.uniques) 人")'

echo
echo "🔗 从哪里点进来的"
referrers=$(gh api "repos/$REPO/traffic/popular/referrers" --jq '.[] | "   \(.referrer)  \(.count) 次 · \(.uniques) 人"')
echo "${referrers:-   （还没有记录）}"
