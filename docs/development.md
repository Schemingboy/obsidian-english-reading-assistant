# 开发说明

## 文件与依赖

`plugin/main.js` 由 Obsidian 加载，再以安装目录为基准通过 Node createRequire 加载 `agent.js`、`agent-ui.js` 和 `agent-reading.js`，重载时清理这三个模块的缓存；不要假定宿主主入口能直接相对 require。不需要打包器或 npm 依赖。`plugin/styles.css` 控制布局、意群与谓语配色。`plugin/analyzer.py` 接收 stdin JSON，返回 UTF-16 字符区间，保证 JavaScript 渲染位置一致。

Python 依赖在 `plugin/requirements.txt`。运行时、缓存、本机路径配置与笔记数据都不提交。GitHub Actions 运行不需下载模型的代码、颜色和同步检查；真实句法与应用交互验收在本地完成。

`scripts/sync.py` 使用 Python 标准库，不递归复制文件夹。安装端只接收 main.js、agent.js、agent-ui.js、agent-reading.js、styles.css、manifest.json、analyzer.py 和按本机配置生成的 runtime.json；镜像额外接收固定依赖与检查脚本。

首次同步时，目标若已存在不同文件会停止。维护者需要人工核对差异，不能随便删除本机同步状态来强行覆盖。备份和上次同步的哈希在 `.local/`，仅供本机使用。同步名单不包含 README 或 docs；库内 README 和使用指南是独立的本地入口文档，需按本轮行为同步表述。

`--reload` 会恢复原阅读页，之前已分析的页面会再次请求分析。分析版本升级后，全章重算可能超过同步器 60 秒等待；CLI 超时不等于插件未加载。先查安装 manifest、实际插件版本和 `--check`，再按 `.local/backups/` 的索引核查恢复范围。读写失败时自动回滚也可能未完成，不要盲目重载或覆盖同步状态。

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
| Agent 上下文、调用、设置与采纳 | [agent.js](../plugin/agent.js)、[agent-reading.js](../plugin/agent-reading.js)、[agent-ui.js](../plugin/agent-ui.js) | `node plugin/check-agent.js` 覆盖真实本地 HTTP 协议、失败与取消、草稿并发保护；真实模型和侧栏另用虚构材料验收。 |

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
2. 发布前运行 README 列出的检查；本地 Obsidian 验证本轮影响的交互。日常小改按实际影响选择检查，纯文档整理只核内容、路径、差异和状态，不重复模型调用或整套历史验收。
3. 运行同步预览，再同步并重载；检查源文未变及安装版本。
4. 提交前检查 Git 暂存内容，只包含源码、文档、虚构示例、检查和展示图；不包含任何真实文章、题库、草稿、缓存、路径配置或 Python 环境。
5. 推送后核对远端 commit SHA。若需要发布 zip，可显式打包安装端七个文件；Python 环境单独按 README 准备。

## Agent 的维护边界

`agent.js` 负责接口、CLI、设置和密钥；`agent-reading.js` 是无 DOM 的阅读流程，集中处理分批阅读、独立参考理解、上下文预算与修订差异；`agent-ui.js` 收集当前文章和手札、组织对话及采纳。不引入检索数据库、自主工具循环或按模型分别维护提示词。

`Reading.run` 的独立参考阶段绝不带学生答案和历史；第二阶段才组合文章／阅读笔记、参考理解、用户答案和讨论。长文分批发送全部源文本，超长段落按边界续读，保留段号；必要时多轮压缩笔记，输出不缩短时失败而非截断。历史压缩只用于本次调用，存储的原对话不删除。容量是可调字符估算，需要给 JSON 转义、指令和回答预留空间，不声称精确模型 token 计量。参考理解和中间阅读笔记缓存以模型配置、文本和问题散列隔离，当前页面内复用，最多 80 项。

`agent-ui.js` 主菜单只提供自由提问和检查回答，其他请求直接输入；保留的内部任务名不代表可见菜单。默认 `provider=copy` 仅复制材料，插件内发送与模型修订禁用，也不会自动读回外部客户端回答；API 与可选 Claude Code 才执行自动阅读流程。

文章读取仅当前 `.era-content`；嵌入目标、代码和元数据排除，段号指向当前版本的显示块，不写原文。对话存于 data.json 的 `agentChats`，草稿修改前版本存于 `agentUndo`，均只在本机。重命名文章时跟随既有数据映射移动，不扩展到其他笔记。

修订预览包含源文章版本和整个草稿 JSON 基线；只修改正文，保留问题、摘录和已保存记录身份。保存后记录唯一对应手札的 marker 快照，使撤回可重开同条记录再保存；后来又有修改或出现重复记录时不覆盖。预览本身只在当前页面，应用前不会写正式手札；应用前后对照和原稿存储共用一套机制。空原稿恢复不自动删除已保存笔记。

API 密钥使用 SecretStorage，旧宿主仅会话内内存保存；普通设置、上下文和错误信息不携带密钥。模型列表使用同一端点的 GET /models，失败保留手填入口。测试连接不读文章、不自动保存凭据。请求不重定向、不自动重试，有取消、超时和返回大小限制。

Claude Code 使用原生可执行文件和参数数组，shell=false，stdin 传入材料；每次创建库外临时目录，仅清理本次目录。关闭内置工具、MCP、Hooks、技能和会话持久化，保留原有登录和用户服务配置。不支持参数时失败，不用 bypass 兜底。模型输出以受限 DOM 文字格式显示，采纳前把活动语法转为文字；复制保持原始输出。

当前公开仓库未附带特定书籍数据，也未自动提交到 Obsidian 社区目录。

## 原生大纲与手札实时预览

Reader 继承公开 FileView，onLoadFile 仍先经过 readyFile 的阅读边界检查。原生大纲能跟随当前文件，但当前宿主的大纲定位只接受 MarkdownView；插件对已存在的大纲实例包装 findCorrespondingLeaf／getOwner，仅在对应 Reader 活动时返回它，其他视图委托原方法，卸载时恢复。新大纲窗口在 layout-change 时接入，不改宿主全局原型。此处依赖 Obsidian 核心插件内部方法，宿主升级需核验；缺少方法时跳过适配。

mapOutlineHeadings 按原生元数据、标题层级和显示顺序关联节点；setEphemeralState 接收大纲行号，原文过期则拒绝跳转。scroll／getMode 和 markdown-scroll 事件提供原生滚动高亮。不把正文中的粗体小标题伪装成 Markdown 标题。

手札保留 textarea，实时预览开启后在下方用原生 MarkdownRenderer 渲染；180ms 合并输入，在离屏节点生成后替换，版本序号丢弃切稿、关页与关闭预览后的迟到结果。每次替换释放旧 Component，不重建输入框。它是同时显示输入与预览，不是光标离开后隐藏语法符号的原生 Live Preview 编辑器。

## 选词写入与语法显示

`sourcePosition` 使用与阅读页相同的原生 MarkdownRenderer，给候选原文字串临时加位置标记，只在离屏渲染中验证选区；显示文字必须逐字一致，且唯一匹配。标记不写盘。`vault.process` 内再次核对整篇原文哈希与目标字串，成功后仅给当前选区的文本节点包链接，保留分析节点和滚动位置。无法可靠映射时拒绝写入，不用全局替换降级。撤销也核验哈希，因此不会覆盖后来的编辑。

标词和当前句分析都有 Obsidian 命令，可由用户绑定快捷键。新词目标采用小写、显示别名保留原文；生词发现工具应分别读取链接目标和显示文字。没有词典调用、自动词形归并或词卡批处理。

阅读正文使用委托事件接入原生双链：插件通过 `registerHoverLinkSource` 注册独立来源，`mouseover` 发出 `hover-link`，携带原始 `data-href` 和当前文章路径。已有链接及局部新插入的链接共用处理，目标中的标题／块引用不裁剪。由核心 Page preview 控制修饰键和弹窗；拖选或在同一链接内部移动时不重发，阅读组件卸载时清理所属 HoverPopover。打开链接统一使用 `Keymap.isModEvent` 和 `workspace.openLinkText`，兼容中键新标签与修饰键分栏，不模拟浏览器地址跳转。使用的接口可查 [Obsidian 官方 API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)。

分析器 r5 始终输出三类动词与句子区间。`layers.verbs` 控制主句和从句谓语，默认开启；`layers.nonfinite` 独立控制非谓语，默认关闭。`detailSentence` 仅给当前句设置 `data-detail`，临时显示全部类型；`clearSentence` 清除局部提示，不修改全局开关。`syncLayers` 同步按钮、样式与图例，不重跑分析。规则仍是本地句法启发式，不能保证复杂句分析正确。

r5 在解析输入中等长归一不间断空格，返回区间仍切原文；`recovered_finite_roles` 处理受约束的动名词主语后过去式误标，谓语循环修正跨分号错误挂接的独立主句。这些修正与意群分组独立维护，不能按具体文章补词语白名单。

### 意群规则的维护边界

目标是每次接收一个可理解的信息块，沿着动作与补充信息连续阅读。无需复刻其他阅读器，也不追求越短越好。分组集中在 `reading_cuts`，按以下顺序处理：

1. 句界与标点：保留句子边界，分号和冒号优先；括号与引号按归属保留，纯标点不独立成组。解析前的 `reading_era_sentences` 只辅助“年份＋纪年缩写＋大写开头”的常见句界；例如 century B.C. Athens 不触发，歧义年份表达仍须人工判断。
2. 结构边界：长从句、长并列可以逐层展开；短从句、名词名单和动词链作为保护范围。保护名单核心而不是包含后续地点、分号、列举项的整棵依存子树。
3. 补充信息：时间、地点等介词短语是可选切点；of 关系、名词后的 to / for 补语、比较修饰、紧接非谓语的介词等倾向保留。数字范围整体保留。这是句法上的保守判断，不是完整的固定搭配识别器。

仅两个长度常量：`COMPACT_WORDS = 8` 决定短结构保护范围；`MIN_MODIFIER_WORDS = 3` 要求可选切点两侧有足够内容。这里按非空白、非标点的模型 token 计数；结构边界仍允许短组，不强制将每组塞进某个长度区间，也不为了补足词数把短组跨从句拼接。

改规则先找上述哪一层出现问题，并新增自写的行为反例；避免按文章、人名或句子添加特判。公开回归使用虚构文本，本地正文用于对照与保留样本验证。两个阈值或分组行为改变时同时更新 Python 和 JavaScript 的分析器版本，使旧缓存自然失效。谓语分类不随分组风格重写；句界修正可能改善其主从判断。

0.5.0 的草稿和保存标记增加 `excerpts` 数组，每条仍携带 quote / before / after；旧单摘录字段按需读取，保存时保留首条兼容字段。保存使用草稿深快照，写盘期间继续修改不会被清空。0.6.0 将已保存记录载入现有侧栏；`noteEntries` 解析生成时的标题、来源、问题及引文前缀，正文里的 Markdown 二级标题不会另起记录。编辑草稿持有原记录快照，`vault.process` 只替换唯一且未变化的目标片段；同记录并发改动会拒绝覆盖，其他记录的新内容保留。格式已在外部重排到无法可靠解析时拒绝原地更新。保存时又有新输入，会推进其基线并保留文字，下一次更新仍指向同一条记录。

页内搜索使用 DOM Range 和 CSS Highlight，不插入会干扰源文定位的包装节点。选词先去掉首尾空白，再验证完整词和禁止区域；键盘处理限于当前阅读页，输入框与输入法组合事件不参与括号快捷标词。段首小标题只加显示样式，不改正文字符或源文件。意群渲染切出首尾空白，不给这些空白铺底色；每个意群首片段加 0.10em 外间距，标点后的意群同样处理，不插分隔字符，也不在谓语等内部片段重复留间隙。
