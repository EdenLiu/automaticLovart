# Automatic Lovart Agent

这个项目用 Playwright 控制浏览器访问 Lovart，把多个 prompt 当成相互隔离的任务执行。每个任务使用独立 browser context，最多和 Lovart 交互 6 轮，并把检测到的图片保存到 `./picture_lovart/<task_id>/`。

## 准备

运行这个工具需要安装本机 Google Chrome。Lovart/登录校验可能会拒绝 Playwright 自带的 Chromium，所以不要只依赖 `npm run install:browsers` 下载的浏览器。

```bash
npm install
cp prompts.example.json prompts.json
```

编辑 `prompts.json`，每个任务必须有唯一 `id` 和 `prompt`。

## 保存 Lovart 登录态

使用真实 Google Chrome 保存登录态，避免 Google OAuth 或 Lovart 校验拦截 Chrome for Testing：

```bash
npm run auth:chrome
```

脚本会用你本机安装的 Google Chrome 打开 Lovart。你手动登录完成后，回到终端按 Enter，登录态会保存到 `.auth/lovart.storage.json`。脚本不会保存账号密码。

旧的 Playwright Chromium 登录方式保留在脚本里，但如果遇到校验失败，不建议用于分享部署：

```bash
npm run auth
```

## 运行任务

```bash
npm run run:headed
```

无头运行：

```bash
npm run run
```

输出结构：

```text
picture_lovart/
  task_001/
    task_001_001.png
    manifest.json
  task_002/
    task_002_001.jpg
    manifest.json
run-report.json
```

`manifest.json` 和 `run-report.json` 会记录任务 id、轮次、图片文件路径、来源 URL 或截图来源。交付检测标准是：对应任务 id 目录下至少存在 1 个通过文件头校验的图片文件。

## 配置

主要配置在 `lovart.config.json`：

- `maxRounds`: 最大交互轮数，默认 6。
- `generationWaitMs`: 每轮等待图片生成的最长时间。
- `selectors`: Lovart 页面选择器。如果 Lovart 改版，优先调整这里。
- `followUpPrompt`: 当 Lovart 询问更多信息或未生成图片时，agent 发送的追问。

如果 Lovart 入口页登录后没有自动进入创作界面，可以把 `lovartUrl` 改成你登录后实际使用的创作页 URL。
