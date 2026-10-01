# TokenBuddy Tray

一个**跨平台(Windows / Linux)的 AI 中转站余额托盘小工具**。托盘图标直接显示余额数字,点开可看今日消费、已用额度与站点详情。

- **开源免费(MIT)**、单文件即可运行、双击就用。
- **只填站点地址 + API Key** 就能读余额;**自动识别**两大主流中转架构。
- 适合任何 **Sub2API / New API(One API)** 系中转站,不局限于某一个站点。

> 这是 TokenBuddy(https://tokenbuddy.cc)提供的小工具,用来让用户随时看到自己的余额还剩多少。

---

## 它解决什么问题

中转站的余额通常只能登录网页才能看到。这个小工具常驻系统托盘,**一眼就能看到余额**,余额偏低时图标变色提醒,免去反复登录。

## 特性

- 托盘图标直接显示余额数字(自动缩写为 `12.3` / `1.2K` / `1.2M`)。
- 余额偏低自动变色:绿(充裕)→ 琥珀(偏低)→ 红(接近 0)。
- 悬停显示 `站点 · $余额`;左键点开面板看今日/累计消费。
- 多站点:可同时配置多个中转站,随时切换。
- 定时自动刷新(默认 120 秒,可调)。
- 凭据只存本机;可用时用系统安全存储(Electron `safeStorage`)加密。

## 快速开始

1. 到 [Releases](https://github.com/jxbaoxiaodong/tokenbuddy-tray/releases) 下载对应系统的文件:
   - **Windows**:`TokenBuddy-x.y.z-win-x64.exe`(免安装,双击运行)。
   - **Linux**:`TokenBuddy-x.y.z.AppImage`(下载后 `chmod +x` 再双击)。
2. 运行后系统托盘出现图标。
3. 右键图标 → **设置…** → 填**站点地址**和**API Key**(在你的中转站后台「令牌 / API Keys」里复制)。
4. 保存,余额立刻显示在托盘图标上。

> 没有 API Key?在「高级」里改用**邮箱 + 密码**(或 New API 的**用户名 + 密码**)登录读取。

## 自动适配原理

绝大多数中转站是两套架构,程序会按顺序自动尝试,命中即用:

| 框架 | 接口 | 取到的字段 |
|---|---|---|
| **Sub2API** | `GET /v1/usage`(Bearer API Key) | `balance` / `remaining`,`usage.today/total.actual_cost` |
| **New API / One API** | `GET /v1/dashboard/billing/subscription` | `hard_limit_usd`(剩余额度) |
| New API(已用) | `GET /v1/dashboard/billing/usage` | `total_usage`(单位:分) |

只要站点开放了以上任一的 **Key 查询**接口,填地址 + Key 即可;若站点未开放,则退回账号密码登录:

| 框架 | 登录 | 余额 |
|---|---|---|
| Sub2API | `POST /api/v1/auth/login` | `GET /api/v1/auth/me` → `data.balance` |
| New API | `POST /api/user/login`(取 session) | `GET /api/user/self` + 头 `New-Api-User` / Cookie → `data.quota`(÷500000 = USD) |

## 多站点

可在设置里添加多个站点,托盘菜单/下拉框切换当前站点,图标与面板跟随切换。

## 安全与隐私

- 配置文件在系统 `userData` 目录(`config.json`,权限 `0600`):Windows `%APPDATA%\TokenBuddy\`、Linux `~/.config/TokenBuddy/`。
- API Key / 密码优先用 Electron `safeStorage` 加密存储;不可用时明文保存,界面会提示。
- 本工具**只读取余额与用量**,不代理、不转发任何模型请求,不上传任何数据到第三方。

## 常见问题

- **显示"读取失败 / 未能识别余额接口"**:该站点未开放 Key 查余额,请在「高级」里改用账号密码登录。
- **New API 余额看起来很大/不准**:New API 的额度口径各站不同,本工具直接展示其返回的剩余额度(USD)。
- **Linux 桌面不显示托盘图标**:GNOME 需安装 AppIndicator 扩展(如 `gnome-shell-extension-appindicator`);或使用 KDE / XFCE 等原生支持托盘的桌面。
- **Linux 提示沙箱错误**:用 `--no-sandbox` 启动(部分受限环境需要)。

## 开发

```bash
npm install
npm start            # 本地运行
npm start -- --no-sandbox   # 受限环境
```

## 打包

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS 安装包 + 免安装 exe(在 Windows 或 CI 上执行)
```

推 tag 会触发 GitHub Actions 自动为 Windows / Linux 出包并上传为 Release 附件。

## 目录结构

```
src/
  main.js            主进程:托盘、窗口、轮询、配置
  preload.js         安全桥(contextBridge)
  lib/adapters.js    Sub2API / New API 余额适配(Key 优先,自动识别)
  lib/icon.js        纯 stdlib 的 PNG 编码 + 位图字体(把余额画进托盘图标)
  renderer/          弹窗与设置界面(原生 HTML/CSS/JS)
scripts/gen_icons.js 生成应用图标
```

## License

MIT
