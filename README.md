# 68oc — OpenCode 中文 CLI 版

基于 [anomalyco/opencode](https://github.com/anomalyco/opencode) 的自动构建，每次上游发布新版本时自动编译 CLI 二进制并翻译为中文。

## 特性

- **纯 CLI** — 仅编译命令行版，无桌面端，无 Web 界面
- **全中文** — TUI 界面文字、CLI 命令描述、错误提示全部翻译为中文
- **自动构建** — GitHub Workflow 每周检测上游更新，自动构建发布
- **无冲突** — 每次从干净上游 tag 构建，无 git merge，无冲突
- **启动命令** — `68oc`（而非 `opencode`）

## 下载

前往 [Releases](https://github.com/oc68/68oc/releases) 下载最新版 `68oc.exe`。

## 使用

```powershell
# 启动 TUI 界面
68oc

# 查看帮助
68oc --help

# 运行一次性会话
68oc run "修复这个 bug"

# 启动服务器
68oc serve
```

所有命令与原版 `opencode` 完全一致，仅界面文字为中文。

## 如何维护翻译

```bash
# 克隆上游最新版
git clone --depth 1 --branch v{tag} https://github.com/anomalyco/opencode

# 验证翻译覆盖度
cd 68oc && bun src/verify.ts ../opencode

# 查看缺失字符串并补充到 src/zh-CN.json
bun src/extract-en.ts ../opencode
```

## 项目结构

```
68oc/
├── .github/workflows/build.yml   # 自动构建工作流
├── src/
│   ├── zh-CN.json                # 中文翻译词典 (1312 条)
│   ├── en-zh-map.json            # CLI 英→中直接映射 (200 条)
│   ├── apply.ts                  # 构建脚本
│   ├── extract-en.ts             # 提取未翻译字符串
│   └── verify.ts                 # 翻译覆盖度验证
├── package.json
├── LICENSE
└── README.md
```

## 构建方式

```bash
# 本地构建（需要 Bun）
bun src/apply.ts v1.18.2
```

## 许可证

MIT
