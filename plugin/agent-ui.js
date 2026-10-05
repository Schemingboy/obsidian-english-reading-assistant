const Agent = require('./agent');
const quotes = d => Array.isArray(d.excerpts) ? d.excerpts : d.quote ? [{ quote: d.quote }] : [];
const Reading = require('./agent-reading');
const { randomUUID } = require('crypto');
const newState = () => ({ task: 'discuss', instruction: '', status: '文章会自动带入，可以直接提问。', picked: new Map(), cache: new Map() });
const textOf = el => {
  if (!el) return '';
  if (el.matches('.internal-embed,code,pre,script,style,button,svg')) return '';
  const copy = el.cloneNode(true);
  copy.querySelectorAll('.internal-embed,code,pre,script,style,button,svg').forEach(n => n.remove());
  return copy.textContent.trim();
};
// Deliberately small display subset: no HTML, URLs, embeds or host Markdown postprocessors.
function renderResult(el, text) {
  el.empty();
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (!line.trim()) { el.createDiv('era-agent-spacer'); continue; }
    const heading = !fenced && line.match(/^(#{1,6})\s+(.+)$/);
    const row = el.createEl(heading ? 'h4' : 'div', { cls: fenced ? 'era-agent-code-line' : 'era-agent-line' });
    const content = heading ? heading[2] : line;
    if (fenced) { row.textContent = content; continue; }
    // Text nodes keep raw HTML/links inert, while common emphasis remains readable.
    const tokens = /(\*\*([^*]+)\*\*|`([^`]+)`|\*([^*]+)\*)/g;
    let offset = 0;
    for (const match of content.matchAll(tokens)) {
      row.appendText(content.slice(offset, match.index));
      row.createEl(match[2] ? 'strong' : match[3] ? 'code' : 'em', { text: match[2] || match[3] || match[4] });
      offset = match.index + match[0].length;
    }
    row.appendText(content.slice(offset));
  }
}

module.exports = {
  agentChat() { return (this.plugin.data.agentChats ||= {})[this.file.path] ||= []; },
  explainWithAgent() { this.openAgent('sentence'); },
  reviewWithAgent(question) {
    const draft = [this.draft(), ...this.parkedDrafts()].find(d => d.question === question && d.text.trim());
    const saved = (this.entries || []).filter(entry => entry.question === question && entry.editable).at(-1);
    if (draft) this.switchDraft(draft); else if (saved) this.editSaved(saved); else this.answerQuestion(question);
    this.openAgent('review');
  },
  articleForAgent() {
    const nodes = [...this.article.querySelector('.era-content').children];
    this.agentParagraphs = new Map();
    return nodes.map((node, i) => {
      const text = textOf(node); if (!text) return '';
      const id = 'P' + (i + 1); this.agentParagraphs.set(id, node);
      return `[${id}] ${text}`;
    }).filter(Boolean).join('\n\n');
  },
  selectedAgentPassage() {
    const selection = this.article.ownerDocument.getSelection();
    const range = selection?.rangeCount && !selection.isCollapsed && this.article.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.getRangeAt(0) : this.lastWordRange;
    if (!range || !this.article.contains(range.commonAncestorContainer)) return '';
    const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    if (start.closest('.internal-embed,code,pre') || range.cloneContents().querySelector('.internal-embed,code,pre')) return '';
    return range.toString().trim();
  },
  vocabularyForAgent() {
    const words = new Map();
    for (const anchor of this.article.querySelectorAll('a.internal-link')) {
      if (anchor.closest('.internal-embed,code,pre')) continue;
      const href = anchor.getAttribute('data-href') || ''; if (/[#^]/.test(href)) continue;
      const word = href.replace(/\.md$/i, '').split('/').at(-1);
      if (/^[a-zA-Z]+(?:['’-][a-zA-Z]+)*(?: [a-zA-Z]+(?:['’-][a-zA-Z]+)*){0,2}$/.test(word) && !words.has(word.toLowerCase())) words.set(word.toLowerCase(), `${word}（原文：${anchor.textContent}）`);
    }
    return [...words.values()].join('\n');
  },
  prepareAgentContext() {
    this.plugin.checkFile(this.file);
    if (this.stale) throw Error('原文有更新，先刷新阅读页即可继续。');
    const d = this.draft(), state = this.agentState;
    state.context = {
      article: this.articleForAgent(), question: d.question || this.readingGoal(), answer: d.text,
      selection: this.selectedAgentPassage(), excerpts: quotes(d).map(q => q.quote).join('\n\n'),
      vocabulary: this.vocabularyForAgent(),
      questions: this.plugin.questions.filter(q => q.file === this.file.path).map(q => q.text)
    };
    if (this.agentContext) this.agentContext.textContent = JSON.stringify(state.context, null, 2);
    if (this.agentContextSummary) this.agentContextSummary.textContent = `本次参考：文章全文${state.context.question ? ' · 当前问题' : ''}${d.text.trim() ? ' · 我的回答' : ''}${state.context.selection ? ' · 重点选句' : ''} · 查看`;
    return state.context;
  },
  buildAgentPanel() {
    this.agentState ||= newState(); const state = this.agentState, panel = this.agentPanel;
    const header = panel.createDiv('era-panel-heading'); header.createEl('h3', { text: '围绕这篇文章，继续想一想' });
    this.button(header, '模型设置', () => { this.app.setting.open(); this.app.setting.openTabById(this.plugin.manifest.id); }, 'settings-2');
    this.agentTask = panel.createEl('select', { cls: 'era-agent-task', attr: { 'aria-label': '阅读讨论方式' } });
    for (const [value, text] of [['discuss', '自由提问'], ['review', '检查回答']]) this.agentTask.createEl('option', { value, text });
    this.agentTask.value = state.task;
    this.agentTask.addEventListener('change', () => { state.task = this.agentTask.value; this.refreshAgentContext(); });
    this.agentContextDetails = panel.createEl('details', { cls: 'era-agent-context-details' });
    this.agentContextSummary = this.agentContextDetails.createEl('summary', { text: '自动参考当前文章 · 查看' });
    this.agentContext = this.agentContextDetails.createEl('pre', { cls: 'era-agent-context-preview' });
    this.button(this.agentContextDetails, '刷新上下文', () => this.refreshAgentContext(), 'refresh-cw');
    this.agentConversation = panel.createDiv({ cls: 'era-agent-conversation', attr: { tabindex: '0', role: 'region', 'aria-label': '本文讨论历史，可滚动查看' } });
    this.agentConversation.addEventListener('mouseup', () => this.captureAgentSelection());
    this.agentConversation.addEventListener('keyup', () => this.captureAgentSelection());
    this.agentInstruction = panel.createEl('textarea', { cls: 'era-agent-instruction', attr: { placeholder: '直接说你想弄清什么，也可以继续追问。', 'aria-label': '向阅读助手提问' } });
    this.agentInstruction.value = state.instruction;
    this.agentInstruction.addEventListener('input', () => { state.instruction = this.agentInstruction.value; });
    this.agentInstruction.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!this.agentSend.disabled) this.agentSend.click(); }
    });
    this.agentDestination = panel.createDiv('era-muted');
    const run = panel.createDiv('era-agent-actions');
    this.agentSend = this.button(run, '发送', () => this.runAgent(), 'send'); this.agentSend.addClass('era-primary');
    this.agentCopy = this.button(run, '复制上下文', async () => {
      await this.checkAgentSource(); const context = this.prepareAgentContext();
      const text = Agent.prompt(state.task, JSON.stringify({ ...context, history: this.agentChat().map(({ role, text }) => ({ role, text })) }, null, 2), state.instruction);
      await this.article.ownerDocument.defaultView.navigator.clipboard.writeText(Agent.SYSTEM + '\n\n' + text);
      this.agentMessage('已复制全文、当前问题和讨论。可粘贴到已有对话。');
    }, 'copy');
    this.agentCancel = this.button(run, '取消', () => this.cancelAgent(), 'x');
    this.agentStatus = panel.createDiv({ cls: 'era-agent-status era-muted', attr: { role: 'status', 'aria-live': 'polite' } });
    this.agentSelectionLabel = panel.createDiv('era-muted');
    const adopt = panel.createDiv('era-agent-actions');
    this.agentAppend = this.button(adopt, '保留选段', () => this.retainAgentSelection(), 'text-select');
    this.agentRevise = this.button(adopt, '整理进手札', () => this.runAgent('revise'), 'notebook-pen');
    for (const button of [this.agentAppend, this.agentRevise]) button.addEventListener('mousedown', e => { this.captureAgentSelection(); e.preventDefault(); });
    this.button(adopt, '清除选择', () => { state.picked.clear(); state.selectedText = ''; this.renderAgentConversation(); this.updateAgentUI(); });
    this.agentRevisionBox = panel.createDiv('era-agent-revision');
    this.renderAgentConversation(); this.scrollAgentAnswer(); this.renderAgentRevision(); this.updateAgentUI();
  },
  refreshAgentContext() {
    if (!this.agentState || !this.article?.querySelector('.era-content')) return;
    try { this.prepareAgentContext(); } catch (error) { this.agentMessage(error.message); }
  },
  renderAgentConversation() {
    if (!this.agentConversation) return;
    const state = this.agentState, scroll = this.agentConversation.scrollTop; this.agentConversation.empty();
    for (const message of this.agentChat()) {
      const turn = this.agentConversation.createDiv({ cls: 'era-agent-turn', attr: { 'data-role': message.role } });
      turn.createDiv({ cls: 'era-agent-result-label', text: message.role === 'user' ? '你' : `${message.provider} · ${message.coverage?.mode === 'segmented' ? `已分批阅读 ${message.coverage.read}/${message.coverage.total}，依据阅读笔记回答` : '参考文章全文'}` });
      if (message.role === 'user') { turn.createDiv({ cls: 'era-agent-user', text: message.text }); continue; }
      const answer = turn.createDiv('era-agent-answer');
      message.text.split(/\n\s*\n/).filter(Boolean).forEach((part, i) => {
        const key = `${message.id}:${i}`, row = answer.createDiv('era-agent-part');
        const pick = row.createEl('input', { attr: { type: 'checkbox', 'aria-label': `选取第 ${i + 1} 段收获` } }); pick.checked = state.picked.has(key);
        pick.addEventListener('change', () => { state.selectedText = ''; if (pick.checked) state.picked.set(key, part); else state.picked.delete(key); this.updateAgentUI(); });
        const body = row.createDiv('era-agent-part-body'); renderResult(body, part);
        const ids = [...new Set(part.match(/\[P\d+\]/g) || [])];
        if (ids.length) {
          const links = row.createDiv('era-agent-citations');
          for (const id of ids) this.button(links, id, () => {
            if (this.stale || message.sourceHash !== this.sourceHash) throw Error('原文版本已变化，旧段号需要重新核对。');
            this.articleForAgent(); const target = this.agentParagraphs.get(id.slice(1, -1));
            if (!target) throw Error('此段号未在文章中找到，请核对模型引用。');
            target.scrollIntoView({ block: 'center' });
          });
        }
      });
      this.button(turn, '复制回答', async () => { await this.article.ownerDocument.defaultView.navigator.clipboard.writeText(message.text); this.agentMessage('已复制这条回答。'); }, 'copy');
      if (message.reference) {
        const reference = turn.createEl('details'); reference.createEl('summary', { text: '查看独立参考理解（也可质疑）' });
        const content = reference.createDiv('era-agent-part-body'); renderResult(content, message.reference);
      }
    }
    this.agentConversation.scrollTop = scroll;
  },
  scrollAgentAnswer() {
    const box = this.agentConversation, last = box?.lastElementChild;
    if (last) box.scrollTop += last.getBoundingClientRect().top - box.getBoundingClientRect().top;
  },
  captureAgentSelection() {
    const selection = this.article.ownerDocument.getSelection(); if (!selection?.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0); const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
    if (this.agentConversation.contains(node) && node.closest('.era-agent-answer,.era-agent-part-body')) {
      this.agentState.selectedText = selection.toString().trim(); this.updateAgentUI();
    }
  },
  chosenAgentText() { return this.agentState.selectedText || [...this.agentState.picked.values()].join('\n\n'); },
  agentMessage(message) { this.agentState.status = message; if (this.agentStatus) this.agentStatus.textContent = message; },
  updateAgentUI() {
    if (!this.agentStatus || !this.agentState) return;
    const state = this.agentState, busy = !!this.agentController, config = { ...Agent.DEFAULTS, ...this.plugin.data.agentSettings };
    let destination = 'Codex / ChatGPT · 复制上下文后粘贴到已有对话';
    if (config.provider === 'claude') destination = `Claude Code · ${config.claudeModel || '默认模型'}`;
    if (config.provider === 'api') { try { destination = `${Agent.endpoint(config.baseUrl).host} · ${config.model}`; } catch { destination = '点击模型设置完成配置'; } }
    this.agentDestination.textContent = destination;
    this.agentTask.disabled = this.agentInstruction.disabled = this.agentCopy.disabled = busy;
    this.agentSend.disabled = busy || config.provider === 'copy'; this.agentCancel.hidden = !busy;
    this.agentStatus.textContent = state.status;
    const selected = this.chosenAgentText();
    this.agentSelectionLabel.textContent = selected ? `已选 ${selected.length} 字符 · 只采纳这部分` : '选中回答中的文字，或勾选段落，再保留或整理。';
    this.agentAppend.disabled = busy || !selected;
    this.agentRevise.disabled = busy || !selected || config.provider === 'copy';
    if (this.agentUndoButton) this.agentUndoButton.hidden = !this.plugin.data.agentUndo?.[this.file.path];
  },
  async checkAgentSource() {
    const file = this.file; await this.plugin.readyFile(file);
    if (this.file !== file || this.stale || this.renderedPath !== file.path) throw Error('文章有更新，请刷新阅读页后继续。');
    if (this.draft().edit) await this.plugin.readyFile(this.app.vault.getAbstractFileByPath(this.draft().edit.path));
  },
  openAgent(task = 'discuss') {
    this.selectPanel('agent'); if (this.agentController) return;
    if (task === 'sentence') { task = 'discuss'; this.agentState.instruction = '请结合全文解释重点选句。'; this.agentInstruction.value = this.agentState.instruction; }
    this.agentState.task = task; this.agentTask.value = task; this.refreshAgentContext(); this.agentInstruction.focus({ preventScroll: true });
  },
  cancelAgent() {
    if (!this.agentController) return;
    const controller = this.agentController; this.agentController = null; controller.abort();
    this.agentMessage('已取消，已完成的阅读笔记可在本页重试时复用；手札未改动。'); this.updateAgentUI();
  },
  async runAgent(override) {
    if (this.agentController) return;
    await this.checkAgentSource(); if (this.agentController) return;
    const state = this.agentState, config = { ...Agent.DEFAULTS, ...this.plugin.data.agentSettings };
    if (config.provider === 'copy') throw Error('请复制上下文，或在模型设置中选择调用方式。');
    const task = override || state.task, context = this.prepareAgentContext();
    const selected = task === 'revise' ? this.chosenAgentText() : context.selection;
    if (task === 'revise' && !selected) throw Error('先选择要融入手札的收获。');
    if (task === 'discuss' && !state.instruction.trim()) { this.agentInstruction.focus(); throw Error('写下想讨论的问题，或选择一个快捷任务。'); }
    const provider = config.provider === 'claude' ? `Claude Code / ${config.claudeModel || '默认模型'}` : `${Agent.endpoint(config.baseUrl).host} / ${config.model}`;
    const draft = this.draft(), snapshot = JSON.stringify(draft), source = this.file.path, sourceHash = this.sourceHash, generation = this.generation;
    const query = task === 'revise' ? '仅融入我选中的内容，保留我的表达。' : state.instruction;
    const controller = this.agentController = new AbortController(); this.agentMessage('正在准备文章…'); this.updateAgentUI();
    try {
      const call = text => config.provider === 'claude' ? Agent.claudeCall(config, text, controller.signal) : Agent.apiCall(config, this.plugin.agentKey(config), text, controller.signal);
      const history = this.agentChat().map(m => ({ ...m, text: m.sourceHash !== sourceHash ? '[较早文章版本的讨论] ' + m.text : m.text }));
      const result = await Reading.run({ ...context, task, query, selection: selected, config, history, signal: controller.signal, cache: state.cache, progress: message => { if (this.agentController === controller) this.agentMessage(message); } }, call);
      if (controller.signal.aborted || this.agentController !== controller || generation !== this.generation || source !== this.file.path) return;
      if (task === 'revise') {
        state.revision = { snapshot, before: draft.text, text: Agent.draftText(result.text), source, sourceHash };
        this.renderAgentRevision(); this.agentMessage('修订预览已生成，可编辑后应用；原手札尚未修改。');
      } else {
        const userText = (query || `${Reading.TASKS[task]}${context.question ? '：' + context.question : ''}`) + (task === 'review' && context.answer ? `\n\n当时的回答：${context.answer}` : '');
        this.agentChat().push({ id: randomUUID(), role: 'user', text: userText, sourceHash },
          { id: randomUUID(), role: 'assistant', ...result, provider, task, sourceHash });
        state.instruction = ''; this.agentInstruction.value = ''; state.selectedText = ''; state.picked.clear();
        this.renderAgentConversation(); this.agentMessage('可以继续追问，也可以只选择值得留下的内容。');
        await this.plugin.flush();
      }
      this.agentContextDetails.open = false;
    } catch (error) { if (this.agentController === controller) this.agentMessage(error.message); }
    finally {
      if (this.agentController === controller) {
        this.agentController = null; this.updateAgentUI();
        if (task !== 'revise') this.scrollAgentAnswer();
        const target = task === 'revise' ? this.agentRevisionBox : this.agentConversation;
        if (target && this.panel === 'agent') this.agentPanel.scrollTop += target.getBoundingClientRect().top - this.agentPanel.getBoundingClientRect().top - 12;
      }
    }
  },
  retainAgentSelection() {
    this.plugin.checkFile(this.file); const selected = this.chosenAgentText(); if (!selected || this.agentController) return;
    const d = this.draft(), before = JSON.parse(JSON.stringify(d));
    const cursor = Math.min(this.editor.selectionStart ?? d.text.length, d.text.length);
    const part = Agent.draftText(selected);
    d.text = d.text.slice(0, cursor) + (cursor ? '\n\n' : '') + part + (cursor < d.text.length ? '\n\n' : '') + d.text.slice(cursor);
    this.rememberAgentEdit(before, d); this.showDraft(); this.selectPanel('notes'); this.plugin.scheduleFlush();
    this.agentState.picked.clear(); this.agentState.selectedText = ''; this.renderAgentConversation(); this.updateAgentUI();
  },
  renderAgentRevision() {
    const box = this.agentRevisionBox; if (!box) return;
    box.empty(); const revision = this.agentState.revision; box.hidden = !revision; if (!revision) return;
    box.createEl('h4', { text: '手札修订预览' });
    box.createDiv({ cls: 'era-muted', text: '删除与新增会标出。下方可继续修改，应用后仍需手动保存。' });
    const diff = box.createDiv('era-agent-diff');
    const editor = box.createEl('textarea', { cls: 'era-agent-revision-editor', attr: { 'aria-label': '修订后的手札' } }); editor.value = revision.text;
    const paint = () => { diff.empty(); for (const change of Reading.diffLines(revision.before, revision.text)) diff.createEl(change.kind === 'removed' ? 'del' : change.kind === 'added' ? 'ins' : 'div', { text: change.text, attr: { 'aria-label': change.kind === 'removed' ? '删除' : change.kind === 'added' ? '新增' : '保留' } }); };
    paint(); editor.addEventListener('input', () => { revision.text = editor.value; paint(); });
    const actions = box.createDiv('era-agent-actions');
    this.button(actions, '应用到草稿', () => this.applyAgentRevision(), 'check');
    this.button(actions, '放弃这次修订', () => { this.agentState.revision = null; this.renderAgentRevision(); });
  },
  rememberAgentEdit(before, after) {
    (this.plugin.data.agentUndo ||= {})[this.file.path] = { before, afterText: after.text, afterSnapshot: JSON.stringify(after) };
  },
  applyAgentRevision() {
    const revision = this.agentState.revision; if (!revision || this.agentController) return;
    this.plugin.checkFile(this.file);
    if (revision.source !== this.file.path || revision.sourceHash !== this.sourceHash || this.stale) throw Error('文章已变化，请重新生成修订；预览仍保留。');
    const d = this.draft(); if (JSON.stringify(d) !== revision.snapshot) throw Error('手札已修改、切换或保存，请重新整理；原稿与预览均保留。');
    if (!revision.text.trim()) throw Error('修订正文为空，请先填写内容。');
    const before = JSON.parse(JSON.stringify(d)); d.text = revision.text;
    this.rememberAgentEdit(before, d); this.agentState.revision = null; this.renderAgentRevision(); this.showDraft(); this.selectPanel('notes'); this.updateAgentUI(); this.plugin.scheduleFlush();
  },
  trackAgentSave(snapshot) {
    const undo = this.plugin.data.agentUndo?.[this.file.path]; if (!undo || undo.afterSnapshot !== snapshot) return;
    const matches = (this.entries || []).filter(entry => entry.text === undo.afterText && entry.question === (undo.before.question || ''));
    if (matches.length === 1) undo.saved = { path: this.plugin.notePath(this.file.path), original: matches[0].original, id: matches[0].id };
    this.plugin.scheduleFlush();
  },
  async undoAgentEdit() {
    const undo = this.plugin.data.agentUndo?.[this.file.path]; if (!undo) return;
    await this.checkAgentSource();
    if (undo.saved) {
      await this.showSaved();
      const entry = this.entries.find(e => e.id === undo.saved.id && e.original === undo.saved.original);
      if (!entry) throw Error('已保存手札后来有改动，不能覆盖。原稿备份仍保留。');
      this.editSaved(entry, undo.saved.path);
      if (this.draft().text !== undo.afterText) throw Error('这条手札已有未保存修改，不能覆盖；原稿备份仍保留。');
    } else if (JSON.stringify(this.draft()) !== undo.afterSnapshot) throw Error('草稿后来有改动，不能直接撤回；原稿备份仍保留。');
    this.draft().text = undo.before.text;
    delete this.plugin.data.agentUndo[this.file.path];
    this.showDraft(); this.selectPanel('notes'); this.updateAgentUI(); this.plugin.scheduleFlush();
    this.status('已恢复修改前的文字到草稿；保存后更新正式手札。');
  }
};
