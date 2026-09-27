# StudyPet 🐰

给大学生的桌面宠物：连上 Canvas、Gradescope 和 Ed，在对的时间提醒你交作业、去上课，也陪你专注和休息。哪个学校都能用。

A desktop study pet for college students (macOS).

## 下载

到 **[Releases](https://github.com/aenorhabditis6/studypet-releases/releases/latest)** 下载最新的 `StudyPet-x.y.z-macos.zip`，解压后把 StudyPet 拖进「应用程序」文件夹。

需要 macOS 13 或更新，Apple 芯片和 Intel 芯片的 Mac 都能用。

### 第一次打开

StudyPet 还没有苹果的开发者签名，第一次打开会被系统拦下：

1. 双击 StudyPet，弹出「无法打开」时点「完成」
2. 打开「系统设置 → 隐私与安全性」，拉到下面，点 StudyPet 旁边的「仍要打开」
3. 再确认一次，以后就能正常打开了

## 它能做什么

- 自带两只宠物：小兔子 Cloudbun 和奶蛋 🥚。也可以换成你自己的：
  - 上传一张图片：自动去掉背景、找到眼睛，眼睛会跟着鼠标转，还会转头看你
  - 或者用 Codex 做一整套表情和动作。做法和提示词见 **[做一只自己的宠物](MAKE-A-PET.md)**
- 连上 Canvas 的日历订阅链接（Google 日历、Outlook 这类 .ics 链接也行）：作业截止前 3 天、1 天、3 小时提醒，上课前提醒你出发
- Gradescope：在 App 里登录一次，就能看到作业和交没交，一键去提交（gradescope.com、.ca、.eu、.com.au 都支持）
- Ed：课程有新公告会告诉你（美洲、欧洲、澳洲的 Ed 都支持）
- 番茄钟、专注模式（专注时微信会被藏起来）、喝水走动提醒
- 把宠物甩到屏幕边上就进入「组会模式」，完全静音

## 隐私

- 所有数据只保存在你自己的电脑上，不会上传
- 日历链接、Ed token 和 Gradescope 的登录都存在系统钥匙串里
- StudyPet 不收集任何使用数据

## 更新

新版本会发布在 [Releases](https://github.com/aenorhabditis6/studypet-releases/releases)。下载新的 zip，替换掉「应用程序」里的旧版就行，设置和数据都会保留。

每次更新后，系统会问一次 StudyPet 能不能使用钥匙串（要输入电脑的登录密码），点 **「始终允许」**，在下次更新前就不会再问了。点「允许」的话下次还会问。从 0.2.0 升级时会多问几次（旧版把每个链接分开存），只有这一回。
