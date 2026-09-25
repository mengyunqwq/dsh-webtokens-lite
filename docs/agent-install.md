# 给 AI 的安装协议（agent-install）

> 这份文档的对象是**另一台电脑上的 AI agent**。照它执行即可把「本机网页桥接」装齐；
> 只有两步需要转交给人类，文档里用 `[HUMAN]` 标出。

## 0. 目标

在这台电脑上安装一个本机桥接：它把中转站的模型 `web-deepseek` 的请求，
交给**这台电脑自己的浏览器**里已登录的 DeepSeek 网页完成作答。
装好后这台电脑的额度与内容都留在它自己的 DeepSeek 账号里，不经过别人的账号。

## 1. 先自检（AI 执行）

| 项目 | 要求 | 检查方式 |
|---|---|---|
| 操作系统 | Windows 10/11 | `[Environment]::OSVersion` |
| PowerShell | 5.1 或更高 | `$PSVersionTable.PSVersion` |
| 管理员权限 | **不需要** | — |
| Node.js | **不需要预装**（安装器自带便携版） | — |
| 网络 | 能访问中转站域名 | `Invoke-WebRequest <SERVER>/agent/runner/webbridge.ps1 -Method Head` |

## 2. 一条命令安装（AI 执行）

```powershell
& ([scriptblock]::Create((irm <SERVER>/agent/runner/webbridge.ps1))) -Pair <配对码> -Server <SERVER>
```

- `<SERVER>`：中转站地址，例如 `https://panel.mengyun.xyz`。
- `<配对码>`：形如 `ABCD-EFGH`，**由人类在控制台「＋ 添加我的电脑」里生成**（AI 无法自助获取）。
  暂时没有配对码时可以先跑 `-Pair NONE`：只会把软件装好，不注册设备，之后再补配对。
- 不带参数直接 `irm ... | iex` 也可以：脚本会交互式询问配对码。

脚本是**幂等**的，重复运行只会补齐缺失的部分。

### 输出约定（便于 AI 解析）

每行以固定前缀开头：

| 前缀 | 含义 |
|---|---|
| `[STEP n]` | 正在做第 n 步 |
| `[OK]` | 该步成功 |
| `[FAIL]` | 失败，并给出提示；**进程以退出码 1 结束** |
| `[HUMAN]` | 必须由人类完成，AI 要把它转达并把准确路径/链接给出 |
| `[WARN]` | 非致命问题，需要留意 |

## 3. 安装器会做什么（AI 需要知道的语义）

1. 选定安装目录（默认 `%LOCALAPPDATA%\dsh-webtokens-lite`，可用 `-Root` 改）；
2. **Node**：先找 `<Root>\node\node.exe`，再找系统 PATH 里 ≥22 的 node；
   都没有就下载**便携版**（官方 nodejs.org，失败自动回退 npmmirror 镜像）解压到 `<Root>\node`
   —— **不写系统目录、不需要管理员**；
3. **客户端**：从中转站下载 `webbridge-package`（已内置依赖，**不需要 npm install**）解压到 `<Root>`；
4. **拉取上游并校验**：`node setup.mjs` 会按固定 tag 拉取上游插件，
   并用上游自带的 `SOURCE.json` **逐文件校验 43 个 SHA-256**（不通过就中止）；
5. 生成本机配对密钥、铺出扩展目录 `<Root>\chrome`；
6. 用 `-Pair` 给的码调用中转站 `/agent/runner/pair` 注册设备；
7. 写开机自启（快捷方式放到用户的「启动」文件夹），除非 `-NoAutostart`；
8. 把扩展目录路径复制到剪贴板，并尝试自动打开浏览器扩展页与 DeepSeek 网页。

### 可用参数

| 参数 | 说明 |
|---|---|
| `-Pair <code>` | 配对码；`NONE` = 只装不配对 |
| `-Server <url>` | 中转站地址（默认脚本里烤好的本站地址） |
| `-Root <dir>` | 安装目录 |
| `-Port <n>` | 本机桥接端口（默认 3081；**仅测试用**，扩展侧写死 3081） |
| `-NoAutostart` | 不写开机自启 |
| `-NoStart` | 装完不启动 |
| `-Doctor` | 只自检，不安装 |
| `-Force` | 强制重新下载客户端与 Node |

## 4. `[HUMAN]` 两件事（AI 必须转达，不能代做）

**[HUMAN] ① 把扩展装进浏览器**

- 打开 `edge://extensions`（或 `chrome://extensions`）
- 打开**开发人员模式**
- 点**加载解压缩的扩展**
- 选择目录：`<Root>\chrome`
- 确认卡片名为 **DeepSeek Harness 网页桥接**、版本 **0.2.19**

> 为什么不能代做：Chromium 要求这一步必须人点（`--load-extension` 在新版已被移除，
> `edge://` 特权地址也无法从命令行打开——实测只会开出一个空白标签页）。
> AI 能做的是：自动打开扩展页、把 `<Root>\chrome` 放进剪贴板、并把路径念给人类。

**[HUMAN] ② 在那个浏览器里登录 DeepSeek**

- 打开 <https://chat.deepseek.com/> 并登录，保持登录状态（有验证码，必须人类操作）。
- 扩展会自己开一个**专用会话标签页**；**不要**在那个专用会话里手动输入或删消息。

## 5. 验证（AI 执行）

```powershell
# 1) 客户端自检：Node 版本 / 上游哈希 / 密钥 / 扩展目录 / 桥接是否在跑 / 是否已配对
& "<Root>\node\node.exe" "<Root>\setup.mjs" --doctor

# 2) 本机桥接是否活着、扩展是否连上
irm http://127.0.0.1:3081/status

# 3) 端到端：让人类在中转站控制台点对应接入的「测连通性」
```

判定标准：

- `--doctor` 全绿；
- `/status` 返回 `connected: true`；
- 控制台「测连通性」返回设备在线。

## 6. 故障处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `[FAIL] 端口 3081 被占用` | 本机已有另一套桥接（例如装了 DSH 的网页桥接插件） | 两者只能留一个；或用 `-Port` 测试 |
| 扩展卡片显示但一直「等待扩展连接」 | 加载的是 `vendor\...\extension`（缺配对文件） | 重新加载 `<Root>\chrome` |
| 调用很久不返回然后超时 | 专用标签页被浏览器「睡眠/资源节省」挂起成白屏 | 关闭睡眠标签页；把 `chat.deepseek.com` 加白名单；刷新那个标签页 |
| 提示设备不在线 | 这台电脑的连接器没在跑 / 浏览器关了 | 双击 `<Root>\start.cmd`，或让它开机自启 |
| 模型报 503「还没有网页桥接设备」 | 该账号还没配对设备 | 人类到控制台「＋ 添加我的电脑」拿码，再跑 `-Pair <code>` |

## 7. 边界与代价（要如实告诉使用者）

- 用的是**这台电脑自己的** DeepSeek 网页额度；中转站记 0 token / 0 花费；
- 每次回答固定 **9~10 秒起**（上游要求答案 5 秒不变才算生成结束）；
- 同一时刻只跑一个任务，排队超过 3 个会被拒绝（429）；
- 发送的内容会出现在**这台电脑自己的** DeepSeek 网页会话历史里，并发往 DeepSeek 服务器；
- 运行期间需要：这台电脑开机、浏览器开着、DeepSeek 保持登录。

## 8. 卸载

```powershell
# 停掉进程
Get-NetTCPConnection -LocalPort 3081 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
# 删自启快捷方式
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) 'dsh-webtokens-lite.lnk') -ErrorAction SilentlyContinue
# 删安装目录
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\dsh-webtokens-lite"
```

再让人类到 `edge://extensions` 里把那个扩展移除，并在控制台把该设备删掉。
