# 开发说明

## 文件与依赖

`plugin/main.js` 直接由 Obsidian 加载，不需要打包器或 npm 依赖；`plugin/styles.css` 控制布局、意群与谓语配色。`plugin/analyzer.py` 接收 stdin JSON，返回 UTF-16 字符区间，保证 JavaScript 渲染位置一致。

Python 依赖在 `plugin/requirements.txt`。运行时、缓存、本机路径配置与笔记数据都不提交。GitHub Actions 运行不需下载模型的代码、颜色和同步检查；真实句法与应用交互验收在本地完成。

`scripts/sync.py` 使用 Python 标准库，不递归复制文件夹。安装端只接收 main.js、styles.css、manifest.json、analyzer.py 和按本机配置生成的 runtime.json；镜像额外接收固定依赖与检查脚本。

首次同步时，目标若已存在不同文件会停止。维护者需要人工核对差异，不能随便删除本机同步状态来强行覆盖。备份和上次同步的哈希在 `.local/`，仅供本机使用。

## 可选本机题库

在安装目录创建 `focus-questions.json`，内容为数组。文件路径是相对于当前 vault 的 Markdown 路径，target 是正文已有的 Obsidian 块 ID：

```json
[
  {
    "id": "sample-1",
    "file": "Reading/sample.md",
    "text": "Why did the travellers change their plan?",
    "target": "journey"
  }
]
```

对应正文示例：

```markdown
## A change of plan ^journey

The travellers changed their plan because the bridge was closed.
```

原书题库与文章的版权和本机路径由使用者自行管理；仓库只提供此虚构示例。没有题库不会影响插件加载。

## 发布前检查

1. 修改 `plugin/manifest.json` 的版本，并更新 CHANGELOG。
2. 运行 README 列出的检查；本地 Obsidian 验证主题、选文、双链、草稿切换和保存。
3. 运行同步预览，再同步并重载；检查源文未变及安装版本。
4. 提交前检查 Git 暂存内容，只包含源码、文档、虚构示例、检查和展示图；不包含任何真实文章、题库、草稿、缓存、路径配置或 Python 环境。
5. 推送后核对远端 commit SHA。若需要发布 zip，可显式打包安装端四个代码文件；Python 环境单独按 README 准备。

当前公开仓库未附带特定书籍数据，也未自动提交到 Obsidian 社区目录。

## 选词写入与语法显示

`sourcePosition` 使用与阅读页相同的原生 MarkdownRenderer，给候选原文字串临时加位置标记，只在离屏渲染中验证选区；显示文字必须逐字一致，且唯一匹配。标记不写盘。`vault.process` 内再次核对整篇原文哈希与目标字串，成功后仅给当前选区的文本节点包链接，保留分析节点和滚动位置。无法可靠映射时拒绝写入，不用全局替换降级。撤销也核验哈希，因此不会覆盖后来的编辑。

标词和当前句分析都有 Obsidian 命令，可由用户绑定快捷键。新词目标采用小写、显示别名保留原文；生词发现工具应分别读取链接目标和显示文字。没有词典调用、自动词形归并或词卡批处理。

分析器 r2 输出句子区间供当前句提示使用；阅读意群保留完整外层从句，关系从句与所修饰名词保持连贯，动词链内部禁止切分。界面默认主干模式，完整模式和当前句展开才显示全部三类提示。规则仍是本地句法启发式，不能保证复杂句分析正确。
