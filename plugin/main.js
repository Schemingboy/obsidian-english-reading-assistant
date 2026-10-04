const { Plugin, ItemView, MarkdownRenderer, Component, Notice, TFile, setIcon } = require('obsidian');
const { spawn } = require('child_process');
const path = require('path');
const { createHash } = require('crypto');
const { setImmediate } = require('timers');
const TYPE = 'english-reading-assistant';
const VERSION = 'spacy-en-sm-3.8.0-r1';
const hash = text => createHash('sha256').update(text).digest('hex');
const today = () => new Date().toLocaleDateString('sv-SE');
const roles = { main: '主句谓语', subordinate: '从句谓语', nonfinite: '非谓语动词' };
const SKIP = 'code,pre,script,style,math,.math,.internal-embed,.frontmatter,.metadata-container,button,svg';
// Browser timers are clamped while Obsidian is covered; Node's turn still yields to other work.
const yieldUI = () => new Promise(resolve => setImmediate(resolve));

function textNodes(el) {
  const out = [], walker = el.ownerDocument.createTreeWalker(el, 4);
  for (let node; (node = walker.nextNode());) if (!node.parentElement.closest(SKIP)) out.push(node);
  return out;
}
function valid(result, texts) {
  if (result?.version !== VERSION || result.blocks?.length !== texts.length) return false;
  return result.blocks.every((block, i) => ['groups', 'predicates'].every(key => {
    if (!Array.isArray(block[key])) return false;
    let end = 0;
    return block[key].every(s => {
      const ok = Number.isInteger(s.start) && Number.isInteger(s.end) && s.start >= end && s.end > s.start && s.end <= texts[i].length && texts[i].slice(s.start, s.end) === s.text && (key !== 'predicates' || roles[s.role]);
      end = s.end;
      return !!ok;
    });
  }));
}
function locate(text, quote, before = '', after = '') {
  if (!quote) return -1;
  const hits = [];
  for (let pos = text.indexOf(quote); pos >= 0; pos = text.indexOf(quote, pos + 1)) hits.push(pos);
  if (hits.length === 1) return hits[0];
  const contextual = hits.filter(i => (!before || text.slice(Math.max(0, i - before.length), i) === before) && (!after || text.slice(i + quote.length, i + quote.length + after.length) === after));
  return contextual.length === 1 ? contextual[0] : -1;
}
function decorate(el, block) {
  const points = [...new Set([0, ...block.groups.flatMap(s => [s.start, s.end]), ...block.predicates.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
  const segments = [];
  let g = 0, p = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    while (g < block.groups.length && block.groups[g].end <= start) g++;
    while (p < block.predicates.length && block.predicates[p].end <= start) p++;
    segments.push({ start, end, group: block.groups[g]?.start <= start ? g % 3 : -1, pred: block.predicates[p]?.start <= start ? block.predicates[p] : null });
  }
  let offset = 0, cursor = 0;
  for (const node of textNodes(el)) {
    const start = offset, end = start + node.data.length;
    offset = end;
    const fragment = el.ownerDocument.createDocumentFragment();
    let pos = start;
    while (pos < end) {
      while (cursor < segments.length && segments[cursor].end <= pos) cursor++;
      const segment = segments[cursor], stop = Math.min(end, segment?.end ?? end);
      const text = node.data.slice(pos - start, stop - start);
      if (!segment || (segment.group < 0 && !segment.pred)) { fragment.append(el.ownerDocument.createTextNode(text)); pos = stop; continue; }
      const mark = el.ownerDocument.createElement('span');
      mark.className = 'era-mark';
      mark.textContent = text;
      if (segment.group >= 0) mark.dataset.group = String(segment.group);
      const pred = segment.pred;
      if (pred) { mark.dataset.role = pred.role; mark.title = `${roles[pred.role]} · 动词链：${pred.chain}`; }
      fragment.append(mark); pos = stop;
    }
    node.replaceWith(fragment);
  }
}

class Reader extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.generation = 0; this.layers = { groups: true, verbs: true }; this.panel = 'notes'; }
  getViewType() { return TYPE; }
  getDisplayText() { return this.file ? `阅读 · ${this.file.basename}` : '英文阅读助手'; }
  getIcon() { return 'book-open-text'; }
  getState() { return { file: this.file?.path }; }
  async setState(state, result) {
    const file = this.app.vault.getAbstractFileByPath(state.file);
    if (file instanceof TFile) { this.file = file; await this.render(); }
    await super.setState(state, result);
  }
  async onOpen() { this.contentEl.addClass('era-view'); }
  async onClose() { this.generation++; this.child?.unload(); this.worker?.kill(); await this.plugin.flush(); }
  draft() { return this.plugin.data.drafts[this.file.path] ||= { text: '', quote: '', before: '', after: '', question: '' }; }
  parkedDrafts() { return (this.plugin.data.parkedDrafts ||= {})[this.file.path] ||= []; }
  switchDraft(next) {
    const current = this.draft(), parked = this.parkedDrafts();
    if (next !== current) {
      const index = parked.indexOf(next);
      if (index >= 0) parked.splice(index, 1);
      if (current.text.trim()) parked.push(current);
      this.plugin.data.drafts[this.file.path] = index >= 0 ? next : { text: '', quote: '', before: '', after: '', question: '', ...next };
    }
    this.showDraft(); this.selectPanel('notes'); this.editor.focus(); this.plugin.scheduleFlush();
  }
  showDraft() {
    const d = this.draft();
    this.editor.value = d.text;
    this.quoteEl.textContent = d.quote || '选中正文，再点「摘录选文」。';
    this.questionEl.textContent = d.question; this.questionEl.hidden = !d.question;
    this.clearQuoteButton.hidden = !d.quote; this.clearQuestionButton.hidden = !d.question;
    this.draftSelect.empty();
    const parked = this.parkedDrafts();
    this.draftSelect.createEl('option', { text: `暂存草稿（${parked.length}）`, value: '' });
    parked.forEach((item, i) => this.draftSelect.createEl('option', { text: `${i + 1}. ${(item.question || item.quote || item.text).slice(0, 70)}`, value: String(i) }));
    this.draftSelect.hidden = !parked.length;
  }
  status(text, state = 'ready') { if (this.statusEl) { this.statusEl.textContent = text; this.statusEl.dataset.state = state; } }
  button(parent, label, action, icon) {
    const button = parent.createEl('button', { cls: 'era-button', attr: { type: 'button', title: label, 'aria-label': label } });
    if (icon) setIcon(button.createSpan('era-button-icon'), icon);
    button.createSpan({ cls: 'era-button-label', text: label });
    button.addEventListener('click', async () => {
      if (button.disabled) return;
      try {
        const result = action();
        if (result?.then) { button.disabled = true; button.setAttribute('aria-busy', 'true'); await result; }
      } catch (e) { this.status(e.message, 'error'); new Notice(e.message); }
      finally { button.disabled = false; button.removeAttribute('aria-busy'); }
    });
    return button;
  }
  selectPanel(name) {
    this.panel = name;
    for (const key of ['notes', 'questions']) {
      this[`${key}Panel`].hidden = name !== key;
      this[`${key}Tab`].setAttribute('aria-selected', String(name === key));
      this[`${key}Tab`].tabIndex = name === key ? 0 : -1;
    }
    this.layout.classList.remove('era-focus'); this.focusButton.setAttribute('aria-pressed', 'false');
  }
  syncLayers() {
    for (const key of ['groups', 'verbs']) {
      this.article.classList.toggle(`era-${key}`, this.layers[key]);
      this[`${key}Button`].setAttribute('aria-pressed', String(this.layers[key]));
      this[`${key}Button`].disabled = !this.analysisReady;
    }
  }
  async render() {
    await this.plugin.readyFile(this.file);
    const raw = await this.app.vault.read(this.file);
    if (this.renderedPath === this.file.path && this.sourceHash === hash(raw) && this.article?.isConnected) {
      this.stale = false; this.article.classList.toggle('era-colors', !!this.analysisReady); this.status('已是最新内容'); return;
    }
    const generation = ++this.generation;
    this.worker?.kill(); this.worker = null; this.analysisTask = null; this.analysisReady = false;
    this.contentEl.empty(); this.child?.unload(); this.child = new Component(); this.child.load();
    if (generation !== this.generation) return;
    this.sourceHash = hash(raw); this.stale = false;
    this.renderedPath = this.file.path;
    const header = this.contentEl.createDiv('era-header');
    const title = header.createDiv('era-title');
    title.createSpan({ cls: 'era-eyebrow', text: '英文精读' });
    const displayTitle = this.app.metadataCache.getFileCache(this.file)?.frontmatter?.title || this.file.basename;
    title.createEl('h2', { text: String(displayTitle), attr: { title: String(displayTitle) } });
    const links = header.createDiv('era-header-actions');
    this.button(links, '原文', () => this.app.workspace.openLinkText(this.file.path, '', true), 'file-text');
    this.button(links, '刷新', () => this.render(), 'refresh-cw');
    const bar = this.contentEl.createDiv('era-toolbar');
    this.analyzeButton = this.button(bar, '分析文章', () => this.analyze(), 'scan-text'); this.analyzeButton.addClass('era-primary');
    const toggles = bar.createDiv({ cls: 'era-layers', attr: { role: 'group', 'aria-label': '阅读辅助显示' } });
    for (const [key, label, icon] of [['groups', '意群', 'align-left'], ['verbs', '谓语与非谓语', 'baseline']]) {
      this[`${key}Button`] = this.button(toggles, label, () => { this.layers[key] = !this.layers[key]; this.syncLayers(); }, icon);
    }
    this.focusButton = this.button(bar, '专注阅读', () => { const focus = this.layout.classList.toggle('era-focus'); this.focusButton.setAttribute('aria-pressed', String(focus)); }, 'panel-right-close');
    this.focusButton.setAttribute('aria-pressed', 'false');
    const legend = this.contentEl.createDiv('era-legend');
    const swatches = legend.createSpan('era-swatches'); for (let i = 0; i < 3; i++) swatches.createSpan({ attr: { 'data-group': String(i), 'aria-hidden': 'true' } });
    legend.createSpan({ text: '意群底色' });
    for (const [role, label] of Object.entries(roles)) legend.createSpan({ text: label, attr: { 'data-role': role } });
    this.statusEl = this.contentEl.createDiv({ cls: 'era-status', text: '选择「分析文章」开启阅读辅助。', attr: { role: 'status', 'aria-live': 'polite' } });
    this.layout = this.contentEl.createDiv('era-layout');
    this.article = this.layout.createDiv('era-article markdown-rendered');
    this.article.setAttribute('tabindex', '0');
    this.article.setAttribute('aria-label', '文章正文'); this.article.setAttribute('aria-busy', 'true');
    const loading = this.article.createDiv({ cls: 'era-loading', text: '正在打开文章…' });
    this.syncLayers();
    this.article.addEventListener('click', event => {
      const anchor = event.target.closest('a.internal-link');
      const href = anchor?.getAttribute('data-href');
      if (!href) return;
      event.preventDefault(); event.stopPropagation();
      const target = href.startsWith('#^') ? this.article.querySelector(`[data-block-id="${CSS.escape(href.slice(2))}"]`) : null;
      if (target) target.scrollIntoView({ block: 'start' });
      else this.app.workspace.openLinkText(href, this.file.path, event.ctrlKey || event.metaKey).catch(e => { this.status(e.message, 'error'); new Notice(e.message); });
    }, true);
    this.side = this.layout.createDiv('era-side');
    const tabs = this.side.createDiv({ cls: 'era-tabs', attr: { role: 'tablist', 'aria-label': '阅读笔记' } });
    for (const [key, label] of [['notes', '手札'], ['questions', '问题']]) {
      const tab = this[`${key}Tab`] = this.button(tabs, label, () => this.selectPanel(key));
      tab.setAttribute('role', 'tab'); tab.id = `era-${this.leaf.id}-${key}-tab`; tab.setAttribute('aria-controls', `era-${this.leaf.id}-${key}`);
      tab.addEventListener('keydown', e => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) { e.preventDefault(); const next = e.key === 'Home' ? 'notes' : e.key === 'End' ? 'questions' : key === 'notes' ? 'questions' : 'notes'; this.selectPanel(next); this[`${next}Tab`].focus(); } });
      this[`${key}Panel`] = this.side.createDiv({ cls: `era-panel era-${key}-panel`, attr: { role: 'tabpanel', id: `era-${this.leaf.id}-${key}`, 'aria-labelledby': tab.id } });
    }
    this.selectPanel(this.panel);
    const noteHeader = this.notesPanel.createDiv('era-panel-heading');
    noteHeader.createEl('h3', { text: '读到这里，记下一点' });
    const captureButton = this.button(noteHeader, '摘录选文', () => this.capture(), 'text-quote');
    captureButton.addEventListener('mousedown', event => event.preventDefault());
    this.quoteEl = this.notesPanel.createEl('blockquote', { cls: 'era-quote', text: this.draft().quote || '选中正文，再点「摘录选文」。' });
    this.questionEl = this.notesPanel.createDiv({ cls: 'era-question-label', text: this.draft().question }); this.questionEl.hidden = !this.draft().question;
    this.editor = this.notesPanel.createEl('textarea', { attr: { placeholder: '自己的理解、一个疑问，\n或这道题的答案…', 'aria-label': '手札或问题回答' } });
    this.editor.value = this.draft().text;
    this.editor.addEventListener('input', () => { this.draft().text = this.editor.value; this.plugin.scheduleFlush(); });
    const noteActions = this.notesPanel.createDiv('era-note-actions');
    this.button(noteActions, '保存手札', () => this.saveNote(), 'check').addClass('era-primary');
    this.button(noteActions, '打开笔记', () => this.openNotes(), 'external-link');
    const draftActions = this.notesPanel.createDiv('era-draft-actions');
    this.button(draftActions, '新手札', () => this.switchDraft({}), 'plus');
    this.clearQuoteButton = this.button(draftActions, '取消摘录', () => { Object.assign(this.draft(), { quote: '', before: '', after: '' }); this.showDraft(); this.plugin.scheduleFlush(); });
    this.clearQuestionButton = this.button(draftActions, '取消关联问题', () => { this.draft().question = ''; this.showDraft(); this.plugin.scheduleFlush(); });
    this.draftSelect = this.notesPanel.createEl('select', { cls: 'era-draft-select', attr: { 'aria-label': '恢复暂存草稿' } });
    this.draftSelect.addEventListener('change', () => { if (this.draftSelect.value !== '') this.switchDraft(this.parkedDrafts()[Number(this.draftSelect.value)]); });
    this.showDraft();
    this.saved = this.notesPanel.createDiv('era-saved');
    this.questionsPanel.createDiv({ cls: 'era-muted', text: '正在整理本文问题…' });
    await yieldUI();
    const body = raw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '');
    const content = this.article.ownerDocument.createElement('div'); content.className = 'era-content';
    await MarkdownRenderer.render(this.app, body, content, this.file.path, this.child);
    if (generation !== this.generation) return;
    loading.replaceWith(content); this.article.removeAttribute('aria-busy');
    const blocks = this.app.metadataCache.getFileCache(this.file)?.blocks || {};
    for (const heading of this.article.querySelectorAll('[data-heading]')) {
      const id = heading.dataset.heading.match(/\^([\w-]+)\s*$/)?.[1];
      if (id && blocks[id]) heading.dataset.blockId = id;
    }
    await this.showSaved();
    await this.showQuestions();
  }
  analyze() {
    if (this.analysisTask) return this.analysisTask;
    const task = this.analyzeCurrent(); this.analysisTask = task;
    task.finally(() => { if (this.analysisTask === task) this.analysisTask = null; }).catch(() => {});
    return task;
  }
  async analyzeCurrent() {
    if (this.stale) throw Error('原文已变化，请先重新读取。');
    if (this.analysisReady) { this.article.classList.add('era-colors'); this.status('分析已就绪 · 已读取缓存，可切换意群和谓语显示。'); return; }
    if (this.article.hasAttribute('aria-busy')) throw Error('文章还在打开，请稍后再分析。');
    const generation = this.generation;
    const label = this.analyzeButton.querySelector('.era-button-label'); label.textContent = '正在分析…';
    this.status('正在准备阅读辅助…', 'busy');
    await yieldUI();
    if (generation !== this.generation) return;
    try {
    // Only an interrupted first render can leave partial decorations.
    if (this.article.querySelector('.era-mark')) {
      for (const mark of this.article.querySelectorAll('.era-mark')) mark.replaceWith(mark.ownerDocument.createTextNode(mark.textContent));
      this.article.normalize();
    }
    const elements = [...this.article.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6,td,th')].filter(el => !el.closest(SKIP) && !el.querySelector('p,li,table,pre') && /[a-zA-Z]/.test(el.textContent));
    const texts = elements.map(el => textNodes(el).map(n => n.data).join(''));
    const key = hash(VERSION + JSON.stringify(texts));
    const cache = `${this.plugin.manifest.dir}/cache/${key}.json`;
    let result;
    if (await this.app.vault.adapter.exists(cache)) {
      try { result = JSON.parse(await this.app.vault.adapter.read(cache)); } catch { /* Corrupt cache is rebuilt. */ }
    }
    let cached = valid(result, texts);
    if (!cached) {
      this.status(`正在本地分析 ${texts.length} 段，文章仍可阅读…`, 'busy');
      try { result = await this.plugin.runAnalyzer(texts, child => this.worker = child); }
      finally { if (generation === this.generation) this.worker = null; }
      if (!valid(result, texts)) throw Error('分析区间与原文不一致，已拒绝标色。');
      await this.plugin.mkdir(`${this.plugin.manifest.dir}/cache`);
      await this.app.vault.adapter.write(cache, JSON.stringify(result));
    }
    if (generation !== this.generation || this.stale) return;
    this.status('正在显示阅读辅助…', 'busy');
    let sliceStart = performance.now();
    for (let i = 0; i < elements.length; i++) {
      if (generation !== this.generation || this.stale) return;
      decorate(elements[i], result.blocks[i]);
      if (performance.now() - sliceStart > 8) { await yieldUI(); sliceStart = performance.now(); }
    }
    this.analysisReady = true; this.syncLayers();
    this.article.classList.add('era-colors');
    this.status(`${cached ? '已读取缓存' : '本地分析完成'} · ${texts.length} 段 · 悬停动词可查看动词链。`);
    } finally { if (generation === this.generation) { label.textContent = this.analysisReady ? '分析完成' : '分析文章'; this.analyzeButton.classList.toggle('era-complete', !!this.analysisReady); } }
  }
  capture() {
    const selection = this.article.ownerDocument.getSelection();
    if (!selection?.rangeCount || !this.article.contains(selection.anchorNode) || !this.article.contains(selection.focusNode)) throw Error('请先在左侧文章中选中文字。');
    const range = selection.getRangeAt(0), quote = range.toString();
    if (!quote.trim()) throw Error('选文为空。');
    const prefix = range.cloneRange(); prefix.selectNodeContents(this.article); prefix.setEnd(range.startContainer, range.startOffset);
    const pos = prefix.toString().length, text = this.article.textContent;
    const d = this.draft(), excerpt = { quote, before: text.slice(Math.max(0, pos - 60), pos), after: text.slice(pos + quote.length, pos + quote.length + 60) };
    // A question's quote is evidence for its answer. Standalone excerpts get separate drafts.
    if (!d.question && d.quote && ['quote', 'before', 'after'].some(key => d[key] !== excerpt[key])) {
      this.switchDraft(this.parkedDrafts().find(item => !item.question && item.quote === quote && item.before === excerpt.before && item.after === excerpt.after) || excerpt);
    } else { Object.assign(d, excerpt); this.switchDraft(d); }
  }
  async saveNote() {
    if (this.saving) return;
    const original = this.draft(), d = { ...original };
    if (!d.text.trim()) throw Error('先写下手札或回答再保存。');
    this.saving = true;
    try {
      const note = await this.plugin.appendNote(this.file, d, this.sourceHash);
      if (['text', 'quote', 'before', 'after', 'question'].every(key => original[key] === d[key])) {
        if (this.draft() === original) Object.assign(original, { text: '', quote: '', before: '', after: '', question: '' });
        else { const index = this.parkedDrafts().indexOf(original); if (index >= 0) this.parkedDrafts().splice(index, 1); }
        this.showDraft();
      }
      await this.plugin.flush(); await this.showSaved(); this.status(`已保存：${note.path}`);
      for (const card of this.side.querySelectorAll('.era-question')) if (card.querySelector('p').textContent === d.question) { card.querySelector('small').textContent = '已回答'; card.classList.add('era-answered'); }
    } finally { this.saving = false; }
  }
  async openNotes() {
    const file = this.app.vault.getAbstractFileByPath(this.plugin.notePath(this.file.path));
    if (!file) throw Error('尚未保存手札。');
    return this.app.workspace.getLeaf(true).openFile(file);
  }
  async showSaved() {
    this.saved.empty(); this.entries = [];
    const note = this.app.vault.getAbstractFileByPath(this.plugin.notePath(this.file.path));
    if (!note) return;
    await this.plugin.readyFile(note);
    const raw = await this.app.vault.read(note);
    for (const match of raw.matchAll(/<!-- era:([A-Za-z0-9+/=]+) -->/g)) {
      try {
        const item = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
        if (item && typeof item.quote === 'string') this.entries.push(item);
      } catch { /* Leave user-edited malformed metadata untouched. */ }
    }
    const quotes = this.entries.filter(item => item.quote);
    if (quotes.length) {
      const details = this.saved.createEl('details'); details.createEl('summary', { text: `已保存摘录 · ${quotes.length}` });
      for (const item of quotes) this.button(details, item.quote.slice(0, 60) + (item.quote.length > 60 ? '…' : ''), () => this.jumpQuote(item), 'corner-up-left');
    }
  }
  jumpQuote(item) {
    if (this.stale) throw Error('原文已变化，请先重新读取，再核对摘录。');
    const pos = locate(this.article.textContent, item.quote, item.before, item.after);
    if (pos < 0) throw Error('定位待确认：引文已变化或有重复，请打开手札核对。');
    const walker = this.article.ownerDocument.createTreeWalker(this.article, 4);
    let offset = 0;
    for (let node; (node = walker.nextNode());) {
      if (offset + node.data.length > pos) { node.parentElement.scrollIntoView({ block: 'center' }); if (!matchMedia('(prefers-reduced-motion: reduce)').matches) node.parentElement.animate([{ outline: '2px solid var(--interactive-accent)' }, { outline: 'none' }], 1800); return; }
      offset += node.data.length;
    }
  }
  async showQuestions() {
    this.questionsPanel.empty();
    const heading = this.questionsPanel.createDiv('era-panel-heading'); heading.createEl('h3', { text: '带着问题读' });
    const answered = new Set((this.entries || []).map(item => item.question).filter(Boolean));
    let questions = this.plugin.questions.filter(q => q.file === this.file.path);
    const headings = [...this.article.querySelectorAll('h1,h2,h3')].filter(e => !e.closest('.internal-embed'));
    const original = questions.length > 0;
    if (!original) {
      const found = [...this.article.querySelectorAll('p,li,h1,h2,h3')].filter(el => !el.closest(SKIP) && !el.querySelector('p,li') && /\?\s*$/.test(el.textContent.trim()) && el.textContent.length < 500).slice(0, 12);
      questions = found.map((el, i) => ({ id: `text-${i}`, text: el.textContent.trim(), el }));
      if (!questions.length) questions = [
        { text: `What is the central claim or idea of “${headings[0]?.textContent || this.file.basename}”?`, el: headings[0] },
        { text: 'Which evidence or examples support it, and how?', el: headings[1] || headings[0] },
        { text: 'What remains unclear, and how does this connect to what you already know?', el: headings.at(-1) }
      ];
      this.questionsPanel.createEl('p', { cls: 'era-muted', text: found.length ? '从正文提取的问题。' : '规则模板导读题，帮助梳理思路；不是 AI 深度提问。' });
    } else this.questionsPanel.createEl('p', { cls: 'era-muted', text: '原书问题 · Focus Questions' });
    this.questionsTab.querySelector('.era-button-label').textContent = `问题 ${questions.length}`;
    for (const [index, q] of questions.entries()) {
      const card = this.questionsPanel.createDiv({ cls: `era-question${answered.has(q.text) ? ' era-answered' : ''}` });
      const meta = card.createDiv('era-question-meta'); meta.createSpan({ cls: 'era-question-number', text: String(index + 1).padStart(2, '0') });
      meta.createEl('small', { text: answered.has(q.text) ? '已回答' : '未答' });
      card.createEl('p', { text: q.text });
      const actions = card.createDiv('era-question-actions');
      this.button(actions, '定位正文', () => {
        if (this.stale) throw Error('原文已变化，请先重新读取。');
        if (q.el) q.el.scrollIntoView({ block: 'start' });
        else {
          const target = this.article.querySelector(`[data-block-id="${CSS.escape(q.target)}"]`);
          if (target) target.scrollIntoView({ block: 'start' });
          else return this.app.workspace.openLinkText(`${this.file.path}#^${q.target}`, this.file.path, true);
        }
      }, 'locate');
      this.button(actions, '写回答', () => {
        const d = this.draft();
        const next = d.question === q.text ? d : this.parkedDrafts().find(item => item.question === q.text);
        if (next) this.switchDraft(next);
        else if (!d.question && !d.text.trim()) { d.question = q.text; this.switchDraft(d); }
        else this.switchDraft({ question: q.text });
      }, 'pen-line');
    }
  }
}

class ReadingPlugin extends Plugin {
  async onload() {
    this.data = { drafts: {}, notes: {} }; this.pending = Promise.resolve();
    const dataPath = `${this.manifest.dir}/data.json`;
    if (await this.app.vault.adapter.exists(dataPath)) this.data = { ...this.data, ...JSON.parse(await this.app.vault.adapter.read(dataPath)) };
    const questionPath = `${this.manifest.dir}/focus-questions.json`;
    this.questions = await this.app.vault.adapter.exists(questionPath) ? JSON.parse(await this.app.vault.adapter.read(questionPath)) : [];
    if (!Array.isArray(this.questions)) throw Error('focus-questions.json 应为问题数组。');
    const runtimePath = `${this.manifest.dir}/runtime.json`;
    const runtime = await this.app.vault.adapter.exists(runtimePath) ? JSON.parse(await this.app.vault.adapter.read(runtimePath)) : {};
    this.pythonPath = runtime.pythonPath || path.join(this.app.vault.adapter.getBasePath(), this.manifest.dir, '.runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    this.registerView(TYPE, leaf => new Reader(leaf, this));
    this.addCommand({ id: 'open-current', name: '为当前文章打开阅读助手', callback: () => this.open().catch(e => new Notice(e.message)) });
    this.addRibbonIcon('book-open-text', '为当前文章打开阅读助手', () => this.open().catch(e => new Notice(e.message)));
    this.registerEvent(this.app.vault.on('modify', file => {
      for (const leaf of this.app.workspace.getLeavesOfType(TYPE)) if (leaf.view.file?.path === file.path) {
        leaf.view.stale = true; leaf.view.article?.classList.remove('era-colors'); leaf.view.status('原文有更新 · 点击「刷新」后继续。');
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, old) => {
      if (this.data.drafts[old]) { this.data.drafts[file.path] = this.data.drafts[old]; delete this.data.drafts[old]; }
      if (this.data.parkedDrafts?.[old]) { this.data.parkedDrafts[file.path] = this.data.parkedDrafts[old]; delete this.data.parkedDrafts[old]; }
      if (this.data.notes[old]) { this.data.notes[file.path] = this.data.notes[old]; delete this.data.notes[old]; }
      for (const q of this.questions) if (q.file === old) q.file = file.path;
      this.flush().catch(e => new Notice(e.message));
    }));
  }
  checkFile(file) {
    if (!(file instanceof TFile) || file.extension !== 'md') throw Error('请先打开一篇 Markdown 文章。');
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) throw Error('文件元数据尚未就绪，请稍后再试。');
    if (cache.frontmatter?.sensitive === true || /^(true|yes)$/i.test(String(cache.frontmatter?.sensitive || '')) || ['skip', 'meta'].includes(cache.frontmatter?.scope)) throw Error('此文件标记为敏感或限制读取，阅读助手不会读取正文。');
  }
  async readyFile(file) {
    // Newly saved notes briefly lose their metadata cache while Obsidian reindexes.
    if (file instanceof TFile) for (let i = 0; i < 20 && !this.app.metadataCache.getFileCache(file); i++) await new Promise(resolve => setTimeout(resolve, 50));
    this.checkFile(file);
  }
  async open(file = this.app.workspace.getActiveFile()) {
    await this.readyFile(file);
    let leaf = this.app.workspace.getLeavesOfType(TYPE).find(l => l.view.file?.path === file.path);
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: TYPE, state: { file: file.path }, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view;
  }
  async mkdir(dir) { if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir); }
  scheduleFlush() { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flush().catch(e => new Notice(`草稿保存失败：${e.message}`)), 300); }
  flush() {
    clearTimeout(this.saveTimer);
    const content = JSON.stringify(this.data, null, 2);
    this.pending = this.pending.catch(() => {}).then(() => this.app.vault.adapter.write(`${this.manifest.dir}/data.json`, content));
    return this.pending;
  }
  notePath(source) { return this.data.notes[source] || `Notes/reading-notes/reading-${hash(source).slice(0, 16)}.md`; }
  async appendNote(source, draft, sourceHash) {
    await this.readyFile(source);
    const target = this.notePath(source.path), date = today();
    await this.mkdir('Notes/reading-notes');
    const link = this.app.fileManager.generateMarkdownLink(source, target);
    const item = { quote: draft.quote, before: draft.before, after: draft.after, question: draft.question, sourceHash };
    const marker = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    const entry = `\n## ${new Date().toLocaleString('zh-CN')}\n\n来源：${link}\n\n${draft.question ? `问题：${draft.question}\n\n` : ''}${draft.quote ? draft.quote.split('\n').map(line => `> ${line}`).join('\n') + '\n\n' : ''}${draft.text}\n\n<!-- era:${marker} -->\n`;
    let file = this.app.vault.getAbstractFileByPath(target);
    if (file) {
      await this.readyFile(file);
      await this.app.vault.process(file, raw => raw.replace(/^modified:.*$/m, `modified: ${date}`) + entry);
    } else {
      const title = `${source.basename} 阅读手札`;
      file = await this.app.vault.create(target, `---\ntitle: ${JSON.stringify(title)}\ncreated: ${date}\nmodified: ${date}\ntags: [english-reading]\ntype: note\n---\n\n# ${title}\n${entry}`);
    }
    this.data.notes[source.path] = target; return file;
  }
  runAnalyzer(texts, onChild = () => {}) {
    const base = this.app.vault.adapter.getBasePath();
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonPath, [path.join(base, this.manifest.dir, 'analyzer.py')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
      onChild(child); let output = '', errors = '';
      const timer = setTimeout(() => { child.kill(); reject(Error('本地分析超时，原文和手札仍可使用。')); }, 120000);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', data => { output += data; if (output.length > 50_000_000) child.kill(); });
      child.stderr.on('data', data => errors = (errors + data).slice(-3000));
      child.on('error', error => { clearTimeout(timer); reject(Error(`本地分析器不可用：${error.message}`)); });
      child.stdin.on('error', () => {});
      child.on('close', code => { clearTimeout(timer); if (code !== 0) return reject(Error(`本地分析失败：${errors || code}`)); try { resolve(JSON.parse(output)); } catch { reject(Error('分析器返回了无效数据。')); } });
      child.stdin.end(JSON.stringify({ texts }), 'utf8');
    });
  }
  onunload() { this.app.workspace.detachLeavesOfType(TYPE); this.flush().catch(e => console.error('阅读助手草稿保存失败', e)); }
}
module.exports = ReadingPlugin;
module.exports.checks = { valid, locate, hash };
