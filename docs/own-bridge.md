# 自研桥接（own-bridge）设计与规格

> 目标：把「上游插件 + 上游扩展」整体替换成**我们自己的实现**，从而
> ① 彻底摆脱"没有许可证"的约束（100% 自有代码，可自由分发、可上架商店、可预打包）；
> ② 把那几处影响体验的点（5 秒稳定判定、45 秒阈值、会话轮换）收回自己手里；
> ③ 安装链路变简单（不再按 tag 拉取 + 校验 43 个哈希）。

现状与回滚见备份目录 `dsh-webtokens-backup-*/README-回滚说明.md`；两个仓库都打了
`pre-own-bridge` 标签。

## 1. 与上游的关键差别：分工更"薄"

| | 上游 | 我们 |
|---|---|---|
| 扩展职责 | 提交 + 盯 DOM + **解析答复 + Ajv 校验工具参数 + 格式纠正** | **只做**：提交提示词、观察生成状态、把答复**原文**取回 |
| 谁解析 | 扩展（`protocol.js` 在扩展侧 + 插件侧各一份语义） | **客户端**（`lib/protocol.mjs`） |
| 谁约束格式 | 扩展的 `repair.js` 纠正循环 | 客户端的 FORMAT_GUARD（已验证：对抗"禁止输出 JSON"仍成功）+ 重试 |
| 好处 | — | 扩展从 ~1200 行降到几百行；**协议迭代不用重新加载扩展**；解析可单测 |

## 2. 三个进程与两条边

```
┌─────────────┐  HTTP 127.0.0.1:3081   ┌──────────────┐
│  浏览器扩展  │ ⇄  /ext/*  (Bearer)   │   我们的      │
│ (自有, MV3) │                        │   broker     │
└─────────────┘                        │ (lib/broker) │
        ▲ 驱动                          └──────┬───────┘
        │  /run 消息                            │ /task (Bearer) ⇄ NDJSON
┌─────────────┐                                │
│ chat.deepseek│                        ┌──────┴───────┐
│   网页标签页 │                        │  客户端       │
└─────────────┘                        │ (lib/bridge) │
                                       └──────┬───────┘
                                              │ 连接器长轮询（沿用现有）
                                       ┌──────┴───────┐
                                       │   中转站      │
                                       └──────────────┘
```

### 2.1 扩展 → broker（扩展主动轮询，无需服务端内推）

| 端点 | 请求 | 响应 |
|---|---|---|
| `POST /ext/poll` | `{clientId, version, state, busy}` | `{task}` 或 `{}`（长轮询，最多 20s） |
| `POST /ext/progress` | `{taskId, lease, phase}` | `{ok:true}` |
| `POST /ext/result` | `{taskId, lease, ok, text, error, metrics}` | `{ok:true}` |

### 2.2 客户端 → broker

| 端点 | 说明 |
|---|---|
| `POST /task` | Bearer 鉴权。请求 `{id?, prompt, timeoutMs, sessionKey?}`；响应为 **NDJSON 流**：`{"type":"progress","phase":"…"}` … `{"type":"result","ok":true,"text":"…"}` |
| `GET /status` | `{connected, worker:{version,state,seenAgoMs}, queued, active, tokenOk}`——**保持与上游同形**，这样安装器/中转站现有的健康检查不用改 |

### 2.3 必须保留的上游安全性质（踩过/审过都值得留）

1. **Token 鉴权**：`Authorization: Bearer <43 字符配对密钥>`；扩展侧从 `local-config.json` 读。
2. **Host 校验**：只接受 `Host: 127.0.0.1:<port>`，挡 DNS rebinding。
3. **租约 lease**：每个任务发一个 lease，扩展回报时必须带对；防止旧实例把结果写进新任务。
4. **先落盘再发送 / 失败即失败**：扩展在"已提交到网页"之后若发生页面重载或脚本中断，
   **报错而绝不重发**（避免同一条提示词在用户账号里发两次）。
5. **action 白名单**：扩展能上报的动作限定为固定枚举。
6. **只信任自己的页面与 popup**：`chrome.runtime.onMessage` 校验发送方来源。

## 3. 我们自己的协议（lib/protocol.mjs）

- `buildTask({system, messages, tools, guard})` → `{id, prompt}`
  - 把 system + 对话 + 工具 schema（**已放宽**，见 `relaxSchema`）+ 输出契约拼成一段提示词；
  - 输出契约＝现成的 `FORMAT_GUARD_TEXT`（`{"request_id","kind":"final"|"tool_calls",…}` 的 JSON）。
- `parseReply(raw, {id, schemas})` → `{kind, text, calls, warnings}`
  - 从答复**原文**里提取 JSON 代码块（容忍前后散文、容忍 ```json 围栏、容忍 DSML 残留）；
  - 校验 `request_id` 与 `kind`；按调用方**原始** schema 用 `stripExtras` 剥多余字段；
  - 解析失败抛可重试错误（沿用现有 `retryable` 判定）。
- 与上游不同：**不做 Ajv 编译**（放宽 schema + 回收剥字段已在调用侧覆盖），少一个依赖（ajv 可从包里去掉）。

## 4. 我们自己的 broker（lib/broker.mjs）

- 单进程 HTTP 服务，默认 `127.0.0.1:3081`（端口可配）；
- 任务表：`{id, lease, state:'queued'|'sent'|'generating'|'done', phases[], createdAt, deadline}`；
- **单 worker 串行**（与上游一致：一个网页会话一次只跑一轮），但**准入控制在我们的连接器/中转站侧**（已有 429 逻辑）；
- 停滞看门狗、abort 传播、超时分层（沿用我们已在 bridge.mjs 验证过的那套）；
- 状态判定：扩展每 `poll` 一次即刷新 `seenAt`，`/status` 据此算 `connected`。

## 5. 我们自己的扩展（extension/，MV3）

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3；`host_permissions`: `http://127.0.0.1:3081/*` + `https://chat.deepseek.com/*`；content script + service worker + popup |
| `background.js` | 轮询 `/ext/poll`、转发 `run` 给内容脚本、上报 progress/result；`chrome.alarms` + `setInterval` 保活 |
| `content.js` | 找输入框 → 填提示词 → 点发送 → 用「停止按钮是否消失 + 文本是否停止变化」判定结束 → 取回答复原文 → 回传；支持取消 |
| `clock.js` | MAIN world 注入：请求进行中时抵消页面的渲染节流（照上游思路，仅活动请求期间生效） |
| `popup.html/js` | 显示连接状态、队列、最近错误 |
| `local-config.json` | 安装器写入的配对密钥（与扩展同目录；沿用上游做法，但现在是我们的代码） |

**稳定性判定（我们自己的规则，替代上游写死的 5 秒）**：

```
结束条件（满足任一）：
  a) 停止按钮消失 且 答复文本 ≥800ms 未变化           → 立即取回
  b) 停止按钮消失 且 答复文本看起来是完整 JSON 对象    → 立即取回
  c) 文本 ≥6s 未变化（即使停止按钮还在）              → 取回并标注 uncertain
超时：默认 240s（沿用客户端预算）
```
→ 预期把"每轮固定 9~10 秒"压到 **3~5 秒**，且不再有"5 秒没变才认"的硬等。

## 6. 迁移步骤（每步都可回滚）

1. **规格 + 自研 protocol/broker（Node 可测）** ← 当前
2. **自研扩展**（含 `clock.js`）；用 HTML 固定样本对解析/判定做单测
3. **客户端切换**：`lib/bridge.mjs`/`host.mjs` 改用自有实现；`setup.mjs` 不再拉取上游，
   改为**直接铺我们自己的扩展**；删除 `lib/upstream.mjs` 与 43 哈希校验链；包体去掉 ajv
4. **真人一步**：浏览器里「加载已解压的扩展」指向新的 `chrome/` 目录（Chromium 硬限制，无法自动化）
5. **真机端到端**：文本/工具调用/并发/取消/停滞后重试；对比延迟与失败率（基线：9.7s 中位、加固后 21% 失败率）
6. **清理**：文档改写（不再提"不含上游代码"，改成"扩展是我们自己的"）；LICENSE 增加扩展部分；
   若要做商店上架，此时才具备条件

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| DeepSeek 网页改版导致选择器失效 | 选择器集中在一个 `selectors.js`，并保留"找不到时给出可读错误 + popup 提示"；诊断信息回传（哪些选择器命中失败） |
| 反自动化/风控 | 保持"像人"的节奏（真实点击、真实输入事件、不并发）；单账号单会话 |
| 自研扩展初期不稳定 | 与上游扩展**并存**：`setup` 支持 `--bridge=own|upstream`，切换只改配置；备份里有完整旧版可回滚 |
| 我们改坏了本机 broker | broker 自带 `/status`；安装器与连接器都有健康检查；旧版在 `pre-own-bridge` 标签 |

## 8. 验收标准（重写完成的定义）

- [ ] `node setup.mjs --doctor` 不再出现"上游副本""SHA-256"字样，改为"扩展已就绪（自有 vX）"
- [ ] `irm http://127.0.0.1:3081/status` → `connected: true`
- [ ] 真实问答成功，**单轮端到端 ≤6s**（基线 9.7s 中位）
- [ ] 工具调用成功且参数无多余字段
- [ ] 并发 4×200 + 1×429，零 504
- [ ] 取消：点「停止」后浏览器侧停止生成、任务立刻失败
- [ ] 页面重载中断：**报错但不重发**（不会在账号里出现两条一样的提问）
- [ ] 仓库里不再有 `vendor/`；LICENSE 覆盖全部自有代码
