# TokenBuddy Tray

一个跨平台(Windows / Linux)的 **AI API 中转站余额托盘小工具**。托盘图标直接显示余额数字,点开可看今日消费与站点详情。

开源(MIT)、无运行时依赖、纯 Electron,同时支持两大主流框架:

- **Sub2API**(如本站 `tokenbuddy.cc`)
- **New API**(如 `newapi.one`、`xcode.best` 等)

> 余额数字会按大小自动缩写(`12.3` / `1.2K` / `1.2M`),并按余额高低变色:绿(充裕)/ 琥珀(偏低)/ 红(接近 0)。

---

## 功能

- 托盘图标实时显示当前站点余额;鼠标悬停显示 `站点 · $余额`。
- 左键点开面板:余额、今日/累计消费、最后刷新时间,一键刷新。
- 多站点管理:可同时配置多个 Sub2API / New API 站点,随时切换。
- 定时自动刷新(默认 120 秒,可改)。
- 凭据只保存在本机;可用时用系统安全存储(Electron `safeStorage`)加密。

## 使用

1. 启动程序,托盘出现图标(默认显示 `…`)。
2. 右键托盘 → **设置…**,添加站点:
   - **Sub2API**:填站点地址 + 邮箱 + 密码。
   - **New API**:填站点地址 + 用户名 + 密码;或直接填**访问令牌**(控制台「个人设置 → 生成访问令牌」)+ 用户 ID。
3. 保存后自动刷新,托盘图标即显示余额。

## 支持的接口

| 框架 | 余额接口 | 说明 |
|---|---|---|
| Sub2API | `GET /api/v1/auth/me`(Bearer JWT) → `data.balance` | 先用邮箱密码 `POST /api/v1/auth/login` 取 token;另取 `/api/v1/usage/dashboard/stats` 的今日/累计消费 |
| New API | `GET /api/user/self` → `data.quota` | 需请求头 `New-Api-User: <uid>`,并带登录 `session` Cookie 或 `Authorization: Bearer <访问令牌>`;余额 = `quota ÷ 500000` |

## 开发

```bash
npm install
npm start
```

> Linux 沙箱受限环境(如容器/无 setuid `chrome-sandbox`)可用:
> ```bash
> npm start -- --no-sandbox
> ```

## 打包

```bash
npm run dist:linux   # AppImage + deb
npm run dist:win     # NSIS 安装包 + 免安装 portable(在 Windows 或 CI 上执行)
```

Windows 产物建议在 Windows 或 GitHub Actions 上构建(本仓库自带 `.github/workflows/build.yml`)。

## 配置与隐私

- 配置文件位于系统 `userData` 目录(`config.json`,权限 `0600`):Windows `%APPDATA%\TokenBuddy\`、Linux `~/.config/TokenBuddy/`。
- 密码 / 访问令牌优先用 Electron `safeStorage` 加密后存储;不可用时以明文保存并已在界面提示。
- 本工具只读取余额与用量信息,不代理、不转发任何模型请求。

## 目录结构

```
src/
  main.js            主进程:托盘、窗口、轮询、配置
  preload.js         安全桥(contextBridge)
  lib/adapters.js    Sub2API / New API 余额适配器
  lib/icon.js        纯 stdlib 的 PNG 编码 + 位图字体(把余额画进托盘图标)
  renderer/          弹窗与设置界面(原生 HTML/CSS/JS)
scripts/gen_icons.js 生成应用图标
```

## License

MIT
