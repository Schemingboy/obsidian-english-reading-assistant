# 开发说明

## 文件与依赖

`plugin/main.js` 直接由 Obsidian 加载，不需要打包器或 npm 依赖；`plugin/styles.css` 控制布局、意群与谓语配色。`plugin/analyzer.py` 接收 stdin JSON，返回 UTF-16 字符区间，保证 JavaScript 渲染位置一致。

Python 依赖在 `plugin/requirements.txt`。运行时、缓存、本机路径配置与笔记数据都不提交。GitHub Actions 运行不需下载模型的代码、颜色和同步检查；真实句法与应用交互验收在本地完成。

`scripts/sync.py` 使用 Python 标准库，不递归复制文件夹。安装端只接收 main.js、styles.css、manifest.json、analyzer.py 和按本机配置生成的 runtime.json；镜像额外接收固定依赖与检查脚本。

首次同步时，目标若已存在不同文件会停止。维护者需要人工核对差异，不能随便删除本机同步状态来强行覆盖。备份和上次同步的哈希在 `.local/`，仅供本机使用。

## 按功能定位源码与验证

先按下表定位符号，再读取附近实现；使用符号名而非固定行号，避免代码增长后导航失效。命令均从仓库根目录运行，完整命令见 [README 的开发与同步](../README.md#开发与同步)。

| 要修改什么 | 源码入口与符号 | 验证入口与边界 |
|---|---|---|
| 意群、谓语、UTF-16 区间 | [analyzer.py](../plugin/analyzer.py) 的 `analyze`；[main.js](../plugin/main.js) 的 `analyzeCurrent`、`runAnalyzer` | [check.py](../plugin/check.py)：需已安装句法模型；实际标色另在 Obsidian 验证。 |
| 选词、括号标词、撤销 | [main.js](../plugin/main.js) 的 `readerKey`、`selectedWord`、`sourcePosition`、`linkSelection`、`undoLink` | [check.js](../plugin/check.js) 检查链接纯函数；双击、反向选区、原文定位和滚动需真实应用检查。 |
| 多段摘录、草稿、保存及编辑 | [main.js](../plugin/main.js) 的 `capture`、`saveNote`、`editSaved`、`noteEntries`、`updateNote` | [check.js](../plugin/check.js) 检查记录解析及替换边界；草稿切换、保存期间输入需真实应用检查。 |
| 正文搜索、阅读布局 | [main.js](../plugin/main.js) 的 `render`、`openSearch`、`findText`；[styles.css](../plugin/styles.css) | 在 Obsidian 验证搜索焦点、快捷键和窄窗布局；静态检查不代替交互验收。 |
| 配色与可读性 | [styles.css](../plugin/styles.css)；[配色设计](color-design.md) | [check-colors.py](../plugin/check-colors.py) 加真实深浅主题截图。 |
| 源码同步、安装与冲突保护 | [sync.py](../scripts/sync.py) | [check-sync.py](../scripts/check-sync.py)；`python scripts/sync.py --check` 只预览，实际同步与重载另行执行。 |

例如先执行 `rg -n 'sourcePosition|linkSelection|undoLink' plugin/main.js`，再按命中位置读取相关函数，不一次输出全部源码、样式和检查文件。真实应用脚本与个人夹具在使用者本机项目中维护，不随公开仓库发布；测试前确认临时文件、笔记写入和界面操作范围。

文件或符号改名时同步更新本表；验收结果与当前版本仍分别记录在对应报告和 CHANGELOG，本表只维护查找入口。

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

阅读正文使用委托事件接入原生双链：插件通过 `registerHoverLinkSource` 注册独立来源，`mouseover` 发出 `hover-link`，携带原始 `data-href` 和当前文章路径。已有链接及局部新插入的链接共用处理，目标中的标题／块引用不裁剪。由核心 Page preview 控制修饰键和弹窗；拖选或在同一链接内部移动时不重发，阅读组件卸载时清理所属 HoverPopover。打开链接统一使用 `Keymap.isModEvent` 和 `workspace.openLinkText`，兼容中键新标签与修饰键分栏，不模拟浏览器地址跳转。使用的接口可查 [Obsidian 官方 API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)。

分析器 r4 输出句子区间供当前句提示使用；界面默认主干模式，完整模式和当前句展开才显示全部三类提示。规则仍是本地句法启发式，不能保证复杂句分析正确。

### 意群规则的维护边界

目标是每次接收一个可理解的信息块，沿着动作与补充信息连续阅读。无需复刻其他阅读器，也不追求越短越好。分组集中在 `reading_cuts`，按以下顺序处理：

1. 句界与标点：保留句子边界，分号和冒号优先；括号与引号按归属保留，纯标点不独立成组。解析前的 `reading_era_sentences` 只辅助“年份＋纪年缩写＋大写开头”的常见句界；例如 century B.C. Athens 不触发，歧义年份表达仍须人工判断。
2. 结构边界：长从句、长并列可以逐层展开；短从句、名词名单和动词链作为保护范围。保护名单核心而不是包含后续地点、分号、列举项的整棵依存子树。
3. 补充信息：时间、地点等介词短语是可选切点；of 关系、名词后的 to / for 补语、比较修饰、紧接非谓语的介词等倾向保留。数字范围整体保留。这是句法上的保守判断，不是完整的固定搭配识别器。

仅两个长度常量：`COMPACT_WORDS = 8` 决定短结构保护范围；`MIN_MODIFIER_WORDS = 3` 要求可选切点两侧有足够内容。这里按非空白、非标点的模型 token 计数；结构边界仍允许短组，不强制将每组塞进某个长度区间，也不为了补足词数把短组跨从句拼接。

改规则先找上述哪一层出现问题，并新增自写的行为反例；避免按文章、人名或句子添加特判。公开回归使用虚构文本，本地正文用于对照与保留样本验证。两个阈值或分组行为改变时同时更新 Python 和 JavaScript 的分析器版本，使旧缓存自然失效。谓语分类不随分组风格重写；句界修正可能改善其主从判断。

0.5.0 的草稿和保存标记增加 `excerpts` 数组，每条仍携带 quote / before / after；旧单摘录字段按需读取，保存时保留首条兼容字段。保存使用草稿深快照，写盘期间继续修改不会被清空。0.6.0 将已保存记录载入现有侧栏；`noteEntries` 解析生成时的标题、来源、问题及引文前缀，正文里的 Markdown 二级标题不会另起记录。编辑草稿持有原记录快照，`vault.process` 只替换唯一且未变化的目标片段；同记录并发改动会拒绝覆盖，其他记录的新内容保留。格式已在外部重排到无法可靠解析时拒绝原地更新。保存时又有新输入，会推进其基线并保留文字，下一次更新仍指向同一条记录。

页内搜索使用 DOM Range 和 CSS Highlight，不插入会干扰源文定位的包装节点。选词先去掉首尾空白，再验证完整词和禁止区域；键盘处理限于当前阅读页，输入框与输入法组合事件不参与括号快捷标词。段首小标题只加显示样式，不改正文字符或源文件。意群渲染切出首尾空白，不给这些空白铺底色；每个意群首片段加 0.10em 外间距，标点后的意群同样处理，不插分隔字符，也不在谓语等内部片段重复留间隙。
