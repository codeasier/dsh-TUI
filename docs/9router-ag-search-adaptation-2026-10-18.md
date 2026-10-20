# 把自建 9Router 的搜索接进 DSH 原生 web_search（ag-search）

## 状态

已完成并落地：provider 随包分发（`presets/ag-search.mjs`）、中英双语文档、聚焦回归脚本、
构建与打包门禁；三台设备（本机 mac、linuxmint、mac-mini）各自对着**本机网关地址**实测搜索成功。

- 2026-10-18：提交 `0373c1af`，合并为 `ea8338ec`（PR #16），已在 `origin/v0.16.1-patch` 上（未进 upstream）。
- 2026-10-20：修掉一处**打包缺口**——首版 tarball 里其实没有 `presets/ag-search.mjs`，profile 靠手工副本撑着；
  现已重打包重装，并给 `scripts/local-install.sh` 补了预设摘要门禁。详见「事后修复」。
- 三台 profile 改动均留了 `cordis.patch.yml.bak-before-ag-search-*` 备份。

## 背景

需求是让 dsh-TUI 的联网搜索走自建网关（9Router，`http://<网关>:20128`）。DSH 默认的
`web-search-deepseek` provider 要求上游实现 Anthropic 的 `web_search_20250305`
**服务端**搜索工具；9Router 这类 OpenAI 兼容网关只把该工具定义当普通函数下发给模型、
不代为执行搜索，所以原生 `web_search` 在那条链路上永远拿不到结果。

结论：需要自己实现一个 `ctx.web` 的 search provider（DSH 的 web 能力接缝，
`registerSearchProvider({ id, available(), search() })`），再去 `web` 行把它选为
`searchProvider`。**不需要改 dsh-tui 源码**——这是 DSH 侧接缝 + profile 组合。

## 网关契约（2026-10-18 实测）

| 项 | 事实 |
|---|---|
| 端点 | `POST {baseURL}/search`（`GET` → 405，`OPTIONS` → `POST, OPTIONS`） |
| 鉴权 | `Authorization: Bearer <key>`；无 key 或错 key → 401 |
| 必填字段 | `provider`（或 `model`）+ `query`；缺哪个就报 `Missing required field: <哪个>` |
| 可选字段 | `max_results`（实测 10 生效）、`search_type`、`country`、`language`、`time_range`、`domain_filter`、`provider_options` |
| 响应 | `{ provider, query, results[], answer, usage, metrics, errors[] }` |
| 可用 provider | **`ag`**（响应回报 `antigravity`）= Gemini 的 Google Search grounding；`provider:"ag"` 等价 `model:"ag"`，也接受全名 `antigravity` |
| 默认模型 | `gemini-2.5-flash`（`answer.model` 回显；显式传 `model` 也生效） |
| 耗时/成本 | 单次 3–6 s，`usage.llm_tokens ≈ 900`，`search_cost_usd: null`（按 LLM 计，不按次计费） |

踩过的坑，别再走一遍：

- **`model` 字段被当 provider 名解析**。这版实例上 `{"model":"gemini-2.5-flash"}` →
  `Unknown provider: gemini-2.5-flash`；`{"model":"tavily/search"}` → `Unknown provider: tavily/search`
  （官方 master 分支的 skill 文档写的是 `model:"tavily/search"` 那种用法，比这版实例新）。
- **`{"provider":"gemini"}` 没有凭证**；`xai` 有凭证但上游稳定 504
  （`[xai] Upstream timeout (reset after 30s)`，约 15.3 s 返回，4 次复现）；
  `searxng` 是唯一免 key 的搜索 provider，却被网关自己的 SSRF 防护拦下
  （`searxng error: Blocked URL: internal host`）。
- tavily / exa / brave-search / serper / perplexity / linkup / searchapi / youcom / xquik /
  google-pse / minimax / kimi 全部 `No credentials for provider: …`。
- `GET /v1/models/web` 返回**空列表**；要枚举可用项得用
  `GET /v1/models/info?id=<provider>/search`。
- 响应里的 **`answer` 是对象**（`{ source, text, model }`），不是字符串。社区插件
  `mapSearchResponse` 只认 `typeof answer === "string"`，于是把那 1000–3000 字的综述正文
  静默丢掉——本 provider 把 `answer.text` 映射成接缝的 `content`，这是它相对社区插件的实际增益。
- `results[].url` 基本是 grounding 跳转链接
  （`vertexaisearch.cloud.google.com/grounding-api-redirect/…`），**有时效**，不要当永久链接保存。
- `/v1/web/fetch` 侧**没有可用 provider**（`ag`/`searxng` 不支持 fetch，firecrawl/exa/tavily 无凭证），
  所以抓取继续用 DSH 自带的 `http` provider。
- 外部信息（未在本地复核）：社区插件 README 指向 9Router fetch 端点的安全公告
  [GHSA-qj3v-4wj-q825](https://github.com/decolua/9router/security/advisories/GHSA-qj3v-4wj-q825)；
  检索结果里另有 [CVE-2026-55641（鉴权绕过 + SSRF）](https://vulnerability.circl.lu/vuln/cve-2026-55641)。
  建议把网关升到修复版本后再长期使用。

## 交付物（`.worktrees/v0.16.1-patch`，未提交）

| 文件 | 作用 |
|---|---|
| `presets/ag-search.mjs` | 随包分发的 `ctx.web` search provider，零框架依赖（只用 node 内建） |
| `scripts/verify-ag-search.mjs` | 聚焦回归：注册形状、端点/凭证三级解析、请求体与响应映射、失败分类；stub fetch、零网络、免编译 |
| `scripts/run-ci-group.mjs` | 注册 `verify-ag-search` 到 CI 分组 |
| `docs/configuration.md` / `.en.md` | 「自建搜索 provider（ag-search）」章节（中英同步） |
| `guide/dsh-tui-guide/configuration*.md` | 由 `scripts/build-guide.mjs` 从 docs 逐字节再生成 |

设计要点：

- **端点在行 config → `NINE_ROUTER_BASE_URL` → opencode 条目的 `baseURL`；
  凭证在行 `apiKey` → `apiKeyEnv` → opencode 条目的 `apiKey`。**
  两者都支持从 `opencode.json` 的 `provider[<opencodeProvider>].options` 复用，
  需显式写 `opencodeProvider` 才读——这样 key 与各机不同的网关地址都不进仓库。
  都没有就失败：无端点即 `available() === false`，无 key 抛
  `WEB_PROVIDER_CREDENTIAL_MISSING` 并点名三个来源；**不静默回落任何端点**。
- 请求体固定 `{ provider, model, query, search_type, max_results }`，
  `provider`/`model` 都显式钉死，不依赖网关默认。
- 错误一律带 `code` 的普通 `Error`（形状对齐 `WebError`），消息里绝不含 key。

## 部署矩阵

三台设备结构一致（dsh `0.2.1-rc.2`、dsh-tui `0.16.1`、bundles 相同），
各自 profile patch 尾部追加同样两段：`insert` 行挂载包内 preset + `web` 行整体覆盖。

| 设备 | 网关地址（取自该机 `opencode.json` 的 `unraid-wg`） | 备份 | 实测（真网关） |
|---|---|---|---|
| 本机 mac（开发机） | `10.66.0.3:20128` | `cordis.patch.yml.bak-before-ag-search-v2-*` | 5.9 s / 3 源 / 1957 字综述 |
| linuxmint | `127.0.0.1:20128`（网关就在本机） | `…bak-before-ag-search-*` | 4.0 s / 3 源 / 2293 字 |
| mac-mini | `192.168.45.7:20128` | `…bak-before-ag-search-*` | 3.9 s / 3 源 / 2286 字 |

三台都按 `./node_modules/@deepseek-harness-tui/dsh-tui/presets/ag-search.mjs` 挂载，行 config 只写
`opencodeProvider: unraid-wg`。三台 `opencode.json` 的 `unraid-wg` 都已带 key，未复制任何密钥。

> **注（2026-10-20 订正）**：原文写「包里那一份是唯一真源，profile 根的临时副本已删除」，事实是当时
> **那份副本根本不在包里** —— 安装目录里的 `presets/ag-search.mjs` 是手工从工作树复制进去的，
> 而 profile 根的临时副本确实删了。现在已重打包修正（见「事后修复」）。

## 验证

- `pnpm verify:build` 全绿；`node scripts/verify-guide.mjs` 20 个手册文件与 `docs/` 逐字节一致；
  `node scripts/verify-ag-search.mjs` **9/9 PASS**。
- 端到端：本会话的 `web_search` 两次都返回 `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
  来源 + 中文综述；其中一次是在**删掉 profile 根副本之后**做的，说明生效的是包内那份。
- 三台设备各自用「导入包内 preset + 行 config + 真跑一次搜索」验证，全部成功（见上表）。

## 事后修复：tarball 里其实没有 ag-search（2026-10-20）

根因是**先 `npm pack`（10:26）、后提交 provider（11:55）**：安装脚本打的是当时的工作树，包里
`presets/` 只有 `winbash.mjs`；装进 profile 一路打印「完成」，`lib` 摘要也对得上（它当时只比 `lib`），
于是靠手工把 `presets/ag-search.mjs` 复制进 `node_modules/…/presets/` 撑着跑。

修复前的证据：

- `tar tzf local-packages/dsh-tui.2K7Csv/…-0.16.1.tgz | grep -c ag-search` → **0**，`package/presets/` 只有 `winbash.mjs`；
- 安装目录里 `presets/ag-search.mjs` 的 mtime 是 11:36，而 tarball 是 10:26；
- 但两份 sha256 相同（`8d137d10…`），所以**行为一直是对的**，只是下一次重装就会静默丢掉。

修法与验证：

- `sh scripts/local-install.sh` 重打包重装（新包 `local-packages/dsh-tui.QIsqcd/…`）：包内 `presets/ag-search.mjs`
  存在且与工作树 sha256 一致；`dsh --profile dsh-tui --dump-config` 里 `ag-search` 行解析成
  `file:///…/node_modules/@deepseek-harness-tui/dsh-tui/presets/ag-search.mjs`，`web.searchProvider` 为 `ag-search`。
- `scripts/local-install.sh` 补了门禁：原来只比 `lib` 树摘要，现在 `presets` 也一起比；反向验证拿旧包比 →
  `presets 10 个文件 / f4850697529e` ≠ 现装 `11 个文件 / 461a530396b7`，这次事故会被拦在安装步骤。
- 真网关端到端（用**安装后**的文件、`opencodeProvider: unraid-wg`）：5.3 s / 5 源 / 1109 字综述。

教训：**`local-install.sh` 打印的「完成」只证明 `lib` 被换掉了**。任何随包文件（`presets/`、`guide/`、
`assets/`）的改动都要在**提交之后**重打包，并用「解包内容 vs 安装内容」比对，不能只看安装日志。

## 新机器复刻（runbook）

前置：该机能装 dsh、能拿到 dsh-tui 包、`~/.config/opencode/opencode.json` 里有指向网关的 provider 条目
（含 `baseURL` 与 `apiKey`）。

1. 装 dsh-tui 进目标 profile（registry 版或本仓库 `sh scripts/local-install.sh <profile>`），然后确认包里带 provider：
   `ls ~/.dsh/profiles/<profile>/node_modules/@deepseek-harness-tui/dsh-tui/presets/ag-search.mjs`。
2. 确认该机自己的网关地址（**不要抄别的机器**）：
   `node -e "const o=require(process.env.HOME+'/.config/opencode/opencode.json');console.log(o.provider['unraid-wg'].options.baseURL)"`。
3. 备份并在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 末尾追加两段：

   ```yaml
   - insert:
       - id: ag-search
         name: './node_modules/@deepseek-harness-tui/dsh-tui/presets/ag-search.mjs'
         config:
           opencodeProvider: unraid-wg
   - id: web
     name: '@deepseek-ai/dsh-web'
     config:
       searchProvider: ag-search
       fetchProvider: http
   ```

   `web` 行是**整体替换** config，两个字段都必须写；`fetchProvider` 保持 `http`（网关 fetch 侧没有可用 provider）。
4. 自检：`dsh --profile <profile> --dump-config | grep -A3 ag-search` 应看到解析后的 `file://` 路径；重开 TUI 搜一句。
   失败是响亮的 `WEB_PROVIDER_CONFIGURED_MISSING` / `WEB_PROVIDER_CREDENTIAL_MISSING`，不会静默降级。
5. 回归：仓库里 `node scripts/verify-ag-search.mjs`（stub fetch、零网络、9/9 PASS）。

日常只改行 config 即可：`provider`（默认 `ag`）、`model`（默认 `gemini-2.5-flash`）、`baseURL`、`apiKeyEnv`。
**别改用** `gemini` / `xai` / `searxng` / tavily 一类，原因见上面「踩过的坑」。

## 回滚

- 单机：恢复对应 `cordis.patch.yml.bak-before-ag-search-*`；或只把 `web` 行的
  `searchProvider` 改回 `deepseek-official`（两个字段都要保留，override 会整体替换 config）。
- 仓库：删 `presets/ag-search.mjs`、`scripts/verify-ag-search.mjs`、`docs`/`guide` 的对应章节
  与 `run-ci-group.mjs` 的那行注册。

## 未验证 / 风险

- **三台设备的 TUI 都没有重启过**：本机是靠 profile 的 `patchReload: live` 热生效；
  linuxmint（两个 dsh-tui 进程在跑）与 mac-mini 是否已热加载未在其界面上实测，
  下次重启后各搜一句即可确认（失败是响亮的 `WEB_PROVIDER_CONFIGURED_MISSING`，
  不会静默退化成别的 provider）。
- 包内相对路径挂载依赖 profile 布局（`node_modules/@deepseek-harness-tui/dsh-tui/…`）；
  若哪天改成「DSH 从自身安装目录解析同名 bundle」，此处需一并复核。
- `ag` 通道本质是一次 grounding LLM 调用，有 token 成本与 3–6 s 延迟，不是纯检索。
- 默认模型 `gemini-2.5-flash`；换模型只改行 config 的 `model`（`gemini-3.8-flash-high` 实测同通道可用）。
