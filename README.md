# OpenCode Pet

OpenCode Pet 是一款 Windows 桌面宠物，用来查看 OpenCode 正在做什么。它由 OpenCode 插件和 Electron 桌面程序组成：插件把会话状态送到本机桌宠，桌宠显示任务、Todo 进度、当前工具和待处理的授权请求。授权可以在桌宠中回复，实际任务仍由 OpenCode 执行。

## 它能做什么

假设你同时在两个项目中使用 OpenCode。桌宠会显示当前有几个任务在运行；点击宠物后，可以看到每个任务属于哪个项目、正在调用什么工具、Todo 完成了多少。某个任务需要授权时，宠物上会出现数字角标，任务卡片中会显示请求内容和回复按钮。任务结束或报错时，也可以按你的设置发出提醒。

桌宠支持多个 OpenCode 实例，任务列表可按项目和状态筛选。你也可以把常看的任务置顶，或收起已经空闲的任务。它只连接本机服务，不负责运行模型。

## 安装与启动

需要 Windows x64、Bun 1.3+、Node.js 22+ 和已安装的 OpenCode。项目在 OpenCode 1.18.35、Bun 1.3.14、Node.js 22.22.3 上验证过。

在此项目目录打开 PowerShell，依次运行：

```powershell
bun install
bun run build
bun run install:plugin
bun run start
```

`install:plugin` 会将插件安装到当前用户的 `~/.config/opencode/plugins/opencode-pet.js`。安装后需要**完全退出并重新打开 OpenCode**；已经运行的 OpenCode 不会自动加载新插件。桌宠与 OpenCode 都启动后，宠物下方会显示连接状态；如果仍显示“等待 OpenCode 连接”，先检查插件是否安装并重启了 OpenCode。

`bun run start` 启动源码版桌宠。若要制作 Windows 安装包，运行 `bun run dist`，输出在 `packages/app/release/`。安装包只包含桌宠程序，换一台电脑使用时仍需从源码运行 `bun run install:plugin` 安装 OpenCode 插件。安装包未签名，Windows 可能提示未知发布者。

## 先试一遍

想先看界面和授权流程，可以使用项目自带的本地模拟任务，不需要调用模型：

1. 保持桌宠运行，在另一个 PowerShell 窗口运行 `bun run demo alpha`。
2. 点击桌宠，任务页会出现“alpha · 联调任务”。卡片显示 Todo 进度，并停在“待授权”状态。
3. 阅读卡片中的模拟请求，点击“仅一次”。收到确认后，模拟任务会完成，Todo 变为 3/3。
4. 回到模拟任务的终端，按 Ctrl+C 停止它。

真实使用时，在 OpenCode 中启动任务即可；无需运行 `demo`。

## 界面怎么用

### 看任务与进度

点击宠物打开面板，顶部的“任务 N”标签显示当前任务数。每张卡片显示会话标题、项目、状态、当前工具和 Todo 进度；没有 Todo 数据时显示“进度未知”。

- 同时打开多个项目：在“项目”下拉框选目标项目；选“全部项目”恢复完整列表。
- 只看某类任务：在“状态”下拉框选“运行中”“待授权”或“有错误”；选“全部状态”恢复完整列表。
- 找不到刚结束的任务：点击“空闲与已完成 · N”展开折叠的卡片。
- 想一直看到某个任务：点击卡片右上角的 ☆，变成 ★ 后会置顶；再点一次取消。
- 任务很多时：点击列表底部的“再显示 50 个任务”继续查看。

### 处理授权

宠物出现数字角标时，打开任务面板，并将“状态”选为“待授权”。先阅读卡片中的请求，再选择“仅一次”“总是允许”或“拒绝”。桌宠发送回复后会等待 OpenCode 确认；如果出现发送失败提示，请回到原 OpenCode 终端处理。

### 调整提醒

点击右上角的 ⚙，或打开面板中的“设置”。在“通知”区域，可分别设置“任务完成”“任务错误”“待授权”“需要回答”的声音和弹窗。想暂时安静，点击“免打扰 30 分钟”；提前结束时点击“立即恢复通知”。免打扰期间任务仍会更新，待授权的数字角标也仍会显示。

### 移动、隐藏和找回桌宠

按住宠物、气泡或连接状态拖动即可移动。右键宠物可选择“锁定位置”“甩动惯性”“低功耗”等；锁定位置后仍可点击宠物查看任务。点击右上角 × 会把桌宠隐藏到系统托盘，托盘菜单中的“显示桌宠”可找回，选“退出”才会关闭程序。

默认按 `Ctrl+Alt+P` 显示或隐藏桌宠，按 `Ctrl+Alt+T` 打开任务面板。要修改快捷键，在“设置”中的“全局快捷键”输入组合后点击“保存快捷键”；留空并保存可禁用对应快捷键。

## 工作方式与隐私

```text
OpenCode 会话事件 → OpenCode Pet 插件 → 本机 WebSocket → Electron 桌宠
OpenCode 授权确认 ← OpenCode Pet 插件 ← 桌宠中的回复
```

插件将 OpenCode 的会话事件整理为任务状态，桌宠负责显示和交互。连接只监听 `127.0.0.1`，使用随机令牌认证；发现记录保存在 `~/.opencode-pet/instances/`，其中有临时令牌，不应同步或提交。桌宠会读取会话标题、Todo 摘要、工具名和授权范围，不传送对话正文或完整工具输入。

普通状态更新会合并后刷新；授权和错误会及时显示。隐藏窗口时动画与命中检测暂停，过期的本地历史缓存会被清理，但不会删除 OpenCode 中的会话。

## 皮肤

不选择皮肤时，桌宠使用自带的简洁形象。仓库另有可直接使用的示例皮肤 `packages/app/resources/skins/sample/pet.json`；在“设置”底部点击“选择自定义皮肤…”并选择这个文件即可。

自制皮肤由一个 `pet.json` 和同目录的 PNG、WebP、JPEG、GIF 或 SVG 图集组成。图集每行对应一种状态，从左到右排列帧。最小示例：

```json
{
  "name": "我的桌宠",
  "spritesheet": "spritesheet.png",
  "frameWidth": 160,
  "frameHeight": 160,
  "animations": {
    "idle": { "row": 0, "frames": 2, "fps": 2 },
    "thinking": { "row": 1, "frames": 2, "fps": 3 },
    "working": { "row": 2, "frames": 2, "fps": 6 },
    "permission": { "row": 3, "frames": 2, "fps": 3 },
    "celebrate": { "row": 4, "frames": 2, "fps": 5 },
    "error": { "row": 5, "frames": 2, "fps": 2 },
    "retry": { "row": 6, "frames": 2, "fps": 3 }
  }
}
```

`row` 从 0 开始，缺少某种状态时会回退到 `idle`。图片必须和 `pet.json` 放在同一个皮肤目录，不加载远程素材。仓库保留了 `packages/app/resources/skins/boba/pet.json` 适配配置，但不分发 [PetDex Boba](https://petdex.dev/pets/boba) 图集；如果你自行取得并有权使用该图集，可把 `spritesheet.webp` 放到同目录后选择其 `pet.json`。

## 开发与验证

项目分为三个工作区：

| 目录 | 用途 |
| --- | --- |
| `packages/protocol` | 插件与桌面程序共用的消息协议和校验 |
| `packages/plugin` | OpenCode 事件整理、本机连接与授权回传 |
| `packages/app` | Electron 主进程、预加载层和桌宠界面 |

```powershell
bun run check   # 类型检查与测试
bun run build   # 生产构建
bun run dev     # 开发模式
bun run dist    # 生成 Windows 安装包
```

0.3.0 版本通过了 87 项自动检查，并在隔离的 Electron 环境中以约每秒 100 次模拟事件运行 10 分钟。该验证使用模拟负载，不代表长期实际使用情况。公开仓库不包含构建产物、本机验证记录和第三方 Boba 图集；缺少图集时，Boba 适配测试仍会检查配置文件。

## 可选的 OpenCode 启动方式

默认情况下，插件不会自动启动桌宠。若希望启动 OpenCode 时也启动桌宠，可先把 `OPENCODE_PET_APP` 设置为桌宠 exe 的真实绝对路径，再从同一终端启动 OpenCode：

```powershell
$env:OPENCODE_PET_APP = "C:\<安装目录>\OpenCode Pet.exe"
opencode
```

安装插件时还会放置独立的 TUI 插件，但不会改动 `tui.json`。如需在 OpenCode 中使用 `/pet`，把 TUI 插件地址加入当前用户 `~/.config/opencode/tui.json` 的 `plugin` 数组，并将下例的 `<用户名>` 换成 Windows 用户名：

```json
{
  "plugin": [
    "file:///C:/Users/<用户名>/.config/opencode/opencode-pet/opencode-pet-tui.js"
  ]
}
```

重启 OpenCode 后，`/pet` 可请求显示桌宠；若桌宠未启动且未设置 `OPENCODE_PET_APP`，命令只会显示桥接状态。

## 常见问题

- **显示“等待 OpenCode 连接”**：确认已运行 `bun run install:plugin`，完全退出并重新打开 OpenCode；没有会话时任务列表可以为空。
- **授权回复失败**：回到发起请求的 OpenCode 终端处理，桌宠不会把失败显示为成功。
- **找不到桌宠窗口**：按 `Ctrl+Alt+P`，或在系统托盘菜单中选“显示桌宠”。
- **通知没有声音或弹窗**：检查桌宠“设置 → 通知”、免打扰状态，以及 Windows 的通知与音量设置。
- **Electron 下载失败**：网络环境无法访问官方下载源时，可临时设置 `ELECTRON_MIRROR`，再重新运行安装或启动命令。

## 许可

项目尚未选择代码许可证。公开查看源码不等于获得复制、修改或再分发的授权；第三方宠物素材的许可也需要单独确认。
