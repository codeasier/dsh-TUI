#!/bin/sh
# 本机自用：把当前工作树的构建装进本机的 dsh profile（不走 npm registry）。
#
#   sh scripts/local-install.sh            # 装进 dsh-tui
#   sh scripts/local-install.sh my-prof    # 装进别的 profile
#
# 环境变量：
#   DSH_HOME            默认 ~/.dsh
#   DSH_TUI_PACK_DIR    tarball 落盘目录，默认 $DSH_HOME/profiles/<profile>/local-packages
#
# ---------------------------------------------------------------------------
# 为什么是 tarball，而不是 `link:` / `pnpm link`（2026-09-29 实测，别改回去）
#
# `link:` 会把包的真实路径挪到 profile 之外（即本仓库目录），而 ESM 默认按
# **realpath** 解析依赖，于是插件整棵模块图跟着搬出 profile：
#
#   @deepseek-ai/cordis -> <repo>/node_modules/.pnpm/@deepseek-ai+cordis@.../…
#   react               -> <repo>/node_modules/.pnpm/react@19.3.0/…
#   @dsh-std/core       -> <repo>/vendor/dsh-std/packages/core/…
#
# 本该由宿主（$DSH_HOME/profiles/node_modules）提供的 peer，全被换成了仓库自己的
# 开发依赖副本，宿主与插件各持一份实例 → 启动时**静默卡死**：MCP 服务器打印完就
# 再无输出，界面一个字节都不画，进程活着但不响应，且没有任何报错可看。
# 从 registry 装、或从 tarball 装，这几样都解析在 profile 内部，正常。
#
# ---------------------------------------------------------------------------
# 为什么 tarball 必须用「发布形状」的 manifest
#
# 源码 manifest 里的 `@dsh-std/*` 是 `workspace:*`、dsh-auth 是 `link:./dsh-auth` ——
# 都是仓库内开发专用的 spec，直接 pack 出来装不上（pnpm 拒绝 workspace 协议）。
# 发版流程用 scripts/with-publish-manifest.mjs 在 npm 命令期间把它们临时改写成
# 精确版本的 optionalDependencies，结束后还原源码 manifest。这里复用同一个改写器，
# 不自己手改 —— 手改容易和发版口径漂移。
#
# 注意：必须 `--ignore-scripts`，否则 `prepare` 会再跑一次 compile（我们刚跑完）。
# ---------------------------------------------------------------------------
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-${DSH_TUI_PROFILE:-dsh-tui}}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PACK_DIR="${DSH_TUI_PACK_DIR:-$DSH_HOME/profiles/$PROFILE/local-packages}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

command -v dsh >/dev/null 2>&1 || { echo "找不到 dsh CLI" >&2; exit 1; }
[ -f "$REPO/package.json" ] || { echo "不在仓库里：$REPO" >&2; exit 1; }
[ -d "$PROFILE_DIR" ] || { echo "找不到 profile：$PROFILE_DIR" >&2; exit 1; }

version="$(node -p "require('$REPO/package.json').version")"
branch="$(cd "$REPO" && git rev-parse --abbrev-ref HEAD)"
echo "仓库    $REPO"
echo "分支    $branch @ $(cd "$REPO" && git rev-parse --short HEAD)"
echo "版本    $version"
echo "profile $PROFILE"
echo

case "$branch" in
  v*-patch) : ;;
  *) echo "⚠ 当前分支不是 v*-patch（本机定制在 v0.11.1-patch）。回车继续，Ctrl-C 中止。" >&2; read -r _ ;;
esac

echo "==> 1/3 编译 src/ → lib/"
(cd "$REPO" && corepack pnpm compile)

echo
echo "==> 2/3 打 tarball（发布形状 manifest）"
mkdir -p "$PACK_DIR"
rm -f "$PACK_DIR"/*.tgz
(cd "$REPO" && node scripts/with-publish-manifest.mjs \
  npm pack --ignore-scripts --pack-destination "$PACK_DIR" >/dev/null)
TARBALL="$(ls -t "$PACK_DIR"/*.tgz | head -1)"
echo "    $TARBALL"

echo
echo "==> 3/3 装进 profile"
dsh plugin --profile "$PROFILE" add "file:$TARBALL"

echo
echo "完成。在 TUI 里 /restart 生效（或重开 dst）。"
echo "自检：dsh --profile $PROFILE --dump-config >/dev/null && echo OK"
echo
echo "想确认真的能起，别只看 dump-config —— 造个伪终端实启动一次："
echo "  timeout 30 script -qec \"dsh-tui\" /tmp/boot.log; \\"
echo "    grep -c '探索未至之境\\|查看快捷键' /tmp/boot.log   # 卡死时这里是 0"
