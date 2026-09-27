# StudyPet

给大学生的桌宠：住在桌面角落，知道你的课表和 Canvas deadline，用表情和气泡在对的时间提醒你。macOS 应用，Tauri 2 + TypeScript。

## 现在能做什么

- **宠物**：内置 Cloudbun（Codex 精灵图）和奶蛋（一张照片）；也可以上传自己的，三种方式：
  - **图片 · 自动抠图**：去掉纯色 / 渐变背景并裁剪（`cutout.ts`），再自动做脸（`face.ts`）：找到两只眼睛，瞳孔跟着鼠标在"眼白"里移动（碰到眼眶边缘会藏到后面），脸部整体朝鼠标方向轻轻转，眼睛太小会自动放大一点；偶尔眨眼、四处看看，庆祝时眯眼笑。
  - **图片 · 原图**：不抠图不做脸，只做整体动作。
  - **Codex 宠物**（`pet.json` + 精灵图，v1 / v2）：用 Codex 的 hatch-pet 生成，做法和提示词见 [docs/make-a-pet.md](docs/make-a-pet.md)（公开仓库里是 MAKE-A-PET.md）；会自动发现 `~/.codex/pets/` 里的宠物。
- **桌宠本体**：透明置顶，拖到屏幕任何位置（贴近顶部时宠物在窗口里上移，气泡自动换到下面）；透明区域点得穿；眼睛跟着屏幕上任何位置的鼠标，鼠标停下几秒后看回你。
- **单击**：第 1 次说下一个作业，第 2 次说再下一个，之后从「宠物台词」里随机说（设置里可改，一行一句）。**双击**打开面板，**右键**菜单。
- **组会模式**：把宠物甩到屏幕左 / 右边缘就缩进去，只露一条边和一个小圆点（这周还剩几个作业，颜色表示紧急程度）。完全静音，想说的话攒着，拉出来时再说；点小圆点直接看今天的 todo。
- **紧急程度写在脸上**：48 小时内没 due → 悠闲；24 小时内 → 坐立不安 + 角标；3 小时内 → 着急；错过了 → 温柔地问能不能补交。
- **Canvas**：日历订阅链接（.ics，不用 token）。支持重复课程、时区、单节改期、全天作业、跨来源去重；7 天以外的作业折叠在「之后还有 N 个」。
- **Gradescope**：内置窗口里用学校账号登录一次，之后自动读取作业、截止时间、迟交截止和**交没交**；交了的不再提醒，刚交完宠物会庆祝；作业旁边「去提交」一键打开提交页。支持 Gradescope 的四个地区站点（.com / .ca / .eu / .com.au），在哪个站点登录就读哪个。
- **Ed**：用个人 API token 读取各门课的公告和未读数；有新公告宠物会说，点一下打开对应帖子。支持 us / eu / au 三个地区（token 会在所有地区里试一遍）。
- **任何学校**：Canvas 用日历订阅链接，别的系统能导出 .ics 的也行；课程代号会自动缩短（`F26-MS&E-245A-01` → `MS&E 245A`，`CS 61A`、`COMP1234`、`15-213` 这类也认）。
- **提醒**：作业截止前 3 天 / 1 天 / 3 小时；上课前 1 小时（可调）；深夜还醒着且第二天早上有课提醒一次。Office hours 只列在日程里，不会叫你。合盖睡眠错过的提醒醒来补一次。
- **健康提醒**：每 45 分钟（可调）提醒喝水 / 走动 / 护眼；只算在电脑前的时间，离开 5 分钟以上重新计时。
- **番茄钟**（右键开始，25 / 50 分钟）：宠物换成专注表情，下面有倒计时；期间不闲聊、不做健康提醒，结束后提醒休息。
- **专注模式**：锁住微信（和你选的其他 App）——它一跳到前台就被藏起来，宠物告诉你「先锁着」，右键可以「解锁 5 分钟」。配合两个快捷指令还能同时打开系统勿扰，屏蔽所有通知。

## 运行

需要 Node 20+ 和 Rust（`rustup`）。

```bash
npm install
npm run tauri dev
```

打包成 `.app`（在 `src-tauri/target/release/bundle/macos/`）：

```bash
npx tauri build --bundles app
```

发布新版本（打包 Apple 芯片 + Intel 通用版、压 zip、发到公开的下载仓库 `studypet-releases`；源码仓库保持私有）：

```bash
scripts/release.sh 0.2.0 "这一版改了什么"
```

看有多少人下载（每个版本 zip 的下载次数、最近 14 天下载页的访问和来源，并和上次查看比较）：

```bash
scripts/stats.sh
```

只看界面（浏览器预览，用假数据）：`npm run dev`，然后打开 `http://localhost:1420/`（宠物，右边有调试按钮）、`/panel.html`（今日）、`/panel.html?fresh`（新手引导）。

## 测试

```bash
npm test                         # 类型检查 + 下面两项
node scripts/check-ics.ts        # 日历解析 + 紧急程度（Node 23+ 能直接跑 TS）
node --import ./scripts/ts-resolve.mjs scripts/check-services.ts   # Gradescope 页面解析 + Ed 公告
cd src-tauri && cargo test       # 宠物导入、链接校验、服务窗口、空闲时间
swift scripts/check-pet.swift ~/.codex/pets/<id>   # 检查 Codex 生成的宠物合不合规格
STUDYPET_SELFTEST_ICS=http://127.0.0.1:8765/canvas.ics npm run tauri dev
                                 # 端到端：钥匙串 → 抓取 → 解析 → 提醒（仅 debug 构建）
```

`src/dev/sample-ics.ts` 会生成一份时间相对“现在”的仿 Canvas 日历，浏览器预览和端到端自检都用它。

## 数据和隐私

- 日历链接、Ed token 和 Gradescope 的登录 cookie 相当于密码，一起存在**系统钥匙串**的一个条目里（service `com.studypet.app`，account `vault`，见 `vault.rs`），只有 Rust 那一侧能读到；页面上只保存名字、同步时间这类非敏感信息。放在一个条目里，是因为没有 Apple 开发者签名的 App 每次更新都算"新 App"，每个条目都要重新授权一次；读一次后留在内存里，运行期间不再弹窗。
- Gradescope 的登录在 App 内置窗口的 WebKit 里；WebKit 退出时会丢掉会话 cookie，所以读取成功后存一份到钥匙串，重启后放回去。cookie 不会交给页面代码。
- 作业、日程、完成状态存在 `~/Library/Application Support/com.studypet.app/studypet.json`，宠物在同目录的 `pet/` 里。
- 只连接你添加的日历链接、Gradescope 和 Ed；还没有接 AI。
- 日志在 `~/Library/Logs/com.studypet.app/studypet.log`（只记录数量、状态，不记录内容）。

## 代码结构

```
src-tauri/src/
  lib.rs        窗口、托盘、命令注册
  hittest.rs    透明区域点击穿透 + 把光标位置发给页面（宠物看你）
  pet.rs        导入宠物（Codex 文件夹 / pet.json / 单张图片 / 默认）
  sources.rs    日历链接：钥匙串存取、抓取 .ics
  services.rs   Gradescope / Ed 内置窗口、读取 Gradescope 页面、Ed API
  focus.rs      专注模式锁 App、空闲时间、运行快捷指令
src/
  pet/          宠物窗口：动画 sprite.ts、抠图 cutout.ts、自动做脸 face.ts、
                拖动和组会模式 motion.ts、番茄钟 / 专注 / 健康 sessions.ts、
                大脑 main.ts（同步、提醒、交互）
  panel/        面板：新手引导、今日、设置、选宠物 pet-picker.ts
  shared/       .ics 解析、Gradescope 解析、Ed、紧急程度、台词、存储、同步
  dev/          浏览器预览用的 mock 和样例日历
```

## 已知限制

- 每次重新编译或更新，macOS 都会在第一次读钥匙串时弹窗确认一次（ad-hoc 签名每次都不一样），选「始终允许」。想彻底不弹：在「钥匙串访问 → 证书助理 → 创建证书」建一个自签名的代码签名证书，用它签名每个版本（或者用 Apple 开发者 ID）。
- 宠物不会出现在全屏 App 的桌面空间里（全屏演示、看视频时保持安静）。
- 点击宠物时 App 会被激活，会把键盘焦点从你正在用的窗口抢过来；以后用 NSPanel 做成不抢焦点的窗口。
- Gradescope 没有给学生的官方接口，这里读的是网页；Gradescope 改版的话 `src/shared/gradescope.ts` 要跟着改。Ed 的 API 也还是 beta。
- 自动做脸需要图里有两只看得清的眼睛（深色瞳孔）；找不到就只做整体动作。侧脸、闭眼、戴墨镜的图片都找不到眼睛。
- 「锁住」App 是把它藏起来，不是真的锁；系统勿扰需要你自己建两个快捷指令。
- 菜单栏图标多的时候，小图标可能被 MacBook 的刘海挡住。
- 目前只在 macOS 上跑过；Windows 版的代码基本能共用，但还没测。

## 下一步

- App 内自动更新（读取公开仓库的最新 release）。
- 系统通知兜底、开机自启、全局快捷键呼出面板。
- 聊天陪伴：每个用户在设置里填自己的 Anthropic API key（存钥匙串，直接从本机调用，不需要服务器）。
- Windows 版构建（GitHub Actions）。
