# 设计：模型说要留什么，插件收起其余

日期：2026-10-19。代码在 `src/`。

## 1. 一句话

把旧步骤换成短摘要，全程不额外调用模型。放掉哪些、过时的输出收不收、换成什么、什么时候收，是四个可以任意组合的模块（第 9 节）。默认组合：模型在正常回复里顺手写一行 `KEEP`（哪些步骤还要用）和一行 `NOTE`（刚才学到了什么）；旧步骤满 9 步时，模型没留下的就换成一条短摘要，模型不表态就不收起。

## 2. 和 OpenCode 自带压缩的区别

| | OpenCode 压缩（compaction） | 本插件 |
|---|---|---|
| 什么时候 | 上下文快满时才做一次 | 任务早期开始，每 3 步检查一次 |
| 单位 | 除最近 2 轮外的全部历史 | 一步一步收 |
| 谁决定收什么 | 固定规则 | 默认模型（KEEP），也可以按规则（选项 `turns`、`stale`） |
| 换成什么 | 另调一次模型写的全局总结 | 规则提取的签名和搜索命中 + 模型当时写的 NOTE（选项 `summary`） |
| 额外调用 | 有，要把整段历史发过去 | 没有 |
| 缓存 | 不考虑，压缩后全部失效 | 边界每 3 步才动，已定的前缀不再变 |
| 原文 | 找不回 | 会话里原样保存，只是不再发送 |

两者不冲突：插件平时把上下文控制住，任务长到上限时 OpenCode 压缩照样兜底（两者一起用的情况还没测过）。

## 3. 步骤和标签

- 一步 = 一条助手消息：思考、正文、工具调用和这些调用的输出。
- 插件给工具输出加 `[turn N]`，一步调了几个工具就是 `[turn N.k]`。模型看到的说明、标签和 KEEP 都叫 turn，不叫 step：bug-fix 提示词和 Stage Tool 里的 step 指工作流阶段，用同一个词容易把 `KEEP: 3` 读成第 3 个阶段。代码和本文仍叫"步"。
- 编号从模型现在看得到的第一步算起：OpenCode 压缩之后、阶段层切换阶段之后，都从 1 重新编号（第 12 节）。
- 收起时整步换成一条 `[context-manager]` 消息，同一次收起的连续几步合成一条。后来收起的步骤即使紧挨着，也单独成一条：摘要一旦发出就不再改，前缀缓存才不会从更早的位置失效（2026-10-28 前会合并改写旧摘要，如 723 的 `turns 20-21` → `20-24` → … → `20-36`，每次都从第 20 步起重发，而日志里的 reread 只从新收起的步骤算起）。

## 4. 模型写什么（`turns: "ask"`、`summary: "note"`）

**默认**：每次回复开头写一行 NOTE；到了要决定的时候，插件在请求末尾列出这次要决定的轮次，模型在 NOTE 前面写一行 KEEP。提示里只给格式，不给示例：

```
NOTE: <1-3 sentences: your own observations and conclusions from the output you just received, saying so when one is a guess, or `-`>
KEEP: <the listed turns whose output you still need for the rest of the task, such as `3, 7`, or `-` if none>
```

- `NOTE` 只写模型自己的观察和结论（猜测要说明是猜测），记在上一步名下，那一步收起时放进摘要。调用了什么、结果如何由插件按规则记录（第 6 节），不要模型写。
- `KEEP` 只在被问到时写。问的时候请求末尾是 `[context-manager] These turns are about to be let go: 12 read list.rs · 13 bash cargo build · … Begin this response with KEEP: …`；其余请求末尾只提醒写 NOTE。插件只在边界移动时用 KEEP，以前每次都写，三次里两次白写；列出轮次也让模型知道这次决定的是哪几轮（2026-10-29 起）。
- KEEP 行里既没有轮次号也不是 `-`（例如模型把 OpenCode 的截断提示抄进了 KEEP），当作没写。
- 两个标签照写英文（"Write the labels KEEP and NOTE in English, as shown."）：GLM 有时写成"保留：… 注意：…"，插件认不出，那一次就当没写。
- 提醒和提问都只在请求里，不存进会话。
- 以前的 `ask`（方案二：平时什么都不写，要收起时问一次 KEEP 和 NOTE）已并入默认方式。

**只用其中一个**：`turns: "ask"` 而 `summary` 不是 `"note"` 时，只问 KEEP，说明和提问里都不提 NOTE；`summary: "note"` 而 `turns` 不是 `"ask"` 时，只要 NOTE，不加轮次标签、不问 KEEP。两个都不用时，模型什么都不写，也看不到任何说明。原来的选项 `keep` 在 2026-10-30 换成了这两个选项，`"none"` 对照组去掉。

## 5. 什么时候收、收哪些

1. **到期再问**（来自 ReFold 3.2 节公式 4：STALE 只收最近 k 步内的）。第 t 步时，第 `3 × ⌊(t − 9) / 3⌋` 步之前、还没问过的步骤到期；边界每 3 步动一次。
   - 为什么等 9 步：模型列在 KEEP 里的步骤，一半在 2 步内放掉，75% 在 5 步内，90% 在 11 步内（242 个步骤）。按 ReFold 的 3 步就定，模型往往还不知道后面要不要。代价是最近 9–11 步始终完整。
   - 比自己的摘要还短的步骤（例如输出只有 "ok"）不问、不收，原样留下。
2. **模型同意**：边界移动时请求末尾列出要决定的轮次：刚到期的、以前留下的大轮次（超过 2000 token）、放掉了但还没收起的。这次回复的 KEEP 列出的留下，其余放掉。没写 KEEP 就什么都不定，下一个请求接着问（日志里记一条 `waiting: true` 的 `check`）。不沿用更早的 KEEP：它可能已经过时。
   - **放掉是最终的，留下可以改**（2026-10-29）：以前留下的轮次永久保留。但模型的判断会变：tokio 那次第 9 轮（14k 的读取）模型第 37 轮后就不再列它，却一直占到第 51 轮；2209 第 4 轮第 15 轮后就不列了，又占了 48 轮。现在大轮次每次边界都再问一次，不再列就放掉；小轮次留下就不再问（再问的输出和打断缓存都不划算）。
   - **收起前可以收回**：放掉的轮次要等租金攒够才收起，这期间 KEEP 又列出它就留下，模型漏写一次也有缓冲。收起之后不能恢复（restore 工具试过，几乎没人用，已删）。
   - 当初定了就冻结，是怕回头去收很早的轮次、从很前面打断缓存。现在由先租后买算这笔账：越早的轮次收起时要重发的越多，要攒越久才收，不划算就一直不收。
   - **不问模型**：`turns: "recent"` 时到期的步骤一律放掉，等于模型每次都答 `KEEP: -`；`turns: "off"` 时不放掉任何步骤。
3. **先租后买**：模型放掉的步骤不马上收，等"留着的花费"累计到"收起的花费"时才收。
   - 收起一段能少发的 token 记作"省下"（`removed`），从第一个被收起的步骤到当前、收起后要按全价重发的记作"重发"（`reread`）。缓存读价格是全价的 c（选项 `cache`，默认 0.1；GLM-5.3-Flash 是 0.2）。
   - 留着：每次请求多付 `c × 省下`，这是"租金"。收起：一次多付 `(1 − c) × 重发`，这是"买价"。每次请求累计租金，累计到买价就收起。
   - 每次决定放掉的轮次各成一组，各算各的租金。收起一组要重发它后面的所有内容，所以后面的组最好跟它一起收：每次请求看"从某一组起、后面所有组一起收"，这些组的租金加起来够付这次重发就一起收（几种起点都够时取省得最多的）。小组合起来付一次买价，缓存只断一次。
   - 例：723（v2，各组单独收）里第 9–12 轮第 21 轮放掉、第 60 轮才收，最后第 66、67、68 轮连续三次收起各断一次缓存。
   - 不用猜还剩多少轮：不论任务在哪一轮结束，花费最多是"事先知道结局时最优做法"的 2 倍（ski rental 问题）。短任务里小收起永远付不够租金，不收；长任务里大收起很快付够，照收。
   - 例：1642（26 轮），到期就收会收 5 次、比不装插件贵 57%；先租后买一次不收，只多 1%（说明和标签）。
   - 依据（2026-10-28 回放）：50 个记录下来的运行，按严格前缀缓存计价，c = 0.1 时比不装插件总共省 15%（到期就收 +0.3%，剩余≈已过 −8%，省下≥重发 −3%，至少省 1000 −8%），50 个里只有 5 个比不装插件贵 2% 以上；c = 0.2 时省 22%。
   - 只适用于严格按前缀缓存的服务商（Anthropic、OpenAI、DeepSeek、智谱官方等）。像 llm.pm 那样中间改动后后面照样命中缓存的，收起几乎不花钱，这时把 `cache` 设成 1 就是"放掉就收"。
   - 之前的规则：`省下 ≥ 3 × 重发`（太保守，几乎不收）；"剩余轮数 ≈ 已进行轮数"（2026-10-26 到 27）；到期就收（2026-10-27 到 28，在严格前缀缓存上 input 涨到约 4 倍）。第 10 节的实验数据是前两种规则下的结果。
   - `timing: "now"`：放掉就收，等于 `cache: 1`。
4. **过时的文件查看**（选项 `stale`，默认关，2026-10-30）：只换掉那一份输出，这一步的其他内容不动。
   - 例：`[context-manager] output folded: read src/a.rs lines 1-300; these lines were shown again later.`
   - 两种过时：后面又看了同样几行（全部覆盖），随时可以收，不管 KEEP；后面改了这个文件（`edit`、`write`），要等过了边界（满 9 步）才收，`turns: "ask"` 时不收，由 KEEP 决定。
   - 认得的查看：`read`，以及不带管道的 `sed -n 'A,Bp' f`、`cat f`、`head f`（相对路径按 bash 的 `workdir` 补全）。
   - 和放掉的步骤一样走先租后买，到时一起收。
   - 依据：默认组合下，每个请求平均还带着 4–19% 的过时输出（6 次运行，2026-10-30）。

## 6. 摘要里有什么

```
[context-manager] turns 1-3 folded:
turn 1 grep _bound_items (ok) -> Found 35 matches | ...
turn 2 read /testbed/django/forms/forms.py lines 380-420 (ok): 389: def _clean_fields(self): | 408: def _clean_form(self):
  At turn 3 you thought: `_clean_fields` (line 389) reads self.data directly instead of going through BoundField.
  389: def _clean_fields(self): | 390: for name, bf in self._bound_items():
turn 3 edit /testbed/django/forms/forms.py (failed: oldString not found in content)
```

按轮次逐条，全部由规则从调用和输出里抽取，只有 "At turn N you thought" 来自模型。写成"第 N 轮时你认为"，是提醒模型这是当时的看法，后面的轮次可能已经推翻（tokio 那次第 12 轮的"根因在 reclaim_blocks"被推翻后仍以 "You noted" 留在摘要里）：
- **操作记录**：每个调用的工具、文件或命令，以及结果：`ok`、命令失败时 `exit N`、调用出错时 `failed:` 加错误的第一行。失败的修改在摘要里看得出是失败的（ripgrep-723 里模型曾因看不出而怀疑自己把测试加了两遍）。
- **查看文件**（`read`，以及 `sed -n`、`cat`、`head`、`tail`、`nl`）：文件、行号范围，范围里的类、函数、方法签名（带行号，最多 20 个）。行号取自输出本身（`read`、`grep -n`、`cat -n`），或从不带管道的 `sed -n 'A,Bp'`、`cat`、`head` 推算。
- **搜索**（`grep`、`glob`，以及 `grep`、`rg`、`find`、`ls` 开头的命令）：前 5 条命中。
- **模型的 NOTE**（同一段里相同的只写一次）。
- **NOTE 点到的行**：NOTE 里的行号（`line 389`、`lines 742-770`、`file.py:389`）和代码样式的名字（反引号里的，带 `_`、`.` 或驼峰的），在这一步输出里对应的行，再加各自的下一行；最多 10 行，每行最多 160 字符。一个名字在输出里出现超过 5 次就不用它挑行。

摘要比原步骤还长时不收，摘要越长省下越少、付够租金越慢（都按摘要的实际长度算）。

选项 `summary`：`"note"` 就是上面这样；`"rule"` 没有 NOTE 和 NOTE 点到的行（也不要模型写 NOTE）；`"placeholder"` 每个调用只写一行，如 `turn 2 read /testbed/django/forms/forms.py (ok)`。

## 7. 上下文大了再启用（选项 `start`，默认 10000 token）

消息没到这个大小之前，插件什么都不改：不加说明、不加标签、不要 KEEP、不收起，短任务没有任何额外开销。到达的那一步之后插入一条 `[context-manager]` 消息，内容是说明加上之前各步的编号和做了什么；之后的输出才加标签。启用后的第一条 NOTE 按规则记在启用前的最后一步名下，那些步骤收起时随之进入摘要。曾在这条消息末尾请模型用这条 NOTE 总结之前所有步骤（"Your next NOTE covers all of them."），但模型基本不理会，写的仍是接下来的打算，2026-10-27 删掉。系统提示和任务文字始终不改，以免整段缓存失效。`start: 0` 表示从第一个请求就启用。

## 8. restore 工具（2026-10-27 去掉）

原来有一个 restore 工具，把收起的步骤按当时的样子原样显示。所有真实运行里一次都没用过：模型需要时直接重新读文件或重跑命令，被收起的文件多数在中间改过，重新读才是对的。它每次请求都占工具说明的 token，于是去掉，连同只为它服务的 `compacted()` 和阶段层的 `window()`。

## 9. 选项

**模块**：每个选项管一件事，可以任意组合；默认是第一个值。

| 选项 | 取值 | 管什么 | 详见 |
|---|---|---|---|
| `turns` | `"ask"` / `"recent"` / `"off"` | 哪些旧步骤放掉：问模型（KEEP）/ 满 9 步就放掉 / 不放掉 | 第 4、5 节 |
| `stale` | `false` / `true` | 过时的文件查看单独收起 | 第 5 节第 4 条 |
| `summary` | `"note"` / `"rule"` / `"placeholder"` | 收起的步骤换成什么：规则摘要加 NOTE / 规则摘要 / 只写调了什么 | 第 6 节 |
| `timing` | `"rent"` / `"now"` | 什么时候收：先租后买 / 放掉就收 | 第 5 节第 3 条 |

模型看到的额外内容跟着模块走，不单独设选项：轮次标签和 KEEP 提问只在 `turns: "ask"` 时有；NOTE 提醒只在 `summary: "note"` 时有；说明只要有其中一个就有。都没有时，第一次收起之前请求和不装插件时完全一样。

几个组合：

| 组合 | 选项 |
|---|---|
| 默认：模型说留哪些，摘要带 NOTE，先租后买 | `{}` |
| 纯规则：模型看不到任何说明 | `{"turns":"recent","summary":"rule"}` |
| 只收过时的文件查看 | `{"turns":"off","stale":true,"summary":"rule"}` |
| ReFold 式：问模型、放掉就收 | `{"summary":"rule","timing":"now"}` |

**其他选项**

| 选项 | 默认 | 说明 |
|---|---|---|
| `start` | `10000` | 消息到多少 token 才启用；0 = 一开始就启用 |
| `cache` | `0.1` | 缓存读的价格占全价的比例，`timing: "rent"` 用它算账（第 5 节） |
| `log` | 项目的 `.opencode/context-manage.jsonl` | 启动时写一行当前的选项（`"type":"config"`），之后每个请求写一行：步数、收起了哪些步骤和输出、最近一次检查、KEEP、NOTE；可写别的路径，`false` 不写 |
| `stage` | 开启，用自带的 `src/stage/default-config.json`；安装时写的是项目的 `.opencode/bugfix-adaptive-context.config.json` | 阶段层配置文件的路径（相对路径按项目目录算），`false` 关掉，见第 12 节 |

选项写在安装生成的入口 `.opencode/plugins/context-manage.js` 的一行 `OPTIONS`（一行 JSON），例如：

```js
const OPTIONS = {"stage":".opencode/bugfix-adaptive-context.config.json","turns":"recent","summary":"rule","start":10000}
```

## 10. 目前的证据

- **上下文一直被控制住**（三个模型、Python 和 Rust 都成立）：GLM 在 sympy-13878 上，不装插件第 70 步上下文 36k，装插件稳定在 15–19k；每次请求便宜 20–40%。
- **长任务总成本下降**：步数相近时省 20–40%，例如 ripgrep-1980 方案二 −28%、ripgrep-723 方案一 −23%、sympy-13878 带 NOTE 的两个方案 −37% 到 −43%。
- **没看到解题率下降**：插件真正起作用的题目上，各条件解出情况相同或更好。
- **还没确定**：每个条件大多只跑了一次，步数波动常常比插件的影响还大；短任务的总成本比不出来；没做统计检验。

## 11. 还没做的

- 缓存写入要加价的服务商（如 Anthropic 加 25%），每次收起多付一份写入费，买价里还没算这一项。
- 同一个文件读了不同行段，现在按步整体处理。
- 输出按真实价格（通常比输入贵）重新核算节省。

## 12. 阶段层（选项 `stage`）

2026-10-20 并入，2026-10-23 升到 State v9 / Config v2（原包 2026-10-22 版）。代码在 `src/stage/`，来自 Stage-Only 消融版。两层分工：阶段层管阶段之间，本插件管阶段之内。

2026-10-29 同步当前 Stage-Only，包括 10 月 23 日的缓存诊断 v2；不是只保留旧阶段核心。
阶段入口仅有目录、配置路径和 Tool 注册的接入适配，同步时用源码一致性和配对执行测试核对过（该测试 2026-10-30 已删除）。
外层转发全部阶段 Hook，System 诊断在外层可选指令之后执行；fetch 仍观察最终序列化请求。
阶段 Profile 的入口审计和 Token 指标在阶段内折叠之前生成，不应作为两层合计节省指标。

**阶段层做什么**（详见原包 README）：只对配置里的 agent（默认 `bug-fix-adaptive`）生效。agent 调 `bugfix-adaptive-stage` 声明阶段；真正从阶段 A 切到阶段 B 时，A 的消息全部不再发送；最前面放一条固定的 Carrier（说明、原始任务、Registry/Plan 路径，以及从 Registry YAML 读出的当前阶段规则）。真正切换阶段时，模型必须在 Stage Tool 的 `handoff` 参数里写一段交接（没有可交接的就传空串），交接内容留在这次工具调用里；压缩把这次调用藏掉后，阶段层再补一条交接消息。状态存在项目的 `.opencode/bugfix-adaptive-context.state.json`，审计写 `.opencode/bugfix-adaptive-context.jsonl`。

**怎么合在一起**：同一次 transform 里先跑阶段层，再在它留下的消息上跑本插件。例：进入 `issue-analysis` 后，请求是

```
[Carrier：阶段 issue-analysis、路径、任务]
step 1  bugfix-adaptive-stage issue-analysis        ← 编号从这个阶段开始
[context-manager] steps 2-3 folded: read c.py · ...  ← KEEP 折叠只在本阶段里
step 4 ...
```

- 编号、边界（每步满 9 步才定）、`start` 都在当前阶段内从头算。阶段切换时缓存本来就全部失效，从头编号不多花钱。
- 先阶段层后折叠，所以阶段层找边界时看到的总是原始消息，折叠不会影响它。
- 调了 Stage Tool 的那一步永远不收起：它的参数里带着 handoff，收起就会把交接从请求里拿掉。例：进入 `root-cause-localization` 时 handoff 写了"bug 在 forms.py 389 行"，几步后模型的 KEEP 没列 turn 1，turn 2 起照常可以收，turn 1 原样保留。
- Stage Tool 由插件注册，不装到 `.opencode/tools/`。
- 目标版本是 OpenCode 1.2.27（原包测试的版本）。1.2 调用插件时只传 `input`，并把插件文件导出的每一项都当函数调用（`plugin/index.ts`），`opencode.json` 的 `plugin` 也只能写字符串。所以 `src/index.ts` 导出 `server(input, options)`，安装时写的入口 `.opencode/plugins/context-manage.js` 只导出一个函数 `ContextManage`，把其中一行 `OPTIONS` 传进去。2026-10-26 之前入口导出的是 1.15 的 `{ id, server }` 对象，1.2 上加载失败，插件完全不运行。
- 安装（`install.mjs`）照原包：复制 `src/` → `.opencode/plugins/context-manage/`，命令行、`--replace` / `--replace-config` / `--reset-state`、配置文件 `.opencode/bugfix-adaptive-context.config.json`、备份和 `.gitignore` 都与原包相同。OpenCode 自动加载 `{plugin,plugins}/*.{ts,js}` 顶层文件（子目录不会被单独加载），加载前把与自身版本一致的 `@opencode-ai/plugin` 装进 `.opencode/node_modules`（`Config.waitForDependencies`）。代价：断网且无缓存时依赖装不上，整个插件加载失败。

**OpenCode 1.2.27 的压缩**：摘要输入不经过 Messages Transform，原包按这个设计（`inputIsolation: native-unscoped`），本插件不另做处理。实测（`bun run e2e:compaction`，6 个场景）：摘要归属、续跑、跨进程恢复、溢出兜底都照常工作，压缩后的第一次 transform 已经带着完成的摘要。

**压缩后的编号**：和切换阶段一样处理。1.2.27 压缩后只发送压缩消息、摘要和之后的新消息（`MessageV2.filterCompacted`），所以请求里本来就从 1 编号，压缩前写的 KEEP 也不在请求里。

不装阶段层时同样如此。

**还没解决的**

- 只用假 Provider 验证过数据流。提示词和 Registry 已有（2026-10-20 用户提供），但本机没有 Registry 里的 skill 和 `initialize-bugfix-workspace`，真实模型下两层叠加的遵从率和费用都还没测。
- 提示词要求 Registry 只读一次、Work Plan 写后不再读。同一阶段内，模型没 KEEP 这两步时它们会被收起，收起的摘要里没有 YAML/JSON 内容。按通用规则不为它们写特例，留到真实运行时观察。
