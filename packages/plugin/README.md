# @opencode-pet/plugin

OpenCode Pet 的本地桥接插件。server 入口把 OpenCode 会话状态投影到仅监听
`127.0.0.1` 的带令牌 WebSocket；可选 TUI 入口提供 `/pet` 命令。

## 安装

本包尚未发布到 npm。当前项目请在根目录运行 `bun run install:plugin`，它会安装
server 文件并放置独立 TUI 文件；实际本地接入路径见根目录 README。下面为未来发布后
使用包名的配置方式，现阶段不要直接向 npm registry 安装此包名。

server 插件加入 `opencode.json`：

```json
{
  "plugin": ["@opencode-pet/plugin"]
}
```

TUI 命令需要另外加入 `~/.config/opencode/tui.json`：

```json
{
  "plugin": ["@opencode-pet/plugin"]
}
```

包分别暴露 `./server` 与 `./tui`，OpenCode 会为相应运行时选择目标入口；根入口保留
给旧版 server 插件加载器。

## `/pet` 与桌面程序

默认情况下插件绝不启动任意程序。若需要 server 插件自动启动桌宠，必须把
`OPENCODE_PET_APP` 设置为已经安装的桌宠**可执行文件绝对路径**：

```powershell
$env:OPENCODE_PET_APP = "C:\Program Files\OpenCode Pet\OpenCode Pet.exe"
```

启动不经过 shell，并且同一个 OpenCode 进程只会自动启动一次。Electron 桌宠本身持有
系统级单实例锁；再次执行 `/pet` 会启动一次短暂的第二实例请求，让已经运行的桌宠显示到
前台。未设置该环境变量时，`/pet` 只显示发现到的本地桥接实例状态。

## 安全边界

- WebSocket 只监听 loopback，并要求连接后 3 秒内发送随机令牌。
- 发现记录位于 `~/.opencode-pet/instances/`，包含本机临时令牌，不应同步或提交。
- `OPENCODE_PET_APP` 不接受命令行或相对路径，只接受现存的可执行文件。
- 插件不传输对话正文或完整工具参数。

本包当前以 OpenCode 1.18.35 验证。TUI 优先使用当前 `keymap.registerLayer` API，并为仍
提供 `command.register` 的旧版运行时保留防御式回退。
