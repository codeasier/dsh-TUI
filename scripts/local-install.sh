#!/bin/sh
# 本机自用：把当前工作树的构建装进本机的 dsh profile（不走 npm registry）。
#
#   sh scripts/local-install.sh            # 装进 dsh-tui
#   sh scripts/local-install.sh my-prof    # 装进别的 profile
#
# 环境变量：
#   DSH_HOME            默认 ~/.dsh
#   DSH_TUI_PACK_DIR    tarball 落盘目录，默认 $DSH_HOME/profiles/<profile>/local-packages
# 安装期间不要并行修改同一 profile（dsh plugin / pnpm / manifest 编辑）。本脚本
# 用 profile 局部锁拒绝并行调用；失败时恢复依赖树、manifest/lock 和旧引用 tarball。
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
  *) echo "⚠ 当前分支不是 v*-patch（实际：$branch）—— 本机定制应落在 v*-patch 上。回车继续，Ctrl-C 中止。" >&2; read -r _ ;;
esac

# 锁和快照留在 profile 文件系统内，回滚依赖树可直接 rename，不依赖网络/store。
# 其他 dsh/pnpm 命令不认识这个局部锁，安装期间必须独占此 profile。
backup="$PROFILE_DIR/.dsh-tui-local-install.lock"
mkdir "$backup" 2>/dev/null || { echo "profile 本地安装锁已存在：${backup}；拒绝并行安装，请确认旧任务/恢复状态。" >&2; exit 1; }
snapshot_ready=0
committed=0
tmp_unpack=
old_tarball=
restore_profile() {
  restore_status=0
  for file in package.json pnpm-lock.yaml; do
    if [ -f "$backup/$file" ]; then
      cp -p "$backup/$file" "$PROFILE_DIR/$file" || restore_status=1
    else
      rm -f "$PROFILE_DIR/$file" || restore_status=1
    fi
  done
  if [ -n "$old_tarball" ]; then
    cp -p "$backup/old.tgz" "$old_tarball" || restore_status=1
  fi
  if [ -e "$PROFILE_DIR/node_modules" ] || [ -L "$PROFILE_DIR/node_modules" ]; then
    mv "$PROFILE_DIR/node_modules" "$backup/failed-node_modules" || return 1
  fi
  if [ -d "$backup/node_modules" ]; then
    if ! mv "$backup/node_modules" "$PROFILE_DIR/node_modules"; then
      # 旧快照仍保留；尽量把失败安装放回原位，避免再丢失无关文件。
      if [ -d "$backup/failed-node_modules" ]; then
        mv "$backup/failed-node_modules" "$PROFILE_DIR/node_modules" || :
      fi
      return 1
    fi
  fi
  return "$restore_status"
}
finish_install() {
  status=$?
  trap - 0 HUP INT TERM
  set +e
  [ -z "$tmp_unpack" ] || rm -rf "$tmp_unpack"
  if [ "$snapshot_ready" = 1 ] && [ "$committed" = 0 ]; then
    if restore_profile; then
      echo "安装失败，已恢复 profile 旧依赖树、manifest/lock 与旧 tarball。" >&2
    else
      echo "安装失败且恢复失败；备份保留在 ${backup}，请手动恢复后再安装。" >&2
      exit 1
    fi
  fi
  if ! rm -rf "$backup"; then
    echo "备份清理失败：$backup" >&2
    status=1
  fi
  exit "$status"
}
trap finish_install 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

echo "==> 1/3 编译 src/ → lib/"
# verify-deps-before-run=false：pnpm 的运行前依赖检查按 **lockfile 的 mtime+size**
# 判断是否需要重装，而 git 切换分支必定重写 pnpm-lock.yaml —— 于是每次切完分支
# 首次跑本脚本，都会撞上它触发的 `pnpm install`，并在无 TTY 时以
# ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY 中止（内容其实一模一样）。脚本只负责
# 构建当前工作树，不管依赖管理；真缺依赖时 tsc 会报得比这清楚。依赖确实变了的话，
# 自己先跑 `CI=true pnpm install --frozen-lockfile`。
(cd "$REPO" && corepack pnpm --config.verify-deps-before-run=false compile)

echo
echo "==> 2/3 打 tarball（发布形状 manifest）"
# 整棵 node_modules 必须复制实物：isolated 入口是 symlink，pnpm 还会重写其
# .pnpm 真树及依赖闭包。cp -RP 保留内部 symlink，但不与 store 共享文件硬链接。
# 外部 link:/virtual-store 不在快照内，拒绝后再动任何 profile/pack 文件。
node --input-type=module - "$PROFILE_DIR/node_modules" <<'NODE'
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
const root = process.argv[2]
if (existsSync(root)) {
  if (lstatSync(root).isSymbolicLink()) throw new Error('无法备份外部 node_modules symlink')
  const base = realpathSync(root)
  const check = path => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path)
      if (target !== base && !target.startsWith(base + sep)) throw new Error(`无法备份外部依赖 symlink: ${path}`)
    } else if (stat.isDirectory()) {
      for (const name of readdirSync(path)) check(join(path, name))
    }
  }
  check(root)
}
NODE
for file in package.json pnpm-lock.yaml; do
  [ ! -L "$PROFILE_DIR/$file" ] || { echo "无法备份 symlink 配置：$file" >&2; exit 1; }
  [ ! -f "$PROFILE_DIR/$file" ] || cp -p "$PROFILE_DIR/$file" "$backup/$file"
done
[ ! -d "$PROFILE_DIR/node_modules" ] || cp -pRP "$PROFILE_DIR/node_modules" "$backup/node_modules"
# 必须在 pack 前保存旧引用的字节：同版本 npm pack 可能覆盖相同文件名。
old_tarball="$(node --input-type=module - "$PROFILE_DIR" <<'NODE'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
const profile = process.argv[2]
const manifest = join(profile, 'package.json')
const spec = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).dependencies?.['@deepseek-harness-tui/dsh-tui'] : undefined
if (spec?.startsWith('file:') && /\.tgz$/.test(spec)) process.stdout.write(resolve(profile, spec.slice(5)))
NODE
)"
[ -z "$old_tarball" ] || cp -p "$old_tarball" "$backup/old.tgz"
snapshot_ready=1
mkdir -p "$PACK_DIR"
# 不在这里清旧 tgz：profile 的 package.json 正用 file: 指着上一次的产物，
# 先删再 pack 的话，pack 一失败就把可引导的产物删没了。清理挪到装完之后。
(cd "$REPO" && node scripts/with-publish-manifest.mjs \
  npm pack --ignore-scripts --pack-destination "$PACK_DIR" >/dev/null)
TARBALL="$(ls -t "$PACK_DIR"/*.tgz | head -1)"
echo "    $TARBALL"

echo
echo "==> 3/3 装进 profile"
# 先删掉安装目录再 add（2026-09-29 实测两次，别省）：pnpm 对 `file:` tarball 的复用
# 按**路径**判断 —— 路径不变时，即使 tarball 内容变了（lock 里的 integrity 都换成新的、
# store 里也有新内容），profile 下这个目录仍旧原样留着，`dsh plugin add` 一路打印
# 「完成」，/restart 后跑的却是旧构建。删掉目录，pnpm 只能按新的 integrity 重新解出。
# 代价约 0.5s（store 已热）。
entry="$PROFILE_DIR/node_modules/@deepseek-harness-tui/dsh-tui"
if [ -e "$entry" ] || [ -L "$entry" ]; then
  mv "$entry" "$backup/entry-before-add"
fi
dsh plugin --profile "$PROFILE" add "file:$TARBALL"
# 收口：确认解出来的真的是这次的产物（比对打包与安装后的 lib 树摘要）。不一致就重链一次
# 再验，仍然不一致直接失败 —— 宁可炸在安装步骤，也别让 /restart 跑旧代码。
lib_digest() {
  # 不用可能吞掉 find/sha256sum 错误的 shell 管道；缺文件/读失败必须触发回滚。
  node --input-type=module - "$1" <<'NODE'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
const root = process.argv[2]
const files = []
const walk = path => {
  for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
    const file = `${path}/${entry.name}`
    if (entry.isDirectory()) walk(file)
    else if (entry.isFile()) files.push(file)
  }
}
walk('lib')
if (!files.length) throw new Error('安装产物缺少 lib 文件')
const hash = createHash('sha256')
for (const file of files.sort()) hash.update(file + '\0').update(readFileSync(join(root, file)))
process.stdout.write(hash.digest('hex'))
NODE
}
tmp_unpack="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$tmp_unpack" package/lib
want="$(lib_digest "$tmp_unpack/package")"
rm -rf "$tmp_unpack"
tmp_unpack=
have="$(lib_digest "$PROFILE_DIR/node_modules/@deepseek-harness-tui/dsh-tui")"
if [ "$want" != "$have" ]; then
  echo "    profile 里仍是旧构建，强制重链…"
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    mv "$entry" "$backup/entry-before-relink"
  fi
  (cd "$PROFILE_DIR" && CI=true corepack pnpm install --frozen-lockfile >/dev/null)
  have="$(lib_digest "$PROFILE_DIR/node_modules/@deepseek-harness-tui/dsh-tui")"
fi
[ "$want" = "$have" ] || { echo "安装产物与 tarball 不一致（$have ≠ $want）" >&2; exit 1; }
echo "    lib 摘要一致：$(printf '%s' "$have" | cut -c1-12)…"
committed=1

# 装成功了才清旧包：此刻 profile 的 package.json 已指向 $TARBALL，其余都是死重量。
for old in "$PACK_DIR"/*.tgz; do
  [ "$old" = "$TARBALL" ] && continue
  rm -f "$old"
done

echo
echo "完成。在 TUI 里 /restart 生效（或重开 dst）。"
echo "自检：dsh --profile $PROFILE --dump-config >/dev/null && echo OK"
echo
echo "想确认真的能起，别只看 dump-config —— 造个伪终端实启动一次："
echo "  timeout 30 script -qec \"dsh-tui\" /tmp/boot.log; \\"
echo "    grep -c '探索未至之境\\|查看快捷键' /tmp/boot.log   # 卡死时这里是 0"
