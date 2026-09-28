# dsh-webtokens-lite

把**你自己电脑上的 DeepSeek 网页**接成中转站（或任何 OpenAI 兼容调用方）的一个上游：
请求投给这台电脑，由这台电脑自己的浏览器、自己的 DeepSeek 账号作答。
**额度、内容、历史都留在你自己的账号里**，中转站按 0 token / 0 花费记账。

实现是**自研的**（这个仓库自己就有全部代码：扩展 + broker + 连接器）：

```
调用方（中转站 / DSH / 任何 OpenAI 兼容程序）
   │  OpenAI 请求
   ▼
连接器（本仓库，跑在这台电脑上）──► 本机 broker（127.0.0.1:3081）
   │  长轮询中转站取任务                    ▲
   ▼                                      │ 扩展主动轮询取任务
中转站                                     │
                                    浏览器扩展（本仓库 extension/）
                                           │
                                           ▼
                                  你自己已登录的 chat.deepseek.com
```

- **不需要 API Key**，凭据是这台电脑的配对令牌；
- **不拉任何上游第三方代码、不做哈希校验、不需要 `npm install`**（零依赖，只要 Node ≥ 22）；
- 一轮问答实测约 **2~4 秒**（网页停止生成即回传，不再固定等 5 秒）。

## 一、一条命令安装（推荐）

```powershell
& ([scriptblock]::Create((irm <你的中转站>/agent/runner/webbridge.ps1))) -Pair <配对码> -Server <你的中转站>
```

- `<配对码>`：形如 `ABCD-EFGH`，在**中转站控制台**「＋ 添加我的电脑」里生成（只能人工拿）。
  暂时没有就先 `-Pair NONE`：只装不配对，之后再补。
- 脚本**幂等**：重复运行只会补齐缺失的部分；**不需要管理员权限，也不需要预装 Node**（自带便携版）。
- 它做的事：装 Node → 从中转站下载客户端 → `node setup.mjs --bridge=own` 铺出扩展目录
  `chrome/` 并生成本机配对密钥 → 配对中转站 → 写开机自启 → 打印接下来两件只能人工做的事。

### 装完只剩两件人工的事

1. **把扩展装进浏览器**：打开 `edge://extensions`（或 `chrome://extensions`）→ 开「开发人员模式」
   → 点「加载解压缩的扩展」→ 选安装目录里的 **`chrome`**；
   卡片名应为 **DeepSeek 网页桥接（自研）**（版本号以安装器最后打印的那行为准）。
2. **在那个浏览器里登录** <https://chat.deepseek.com/> 并保持登录。
   扩展会自己开一个**专用会话标签页**，不要在那个会话里手动输入或删消息。

> 为什么这两步不能自动化：Chromium 要求人点（`--load-extension` 在新版已移除，
> `edge://` 特权地址也无法从命令行打开）。安装器会**自动打开扩展页并把目录复制到剪贴板**。

### 装完之后，日常只需要这三个免路径入口

安装器会在**你选定的安装目录**里生成三个小命令（用 `%~dp0` 自己定位，装到哪都能用）：

| 双击 | 作用 |
|---|---|
| `doctor.cmd` | 自检：Node / 密钥 / 扩展目录 / 桥接是否在跑 / 是否已配对 |
| `status.cmd` | 看桥接与扩展的连接状态 |
| `stop.cmd` | 停掉本机桥接 |

**更新**：安装器会拿**整包指纹**与服务器对比，发现服务器更新了就自动覆盖式升级
（**配对令牌不会被覆盖**），并提示你去扩展页点一次「重新加载」。
所以升级只需要**重跑同一条安装命令**，不会掉配对、也不需要删目录重装。

## 二、从源码跑（开发用）

```bash
git clone <本仓库地址> dsh-webtokens-lite
cd dsh-webtokens-lite
node setup.mjs --bridge=own          # 铺出 chrome/ + 生成 config.json（本机配对密钥）
node setup.mjs --doctor              # 自检
npm start                            # 起本机 broker(3081) + 中转站连接器
node setup.mjs --pair ABCD-EFGH --server https://你的中转站   # 配对（可选）
```

- `--bridge=own`：用本仓库的自研实现（安装器默认就走它）。
  `--bridge=upstream` 是历史遗留的另一条实现，**不建议**（要联网拉上游第三方代码）。
- 两种写法都支持：`--bridge=own` 与 `--bridge own`；解析不出来会**明确报错**，不会静默换实现。

## 三、安装器可用参数

| 参数 | 说明 |
|---|---|
| `-Pair <code>` / `-Pair NONE` | 配对码；`NONE` = 只装不配对 |
| `-Server <url>` | 中转站地址 |
| `-Root <dir>` | 安装目录（默认 `%LOCALAPPDATA%\dsh-webtokens-lite`，**每台机器可以不同**） |
| `-Port <n>` | 本机桥接端口（默认 3081；**仅测试用**，扩展侧写死 3081） |
| `-NoAutostart` / `-NoStart` / `-NoOpen` | 不写自启 / 装完不启动 / 不自动开浏览器 |
| `-Doctor` | 只自检 |
| `-Force` | 强制重新下载客户端（版本指纹没差异时也能强制重装） |

## 四、边界与代价（请如实告诉你的使用者）

- 用的是**这台电脑自己的** DeepSeek 网页额度；中转站记 0 token / 0 花费；
- 一次回答实测约 **2~4 秒**；网页端**同一时刻只跑一个任务**，排队过深会被拒绝（429）；
- 多步 Agent 任务会连续占用这条通道，容易撞 429（在中转站多配一台电脑可提高并发）；
- 发送的内容会出现在**这台电脑自己的** DeepSeek 网页会话历史里，并发往 DeepSeek 服务器；
- 运行期间需要：这台电脑开机、浏览器开着、DeepSeek 保持登录。

## 五、卸载

```powershell
# 1) 先停桥接（安装目录里双击 stop.cmd，或）
Get-NetTCPConnection -LocalPort 3081 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 2) 删掉你安装时用的那个目录（默认 %LOCALAPPDATA%\dsh-webtokens-lite；传过 -Root 的按那个来）
Remove-Item -Recurse -Force "<你的安装目录>"
# 3) 删自启快捷方式
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-webtokens-lite.lnk') -ErrorAction SilentlyContinue
```

再到 `edge://extensions` 里移除那个扩展，并在中转站控制台删掉这台设备。

## 六、自证

```bash
npm test        # 221 项：协议解析 / broker / 扩展逻辑 / 自研调用 / 补丁 / 参数解析 / 宿主自检
```

> 本 lite 的 broker **只提供扩展面**（`/ext/poll|progress|result`、`/task`、`/status`）。
> OpenAI 兼容面（`/v1/models`、`/v1/chat/completions`）在 **DSH 插件那份实现**（`dsh-web-bridge-own`）里，
> 两份实现的 broker 其余逻辑逐行相同 —— 这里刻意不重复实现，免得两处漂移。
