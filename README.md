# dsh-webtokens-lite

把**你已经登录的 DeepSeek 网页**变成你自建 LLM 中转站里的一个模型 —— **不需要 API Key，消耗的是你网页账号的额度**。

```
你的应用（任何 OpenAI SDK）
   │  relay key
   ▼
你的中转站 ──► 本机连接器（本仓库）──► 本机桥接 127.0.0.1:3081
                                            │
                                            ▼
                                    你自己的浏览器扩展 ──► chat.deepseek.com（你已登录的账号）
```

**特点**

- **工具调用（function calling）可用**：网页返回的工具请求会被逐条校验参数后再回传，支持"调用 → 拿到结果 → 继续"的往返。
- **不需要 API Key**，不绕过登录，也不解锁你账号没有的模型。
- **本仓库不含任何上游第三方代码**（见下面「关于上游」），按固定 tag 拉取并逐文件 SHA-256 校验。

**明确的边界**（都是事实，不是免责声明）

| 项目 | 说明 |
|---|---|
| 用量统计 | 网页端**不提供真实 token 用量**，本方案也拒绝伪造 → 中转站里这个模型记 **0 token / 0 花费** |
| 采样参数 | 网页端没有 `temperature` / `stop`，传了会被忽略 |
| 并发 | 一个浏览器同时只处理一轮，多个请求会排队 |
| 图片/多模态 | 仅文本；图片块会被省略 |
| 前提 | 这台电脑要开着、浏览器要开着、扩展要加载、DeepSeek 要保持登录 |
| 超时 | 本机等网页 240s；中转站侧投递预算需设为 300s（见 [docs/relay-side.md](docs/relay-side.md)） |

## 一键安装（推荐）

如果你的中转站托管了安装脚本（见 [docs/relay-side.md](docs/relay-side.md) 的「托管一键安装器」），
在 Windows PowerShell 里**一行命令**即可装完全部（含便携 Node，不需要管理员、不需要预装任何东西）：

```powershell
irm https://<你的中转站>/agent/runner/webbridge.ps1 | iex
```

无人值守（把配对码当参数传，适合脚本或 AI 代跑）：

```powershell
& ([scriptblock]::Create((irm https://<你的中转站>/agent/runner/webbridge.ps1))) -Pair ABCD-EFGH
```

安装器会自动：装便携 Node → 下客户端 → **按固定 tag 拉上游并逐文件 SHA-256 校验** → 生成配对密钥
→ 铺扩展目录 → 配对中转站 → 写开机自启 → 打开浏览器并把扩展目录放进剪贴板。

**装完只剩两件必须人工做的事**（脚本会大字标出）：① 浏览器开发者模式加载解压扩展；② 登录 DeepSeek。

> **给 AI 用的安装协议**：[docs/agent-install.md](docs/agent-install.md)（步骤、参数、输出约定、
> 人工交接、验证、故障处理、卸载；也可直接 `irm <你的中转站>/agent/runner/webbridge.md` 取到）。

## 环境要求

- **Node.js 22 或更高**
- 一个 **Chromium 系浏览器**（Chrome / Edge / Brave…）
- 一个**已登录**的 DeepSeek 网页账号

## 安装

```bash
git clone <本仓库地址> dsh-webtokens-lite
cd dsh-webtokens-lite
npm install
npm run setup
```

`npm run setup` 会做四件事：

1. 按固定 tag 拉取上游桥接插件，**逐文件校验 SHA-256**（43 个基线文件全部一致才继续）；
2. 生成本机配对密钥（`config.json`，**不要外传、不要提交**）；
3. 铺出扩展目录 `chrome/`（路径会自动复制到剪贴板）；
4. 打印接下来那两件**只能人工做**的事。

> 如果要把本机接入中转站，在控制台「＋ 添加我的电脑」拿到配对码后：
> ```bash
> npm run setup -- --pair ABCD-EFGH --server https://你的中转站地址
> ```

## 两件人工的事（无法自动化）

**① 把扩展装进浏览器**

打开 `edge://extensions`（或 `chrome://extensions`）→ 打开**开发人员模式** → 点**加载解压缩的扩展** → 选择：

```
<本仓库目录>/chrome
```

确认卡片名称为 **DeepSeek Harness 网页桥接**、版本 **0.2.19**。

> - 同一个浏览器配置里**只装一份**；也**不要**去加载 `vendor/.../extension`，那个目录缺少配对文件。
> - 为什么不能自动化：`--load-extension` 在新版 Chromium 已被移除，且 `edge://` 特权地址无法从命令行打开（实测）。这一步只能人来点。

**② 在那个浏览器里登录 DeepSeek**

打开 <https://chat.deepseek.com/> 并登录，保持登录状态。扩展会自己开一个**专用会话标签页**：

> ⚠️ **不要**在那个专用会话里手动输入或删除消息 —— 那是桥接的工作台，插一脚就会打乱它。

## 启动

```bash
npm start          # 或双击 start.cmd / ./start.sh
```

- 同时拉起**本机桥接（127.0.0.1:3081）**和**中转站连接器**，一个窗口，Ctrl+C 一起退出。
- 启动时会提示扩展是否连上；之后每 5 分钟一次心跳。

自检：

```bash
npm run doctor
```

会检查：Node 版本、上游副本哈希、密钥与扩展目录是否一致、桥接是否在跑、扩展是否连接、是否已配对中转站。

## 排障

见 [docs/troubleshooting.md](docs/troubleshooting.md)。最常见的三种：

| 现象 | 原因 | 处理 |
|---|---|---|
| 调用一直不返回，之后超时失败 | 专用标签页被浏览器**睡眠/资源节省**挂起成白屏 | 关掉「睡眠标签页」；或把 `chat.deepseek.com` 加入永不休眠；手动刷新那个标签页 |
| 提示扩展未连接 | 扩展没加载 / 浏览器没开 / 加载错了目录 | 看 `npm run doctor` 的输出 |
| 端口 3081 被占用 | 本机已经跑着另一套桥接（例如 DSH 的插件） | 一个端口只能跑一套，二选一 |

> 进阶：想看桥接内部阶段，可读上游审计日志（需先建目录，上游自己不会建）：
> `vendor/dsh-web-bridge/plugins/dsh-web-bridge` 的事件由宿主写入；本 lite 包在 `start.mjs` 里只打关键事件。

## 关于上游（重要）

- 上游项目：[`xinyuquan985-coder/DSH-webtokens`](https://github.com/xinyuquan985-coder/DSH-webtokens)
- 它**没有声明任何开源许可证**（无 LICENSE 文件、`package.json` 无 `license` 字段、扩展 manifest 也无声明）。
  **没有许可证 = 默认保留所有权利**，因此本仓库**不再分发**其任何代码。
- 本仓库的做法是：`setup.mjs` 在你自己的机器上按固定 tag（`v0.2.15-deepseek`）下载，
  并用上游自带的 `SOURCE.json` 对 43 个基线文件逐个校验 SHA-256。校验不通过就中止。
- 本仓库的 `LICENSE`（MIT）**只覆盖本仓库自己的代码**，不覆盖上游代码。上游代码的著作权归属其原作者。
- 如果你是该上游作者并希望调整署名或许可方式，欢迎开 issue。

## 目录结构

```
setup.mjs            一次性初始化（拉取+校验+密钥+扩展目录+可选配对）
start.mjs            启动本机桥接 + 连接器
start.cmd / start.sh 双击启动
lib/
  config.mjs         路径与配置、超时分层
  upstream.mjs       按引用拉取上游 + SHA256 校验
  host.mjs           拉起本机桥接（复用上游 broker.js）
  bridge.mjs         OpenAI 请求 ⇄ 网页桥接协议（复用上游 protocol.js/remote.js）
  agent.mjs          配对中转站 + 长轮询 + 处理 web_prompt
docs/
  relay-side.md      中转站侧怎么接（上游登记、默认设备、投递契约）
  troubleshooting.md 常见故障与处理
vendor/              运行时拉取（.gitignore，不入库）
chrome/              运行时生成（.gitignore，不入库）
```
