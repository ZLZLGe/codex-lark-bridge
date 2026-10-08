# 飞书 Codex 桥接维护

本仓库维护飞书与本机 Codex 的桥接程序。AutoData 等被操控的项目有各自的仓库；桥接修复在这里维护。

## 来源与分支

- 当前维护仓库：<https://github.com/ZLZLGe/codex-lark-bridge>
- 直接上游：<https://github.com/damowangdongdong/dongdong-codex-lark-bridge>
- 原始项目：<https://github.com/zarazhangrui/feishu-claude-code-bridge>
- `codex`：本仓库默认维护分支，从已部署的源码版本开始。
- `main`：创建 fork 时保留的上游分支；更新到维护分支前先审查差异并验证。

保留上游 Git 历史、MIT 许可证及作者信息。包名和命令仍为 `lark-channel-bridge`，本仓库的 Git 提交标识具体维护版本，不向上游 npm 包发布。

## 修复前基线

`deployed-2026-10-08` 标签指向 `c2c9aa3aa6ef1eda2d4225dd2efd3cc5f66ffc0e`，包版本为 `0.7.0`。接管时已比较原源码目录的 `dist/` 与机器上已安装包的 `dist/`，内容一致。

这份基线尚未修复长任务流式卡片停止更新的问题。维护初始化仅添加来源和操作说明、调整仓库链接；行为修复单独提交，便于比较和回退。

## 长任务流式回复

飞书原生 Markdown 流式卡片的更新窗口为 10 分钟。旧实现把整个任务的进度写进同一张卡片，长任务在后台继续运行时，卡片可能已停止接收更新；上下文压缩只是容易遇到这个问题的场景。

维护版本在卡片打开满 8 分钟后的下一条事件上续接新卡片，并结束旧卡片的流式生产者。若工具或压缩静默超过 10 分钟，恢复事件同样会写入新卡片。续接保留未完成工具及原回复位置，最终答案仍单独发送。没有新事件时不会定时发送空卡片。

回归测试模拟卡片超过 10 分钟后静默丢弃更新，覆盖第 8 分钟和第 11 分钟恢复、工具完成、再次续接和最终回复。

## 验证

使用 `package.json` 指定的 pnpm 版本：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm ci:local
```

`ci:local` 检查差异格式、运行测试、类型检查并构建。测试、构建日志和打包产物保存在仓库外。

从机器人会话内运行测试时，仅对测试子进程移除继承的 `LARK_CHANNEL*`、`LARKSUITE_CLI*` 环境变量，避免将本机 profile 路径带入隔离测试；保留运行中机器人的环境和授权。设置 `NODE_NO_WARNINGS=1`，避免 Node 的代理实验性警告污染 stderr 断言。临时目录可通过 `TMPDIR` 指向仓库外的数据盘。

## 本机安装与回退

从已验证的提交构建 tarball 并安装，避免直接安装 npm 上的同名上游包：

```sh
corepack pnpm build
corepack pnpm pack --pack-destination /absolute/path/outside-repository
npm install --global /absolute/path/outside-repository/lark-channel-bridge-0.7.0.tgz
```

安装只替换磁盘上的程序，运行中的桥接进程需要重启才会加载新版本。先确认没有正在执行的 Codex 任务；重启可能中断其消息传输。回退时从基线标签构建并安装，再重启桥接。

飞书应用密钥、用户授权、会话、机器人配置及日志都留在本机运行目录，不提交到 Git。用户授权是否可读文档由个人 profile 的身份策略及已授予 scope 决定，不在源码中保存账号凭据。
