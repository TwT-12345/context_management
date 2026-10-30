# Agent 上下文管理

OpenCode 1.2.x 的上下文管理插件：把旧轮次换成短摘要，不额外调用模型。默认让模型自己说哪些轮次还要（`KEEP`）、记下自己的结论（`NOTE`）；也可以换成全按规则收，见下面的选项。

## 安装

需要 OpenCode 1.2.x（按 1.2.27 测试）和 Node。先退出 OpenCode，然后：

```
node install.mjs <项目目录> [agent 名] [--replace] [--replace-config] [--reset-state]
```

- `agent 名`：阶段层只对这个 agent 生效，名字区分大小写，默认 `bug-fix-adaptive`。
- `--replace`：项目里已经装了旧版本，或装着 Stage-Only 时要加。
- `--replace-config`：重写阶段层配置，必须同时加 `--reset-state`。
- `--reset-state`：清掉阶段层的状态和 `.opencode/` 里的三份日志（`bugfix-adaptive-context.jsonl`、`bugfix-adaptive-cache.jsonl`、`context-manage.jsonl`）。

被替换或删掉的文件会先备份到 `.opencode/bugfix-adaptive-backups/`。

装好后重启 OpenCode，新建一个 Session。第一次启动时 OpenCode 要下载依赖，需要联网。

例：从 Stage-Only 换成本插件

```
node install.mjs C:\你的项目 bug-fix-adaptive --replace
```

## 确认在运行

发几条消息后，项目里的 `.opencode/context-manage.jsonl` 每次请求会多一行。

阶段层开着时，`.opencode/bugfix-adaptive-cache.jsonl` 每次请求也会多几行。这是缓存诊断：记下实际发出的请求里 system、tools 和各条消息的指纹，以及和上一个请求相比从第几条消息开始不同。它只记录，不改请求。要关掉，设环境变量 `OPENCODE_BUGFIX_ADAPTIVE_CACHE_DIAGNOSTICS=0` 后重启 OpenCode；选项 `log: false` 只关折叠日志。

## 选项

选项写在 `.opencode/plugins/context-manage.js` 里 `const OPTIONS =` 那一行，必须是一行 JSON，重装时会保留。默认：

```
{"stage":".opencode/bugfix-adaptive-context.config.json"}
```

**怎么收**：四个选项各管一件事，可以任意组合。

| 选项 | 默认 | 作用 |
|---|---|---|
| `turns` | `"ask"` | 哪些旧轮次放掉。`"ask"`：轮次满 9 轮时问模型，模型用 `KEEP` 留下还要的；`"recent"`：满 9 轮就放掉，不问；`"off"`：不收整轮 |
| `stale` | `false` | `true`：过时的文件查看单独收，只换掉那一份输出。同样几行后来又看过，就收；文件后来改过，满 9 轮再收（`turns: "ask"` 时听模型的 `KEEP`） |
| `summary` | `"note"` | 收起的轮次换成什么。`"note"`：规则摘要加模型的 `NOTE`（模型每次回复都写一行 `NOTE`）；`"rule"`：只有规则摘要（调了什么、行号范围、函数签名、搜索结果）；`"placeholder"`：只写调了什么、结果如何 |
| `timing` | `"rent"` | 什么时候收。`"rent"`：先租后买，按缓存价算划算了才收；`"now"`：放掉就收 |

模型只在要它写东西时才看到额外内容：`turns: "ask"` 时有轮次标签和 `KEEP` 提问，`summary: "note"` 时有 `NOTE` 提醒。两者都不用时（比如 `{"turns":"recent","summary":"rule"}`），模型看不到任何说明，第一次收起之前，请求和不装插件时完全一样。

**其他**

| 选项 | 默认 | 作用 |
|---|---|---|
| `start` | `10000` | 上下文到这么多 token 才启用，短任务不受影响；`0` 从头启用 |
| `cache` | `0.1` | 缓存命中的输入价格占全价的比例，`timing: "rent"` 用它算什么时候收起划算；GLM-5.3-Flash 填 `0.2`，服务商的缓存不严格按前缀时填 `1` |
| `stage` | 上面的路径 | 阶段层配置；`false` 关掉阶段层 |
| `log` | `.opencode/context-manage.jsonl` | 日志路径；`false` 不写日志。启动时先写一行当前的选项 |

## 开发

```
bun install
bun test              # 单元测试
bun run typecheck     # 类型检查
bun run e2e           # 用假 Provider 跑真实 OpenCode 1.2.27，不发外部请求
bun run e2e:compaction
```

设计见 [docs/design.md](docs/design.md)。
