#!/usr/bin/env bash
# Builds StudyPet for macOS (Apple Silicon + Intel), zips it, and publishes it as a GitHub
# release in the public downloads repo. The source stays in this private repo; only the
# zip is public.
#
#   scripts/release.sh 0.2.0 "这一版改了什么"
set -euo pipefail

VERSION="${1:?usage: scripts/release.sh <version> [release notes]}"
NOTES="${2:-StudyPet $VERSION}"
PUBLIC_REPO="aenorhabditis6/studypet-releases"
cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain)" ]]; then
  echo "有还没提交的改动，先 commit 再发布。" >&2
  exit 1
fi
if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
  echo "v$VERSION 已经发布过了，换一个版本号。" >&2
  exit 1
fi

# 1. The version number, everywhere it lives.
node -e '
  const fs = require("fs");
  const v = process.argv[1];
  for (const f of ["package.json", "src-tauri/tauri.conf.json"]) {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    j.version = v;
    fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
  }
  const cargo = "src-tauri/Cargo.toml";
  fs.writeFileSync(cargo, fs.readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${v}"`));
' "$VERSION"

# 2. One app that runs on both Apple Silicon and Intel Macs, ad-hoc signed as a whole
#    (a consistent signature is what lets "Open Anyway" work instead of "damaged").
rustup target add aarch64-apple-darwin x86_64-apple-darwin >/dev/null
npx tauri build --bundles app --target universal-apple-darwin
APP="src-tauri/target/universal-apple-darwin/release/bundle/macos/StudyPet.app"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

# 3. Zip it the Mac way (keeps the bundle intact), without macOS file metadata: that would
#    travel as "._" files, which plain unzip tools leave inside the app and break its seal.
mkdir -p release
ZIP="release/StudyPet-$VERSION-macos.zip"
rm -f "$ZIP"
ditto -c -k --norsrc --noextattr --keepParent "$APP" "$ZIP"

# 4. Record the release in the private repo, then publish only the zip.
git commit -qam "Release v$VERSION" || true
git tag "v$VERSION"
git push -q origin HEAD "v$VERSION"
gh release create "v$VERSION" "$ZIP" --repo "$PUBLIC_REPO" --title "StudyPet $VERSION" --notes "$NOTES"
echo "发布好了：https://github.com/$PUBLIC_REPO/releases/tag/v$VERSION"
