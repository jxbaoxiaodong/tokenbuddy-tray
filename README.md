# TokenBuddy Tray

一个**跨平台(Windows / Linux)的 AI 中转站余额托盘小工具**。托盘图标同时显示**站点名**和**余额金额**,点开可看今日消费、已用额度与站点详情。

- **开源免费(MIT)**、单文件即可运行、双击就用。
- **只填站点地址**就能自动识别架构;Sub2API 填 API Key 即可读余额,New API 需再填账号密码(原因见下文)。
- 适合任何 **Sub2API / New API(One API)** 系中转站,不局限于某一个站点。

> 这是 TokenBuddy(https://tokenbuddy.cc)提供的小工具,用来让用户随时看到自己的余额还剩多少。

---

## 它解决什么问题

中转站的余额通常只能登录网页才能看到。这个小工具常驻系统托盘,**一眼就能看到余额**,余额偏低时图标变色提醒,免去反复登录。

## 特性

- 托盘图标**同时显示站点名与金额**:上行站点名(放不下自动缩写成 `TB` / `XCO`),下行金额(自动缩写为 `15.30` / `1.2K` / `1.2M`)。只显示金额看不出是哪个站点,所以站名和金额一起显示。
- 余额偏低自动变色:绿(充裕)→ 琥珀(偏低)→ 红(接近 0)。
- 悬停显示 `站点 · 余额`;左键点开面板看今日/累计消费。
- 币种按站点自己的口径显示(`$` / `¥`),不一律印美元符号。
- 多站点:可同时配置多个中转站,随时切换。
- 定时自动刷新(默认 120 秒,可调)。
- 凭据只存本机;可用时用系统安全存储(Electron `safeStorage`)加密。
- **桌面宠物**:可换成任意图片(包括宝宝照片)、GIF 动图或 WebM 视频;自动待机动画;透明处鼠标穿透;头顶气泡同时显示站点名与余额。

## 桌面宠物

一个透明、无边框、始终置顶的小家伙待在桌面上,头顶悬浮实时余额。

- **形象完全自定义**:设置里「选择图片」,支持 `PNG / JPG / GIF / WebP / APNG / SVG / WebM / MP4`。
  - 静态图(如宝宝照片)自动加待机动画(轻微起伏/呼吸),点一下会蹦跳;
  - GIF / WebM 直接播放原生动画。
  - 不选时使用内置吉祥物。
- **操作**:拖动移动;左键点一下蹦一下并弹出余额面板;右键出菜单。
- **透明穿透**:形象透明区域鼠标事件穿透到桌面,只有形象本体和气泡可点(逐像素命中检测)。
- **右键菜单**:更换形象、大小(100–420px)、显示余额气泡、始终置顶、左右翻转、开机自启、打开余额面板、隐藏、退出。
- **余额气泡**:实时显示当前站点余额;余额偏低(≤$1)变红提醒。
- **开机自启**:Windows/macOS 用系统登录项,Linux 写 `~/.config/autostart/`。

## 快速开始

1. 到 [Releases](https://github.com/jxbaoxiaodong/tokenbuddy-tray/releases) 下载对应系统的文件:
   - **Windows**:`TokenBuddy-x.y.z-win-x64.exe`(免安装,双击运行)。
   - **Linux**:`TokenBuddy-x.y.z.AppImage`(下载后 `chmod +x` 再双击)。
2. 运行后系统托盘出现图标。
3. 右键图标 → **设置…** → 填**站点地址**和**API Key**(在你的中转站后台「令牌 / API Keys」里复制)。
4. 保存,余额立刻显示在托盘图标上(上行站名、下行金额)。

> 界面会按站点地址自动识别架构:**Sub2API** 填 API Key 即可;**New API** 还需要填**用户名 + 密码**才能读到真实余额(原因见「为什么 New API 必须填账号密码」)。
> Sub2API 若关闭了 `/v1/usage`,可在「高级」里改用**邮箱 + 密码**登录读取。

## 自动适配原理

绝大多数中转站是两套架构。**程序只凭站点地址做未鉴权探测**来判断是哪一套,不消耗你的任何凭据:

| 探测请求 | New API | Sub2API |
|---|---|---|
| `GET /api/status` | `200`,返回站点配置 | `404` |
| `GET /v1/usage`(不带 Key) | `404` | `401` + `API_KEY_REQUIRED` |
| `POST /api/v1/auth/login`(空参数) | `404` | `400`(参数校验错,说明路由存在) |

识别之后按各自口径取值:

| 框架 | 接口 | 取到的字段 |
|---|---|---|
| **Sub2API** | `GET /v1/usage`(Bearer API Key) | `balance` / `remaining`——**账户钱包真实剩余** |
| **New API**(Key) | `GET /v1/dashboard/billing/subscription` | `hard_limit_usd`——**总额度,不是余额**(见下) |
| New API(Key,已用) | `GET /v1/dashboard/billing/usage` | `total_usage`(单位:分) |
| **New API**(登录) | `POST /api/user/login` → 响应里的 `data.user` | `quota`(剩余)、`used_quota`(已用) |

## 为什么 New API 必须填账号密码

这是本工具唯一需要你多填两项的地方,原因来自 New API 自己的计费口径,不是本工具的限制。

**用 API Key 查不到账户余额,只能查到"这把 Key 自己的额度"。** New API 的计费接口(`controller/billing.go`)是这样算的:

- `hard_limit_usd = (剩余额度 + 已用额度) / QuotaPerUnit`,也就是**总额度**,不是剩余余额;
- 真正的余额要自己用总额度减去已用额度才算得出来;
- **如果这把 Key 是无限额度(`UnlimitedQuota`),New API 会把返回的 `hard_limit_usd` 固定写成 `100000000`**,这个数字和你的真实余额毫无关系,而且永远不会变。

换句话说:一把无限额度的 API Key,在 New API 里**根本查不到账户还剩多少钱**。而账户真实余额只存在登录用户的 `quota` 字段里,这个字段只有登录后才能读到——所以 New API 站点必须填账号密码。

**Sub2API 则不需要登录**:`GET /v1/usage` 直接返回账户钱包的真实剩余余额,一把 API Key 就够。

登录走的是**纯 HTTP 请求**(`POST /api/user/login` 拿 JWT,新版 New API 直接在登录响应里返回 `data.user` 和 `data.quota`),**不会启动浏览器**,一次请求几百毫秒,资源占用可以忽略。旧版本 New API 只给 session Cookie,程序会自动改用 Cookie + `New-Api-User` 头的方式兜底。

## 多站点

可在设置里添加多个站点,托盘菜单/下拉框切换当前站点,图标与面板跟随切换。

## 安全与隐私

- 配置文件在系统 `userData` 目录(`config.json`,权限 `0600`):Windows `%APPDATA%\TokenBuddy\`、Linux `~/.config/TokenBuddy/`。
- API Key / 密码优先用 Electron `safeStorage` 加密存储;不可用时明文保存,界面会提示。
- 本工具**只读取余额与用量**,不代理、不转发任何模型请求,不上传任何数据到第三方。

## 常见问题

- **显示"读取失败 / 无法识别站点架构"**:地址填错,或该站点既不是 Sub2API 也不是 New API。程序会在「高级 → 框架」里显示探测结果。
- **New API 站点图标金额显示 `--`**:说明这把 API Key 是无限额度,读不到真实余额。按上面的说明填账号密码即可。
- **币种显示 `¥` 而不是 `$`**:New API 的 `quota_display_type` 是 `CNY` 时余额就是人民币,程序按站点自己的口径显示,不做换算。
- **Linux 桌面不显示托盘图标**:GNOME 需安装 AppIndicator 扩展(如 `gnome-shell-extension-appindicator`);或使用 KDE / XFCE 等原生支持托盘的桌面。
- **Linux 启动即退出并提示 `GPU process isn't usable`**:用 `--disable-gpu` 启动(受限环境或 Wayland 下常见)。
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
npm run dist:mac     # dmg + zip(必须在 macOS 上执行)
```

推 tag 会触发 GitHub Actions 自动为 **Windows / Linux / macOS** 出包并生成 Release 附件。

## 目录结构

```
src/
  main.js            主进程:托盘、余额面板、桌面宠物窗口、轮询、配置
  preload.js         安全桥(contextBridge)
  lib/adapters.js    架构探测(仅凭地址)+ Sub2API / New API 余额适配
  lib/icon.js        纯 stdlib 的 PNG 编码 + 5x7 点阵字体(把站名与金额画进托盘图标)
  renderer/          余额面板与设置界面(原生 HTML/CSS/JS)
  pet/               桌面宠物窗口(透明/穿透/拖动/右键/余额气泡)
scripts/gen_icons.js 生成应用图标
```

## License

MIT
