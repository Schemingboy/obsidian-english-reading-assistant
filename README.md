# 英文阅读助手 · Obsidian

为普通英文 Markdown 打开独立精读页：意群分色、谓语提示、摘录手札与 Focus Questions。原文保持原样，手札保存为独立 Markdown。

当前版本 **0.3.1**。已在 Windows / Obsidian 1.13.7 验证；桌面插件，暂未验证 macOS、Linux，不支持移动端。当前通过手动安装使用，尚未提交 Obsidian 社区插件目录。

## 阅读与记录

- 用命令「为当前文章打开阅读助手」或左侧书本按钮打开当前文章。
- 点击「分析文章」启动本地英语句法分析；意群和谓语提示可以分别开关。
- 选中文字后「摘录选文」，输入理解并「保存手札」。换题或换独立摘录会暂存未完成文字，可切回原题或从草稿下拉框继续。
- 正在答题时，新摘录作为当前回答的证据，保留答案；「新手札」开始独立记录。
- 原文中的生词双链保留，可点击打开词卡。原文编辑后刷新阅读页，再分析。
- 正式手札按文章保存到 `Notes/reading-notes/`；包含来源链接、问题、摘录及自己的文字。卸载插件后仍可读。

## 深浅配色

![日间阅读示例](docs/reading-light.png)
![夜间阅读示例](docs/reading-dark.png)

意群使用两档中性灰底交替，起点辅以短分隔线；主句／从句谓语共用低饱和蓝色，分别用单线／双线；非谓语用柔和棕色虚线。背景负责分段，少量彩色负责语法重点，减少两层同时开启时的杂乱。意群分隔线只是显示效果，不写入原文或摘录。

| 检查 | 日间 | 夜间 |
| --- | --- | --- |
| 两档中性意群底色 | `#f7f7f5` / `#e5e7e9` | `#252b30` / `#333b42` |
| 正文及三类动词文字的最低对比度 | 5.56:1 | 5.69:1 |
| 分隔线与两档底色的最低对比度 | 3.28:1 | 3.44:1 |

参考 IBM Carbon 的中性色层次、Radix Colors 的背景／文字角色划分，以及 WCAG 的非颜色辅助提示。设计依据与具体色值见 [配色设计说明](docs/color-design.md)。文字对比度按 WCAG 相对亮度公式计算，超过 4.5:1；分隔线超过 3:1。数值保障可读性，整体协调仍需结合实际长文检查；以上结果在测试主题与当前配色下成立，自定义 CSS 可能改变结果。

## 本地安装

需要桌面版 Obsidian、Python 3.13，以及测试时使用的 Node.js 22 或更新版本。spaCy 及模型只在本地运行，不调用聊天模型或云端 API。

1. 克隆项目，在项目根目录创建 Python 环境并安装固定依赖：

   ```powershell
   python -m venv .runtime
   .runtime/Scripts/python.exe -m pip install -r plugin/requirements.txt
   .runtime/Scripts/python.exe plugin/check.py
   ```

2. 新建 `sync.local.json`，填写自己的绝对路径。这个文件已被 Git 忽略：

   ```json
   {
     "vault": "C:/path/to/your-vault",
     "python": "C:/path/to/this-project/.runtime/Scripts/python.exe"
   }
   ```

3. 执行 `python scripts/sync.py --check` 查看目标，再执行 `python scripts/sync.py` 安装。在 Obsidian 社区插件设置里启用「英文阅读助手」。已有同名且不同的插件文件会被拒绝覆盖，应先比较并保留自己的修改。

运行环境路径写入安装目录内的本机 `runtime.json`。没有这个配置时，插件尝试使用安装目录下 `.runtime/Scripts/python.exe`（Windows）或 `.runtime/bin/python`。Python 暂不可用时，普通阅读与手札仍能使用，分析会报告错误。

`focus-questions.json` 是可选的本机题库，不随本仓库分发，也不会被同步命令覆盖。没有题库时从正文提取已有问题；没有现成问题则提供明确标注的规则模板题，不冒充 AI 深度提问。题库格式示例见 [开发说明](docs/development.md)。

## 开发与同步

本仓库是开发源。`plugin/` 下修改完成后，用以下检查和同步流程更新实际使用的插件：

```powershell
node plugin/check.js
python plugin/check-colors.py
python scripts/check-sync.py
.runtime/Scripts/python.exe plugin/check.py
python scripts/sync.py --check
python scripts/sync.py --reload
```

`--reload` 需要已启用的插件、正在运行的 Obsidian 及可用的 Obsidian CLI。在 `sync.local.json` 加入 `obsidian`（CLI 绝对路径）和 `vaultName`（库名）。如需同时维护库内源码镜像，可加 `mirror`，值为相对 vault 的目录，例如 `Development/english-reading/plugin`。

同步只更新明确列出的代码文件，同时核对源码、镜像和安装文件哈希。目标文件在上次同步后被其他人改动时，整次同步会在写入前停止；不会悄悄覆盖。每次更新留本机备份，失败时恢复本次已覆盖的文件。`data.json`、分析缓存和本机题库不在同步名单内。它是开发源到使用端的单向同步，不是后台监听，也不会自动推送 GitHub。

更多说明见 [开发说明](docs/development.md) 和 [更新记录](CHANGELOG.md)。

## 已知边界

分析采用 spaCy `en_core_web_sm` 加规则，复杂长句、省略、动名词和分词形容词可能误判，不能作为考试判分依据。意群划分也没有唯一标准。

数学、代码和嵌入文件不参与分析。标记 `sensitive: true` 或 `scope: skip/meta` 的笔记拒绝读取正文。引文改动或重复到无法唯一定位时会提示核对。未保存草稿保存在插件本机数据中，长期留存仍应点击「保存手札」。
