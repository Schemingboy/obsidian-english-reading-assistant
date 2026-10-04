const { Plugin, ItemView, MarkdownRenderer, Component, Notice, TFile, Scope, Keymap, setIcon } = require('obsidian');
const { spawn } = require('child_process');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { setImmediate } = require('timers');
const TYPE = 'english-reading-assistant';
const VERSION = 'spacy-en-sm-3.8.0-r4';
const hash = text => createHash('sha256').update(text).digest('hex');
const today = () => new Date().toLocaleDateString('sv-SE');
const roles = { main: '主句谓语', subordinate: '从句谓语', nonfinite: '非谓语动词' };
const SKIP = 'code,pre,script,style,math,.math,.internal-embed,.frontmatter,.metadata-container,button,svg';
// Browser timers are clamped while Obsidian is covered; Node's turn still yields to other work.
const yieldUI = () => new Promise(resolve => setImmediate(resolve));
const excerpts = draft => Array.isArray(draft.excerpts) ? draft.excerpts : draft.quote ? [{ quote: draft.quote, before: draft.before || '', after: draft.after || '' }] : [];
function setExcerpts(draft, items) {
  draft.excerpts = items;
  Object.assign(draft, items[0] || { quote: '', before: '', after: '' });
}
function separateHeadings(content) {
  // Display-only: preserve text nodes and offsets used for source mapping.
  for (const p of content.querySelectorAll('p')) {
    const first = [...p.childNodes].find(n => n.textContent.trim());
    if (first?.nodeType === 1 && first.tagName === 'STRONG' && first.textContent.trim().length < 160 && /[.!?:]$/.test(first.textContent.trim()) && first.nextSibling?.textContent.trim()) first.classList.add('era-inline-heading');
  }
}

function textNodes(el) {
  const out = [], walker = el.ownerDocument.createTreeWalker(el, 4);
  for (let node; (node = walker.nextNode());) if (!node.parentElement.closest(SKIP)) out.push(node);
  return out;
}
function valid(result, texts) {
  if (result?.version !== VERSION || result.blocks?.length !== texts.length) return false;
  return result.blocks.every((block, i) => ['groups', 'predicates', 'sentences'].every(key => {
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
function vocabTarget(text) {
  if (!/^[a-z]+(?:[-'][a-z]+)*(?: [a-z]+(?:[-'][a-z]+)*){0,2}$/i.test(text) || text.length > 80) throw Error('请选择完整的英文单词或最多三个词的短语。');
  return text.toLowerCase();
}
function linkCandidates(raw, quote, cache) {
  const frontmatter = raw.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/)?.[0].length || 0;
  const excluded = [...(cache.links || []), ...(cache.embeds || []), ...(cache.sections || []).filter(s => ['code', 'yaml', 'html'].includes(s.type))].map(s => [s.position.start.offset, s.position.end.offset]);
  const hits = [];
  for (let start = raw.indexOf(quote, frontmatter); start >= 0; start = raw.indexOf(quote, start + quote.length)) {
    const end = start + quote.length;
    if (/[a-z'\\-]/i.test(raw[start - 1] || '') || /[a-z'-]/i.test(raw[end] || '') || excluded.some(([a, b]) => start < b && end > a)) continue;
    hits.push({ start, end });
  }
  return hits;
}
function applyLinkPatch(raw, expectedHash, start, before, after) {
  if (hash(raw) !== expectedHash || raw.slice(start, start + before.length) !== before) throw Error('原文已变化，本次未写入。请刷新后重新选择。');
  return raw.slice(0, start) + after + raw.slice(start + before.length);
}
function quoteMarkdown(items, eol = '\n') {
  return items.map(item => item.quote.split(/\r?\n/).map(line => `> ${line}`).join(eol)).join(eol + eol);
}
function notePrefix(label, link, question, quotes, eol = '\n') {
  const quoted = quoteMarkdown(quotes, eol);
  return `## ${label}${eol}${eol}来源：${link}${eol}${eol}${question ? `问题：${question}${eol}${eol}` : ''}${quoted ? quoted + eol + eol : ''}`;
}
function noteEntries(raw) {
  const entries = []; let previousEnd = 0;
  for (const match of raw.matchAll(/<!-- era:([A-Za-z0-9+/=]+) -->/g)) {
    try {
      const meta = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
      if (!meta || (typeof meta.quote !== 'string' && !Array.isArray(meta.excerpts))) continue;
      const section = raw.slice(previousEnd, match.index), heading = /^## ([^\r\n]+)\r?\n\r?\n来源：([^\r\n]+)\r?\n\r?\n/m.exec(section);
      if (!heading) continue;
      const start = previousEnd + heading.index, end = match.index + match[0].length;
      const markdown = raw.slice(start, match.index), eol = heading[0].includes('\r\n') ? '\r\n' : '\n';
      const prefix = notePrefix(heading[1], heading[2], meta.question || '', excerpts(meta), eol);
      const editable = markdown.startsWith(prefix) && markdown.endsWith(eol + eol);
      entries.push({ ...meta, meta, start, end, original: raw.slice(start, end), label: heading[1], link: heading[2], eol, markdown,
        line: raw.slice(0, start).split('\n').length - 1, editable, text: editable ? markdown.slice(prefix.length, -2 * eol.length) : '' });
    } catch { /* Malformed or externally restructured notes are never overwritten. */ }
    finally { previousEnd = match.index + match[0].length; }
  }
  return entries;
}
function updatedEntry(edit, draft, sourceHash) {
  const quotes = excerpts(draft), meta = { ...edit.meta, id: edit.meta?.id || randomUUID(), ...quotes[0],
    quote: quotes[0]?.quote || '', before: quotes[0]?.before || '', after: quotes[0]?.after || '', excerpts: quotes, question: draft.question || '', sourceHash };
  const eol = edit.eol || '\n';
  const marker = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
  return notePrefix(edit.label, edit.link, meta.question, quotes, eol) + draft.text + eol + eol + `<!-- era:${marker} -->`;
}
function replaceEntry(raw, edit, next) {
  const start = raw.indexOf(edit.original);
  if (start < 0 || raw.indexOf(edit.original, start + 1) >= 0) throw Error('这条手札已在别处修改，未覆盖。当前修改仍保留，请核对后再保存。');
  // Patch only the unchanged target entry; edits to other entries remain intact.
  return raw.slice(0, start) + next + raw.slice(start + edit.original.length);
}
function decorate(el, block, blockId) {
  const starts = block.groups.map(s => s.start + s.text.search(/\S/));
  const ends = block.groups.map(s => s.start + s.text.trimEnd().length);
  const points = [...new Set([0, ...block.groups.flatMap(s => [s.start, s.end]), ...starts, ...ends, ...block.predicates.flatMap(s => [s.start, s.end]), ...block.sentences.flatMap(s => [s.start, s.end])])].sort((a, b) => a - b);
  const segments = [];
  let g = 0, p = 0, sentence = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    while (g < block.groups.length && block.groups[g].end <= start) g++;
    while (p < block.predicates.length && block.predicates[p].end <= start) p++;
    while (sentence < block.sentences.length - 1 && block.sentences[sentence].end <= start) sentence++;
    segments.push({ start, end, sentence: `${blockId}-${sentence}`, group: starts[g] <= start && start < ends[g] ? g % 2 : -1, boundary: g > 0 ? starts[g] : -1, pred: block.predicates[p]?.start <= start ? block.predicates[p] : null });
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
      mark.dataset.sentence = segment.sentence;
      if (segment.group >= 0) mark.dataset.group = String(segment.group);
      if (segment.boundary >= pos && segment.boundary < stop) mark.dataset.groupStart = 'true';
      const pred = segment.pred;
      if (pred) { mark.dataset.role = pred.role; mark.title = `${roles[pred.role]} · 动词链：${pred.chain}`; }
      fragment.append(mark); pos = stop;
    }
    node.replaceWith(fragment);
  }
}

class Reader extends ItemView {
  constructor(leaf, plugin) {
    super(leaf); this.plugin = plugin; this.generation = 0; this.layers = { groups: true, verbs: true }; this.grammarMode = 'backbone'; this.linkHistory = []; this.panel = 'notes';
    this.scope = new Scope(this.app.scope);
    this.scope.register(['Mod'], 'f', () => { this.openSearch(); return false; });
  }
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
  async onClose() { this.generation++; if (this.article) this.clearSearchHighlight(); this.child?.unload(); this.worker?.kill(); await this.plugin.flush(); }
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
    this.editingLabel.textContent = d.edit ? `正在编辑已保存手札 · ${d.edit.label}` : '';
    this.editingLabel.hidden = !d.edit; this.exitEditingButton.hidden = !d.edit;
    this.saveNoteButton.querySelector('.era-button-label').textContent = d.edit ? '更新这条手札' : '保存手札';
    this.quoteEl.empty();
    const items = excerpts(d);
    if (!items.length) this.quoteEl.textContent = '选中正文，再点「摘录选文」。可连续添加多段。';
    items.forEach((item, i) => {
      const row = this.quoteEl.createDiv('era-excerpt');
      row.createEl('blockquote', { text: item.quote });
      this.button(row, `取消第 ${i + 1} 条摘录`, () => { setExcerpts(d, excerpts(d).filter((_, index) => index !== i)); this.showDraft(); this.plugin.scheduleFlush(); }, 'x').addClass('era-remove-excerpt');
    });
    this.questionEl.textContent = d.question; this.questionEl.hidden = !d.question;
    this.clearQuoteButton.hidden = !items.length; this.clearQuestionButton.hidden = !d.question;
    if (this.preview) { this.preview.hidden = true; this.editor.hidden = false; this.previewButton?.setAttribute('aria-pressed', 'false'); }
    this.draftSelect.empty();
    const parked = this.parkedDrafts();
    this.draftSelect.createEl('option', { text: `暂存草稿（${parked.length}）`, value: '' });
    parked.forEach((item, i) => this.draftSelect.createEl('option', { text: `${i + 1}. ${item.edit ? '修改中 · ' : ''}${(item.question || item.quote || item.text).slice(0, 70)}`, value: String(i) }));
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
      finally { button.disabled = button === this.undoLinkButton && !this.linkHistory.length; button.removeAttribute('aria-busy'); }
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
    this.article.classList.toggle('era-backbone', this.grammarMode === 'backbone');
    if (this.legend) this.legend.classList.toggle('era-backbone', this.grammarMode === 'backbone' && !this.article.querySelector('[data-detail]'));
    if (this.grammarSelect) this.grammarSelect.disabled = !this.analysisReady || !this.layers.verbs;
    if (this.sentenceButton) this.sentenceButton.disabled = !this.analysisReady;
  }
  async render() {
    if (this.linkWriting) throw Error('正在保存标词，请稍后刷新。');
    await this.plugin.readyFile(this.file);
    const raw = await this.app.vault.read(this.file);
    if (this.renderedPath === this.file.path && this.sourceHash === hash(raw) && this.article?.isConnected) {
      this.stale = false; this.article.classList.toggle('era-colors', !!this.analysisReady); this.status('已是最新内容'); return;
    }
    const generation = ++this.generation;
    this.worker?.kill(); this.worker = null; this.analysisTask = null; this.analysisReady = false;
    if (this.article) this.clearSearchHighlight();
    this.searchHighlightStyle = null;
    this.contentEl.empty(); this.contentEl.classList.remove('era-reading-started'); this.child?.unload(); this.child = new Component(); this.child.load();
    this.lastWordRange = null; this.bracket = null;
    if (generation !== this.generation) return;
    this.sourceHash = hash(raw); this.sourceRaw = raw; this.stale = false; this.linkHistory = [];
    this.renderedPath = this.file.path;
    const header = this.contentEl.createDiv('era-header');
    const title = header.createDiv('era-title');
    title.createSpan({ cls: 'era-eyebrow', text: '英文精读' });
    const metadata = this.app.metadataCache.getFileCache(this.file);
    const displayTitle = metadata?.frontmatter?.title || metadata?.headings?.find(h => h.level === 1)?.heading || this.file.basename;
    title.createEl('h2', { text: String(displayTitle), attr: { title: String(displayTitle) } });
    const links = header.createDiv('era-header-actions');
    this.button(links, '原文', () => this.app.workspace.openLinkText(this.file.path, '', true), 'file-text');
    this.button(links, '刷新', () => this.render(), 'refresh-cw');
    this.button(links, '搜索正文', () => this.openSearch(), 'search');
    const bar = this.contentEl.createDiv('era-toolbar');
    this.analyzeButton = this.button(bar, '分析文章', () => this.analyze(), 'scan-text'); this.analyzeButton.addClass('era-primary');
    const toggles = bar.createDiv({ cls: 'era-layers', attr: { role: 'group', 'aria-label': '阅读辅助显示' } });
    for (const [key, label, icon] of [['groups', '意群', 'align-left'], ['verbs', '谓语与非谓语', 'baseline']]) {
      this[`${key}Button`] = this.button(toggles, label, () => { this.layers[key] = !this.layers[key]; this.syncLayers(); }, icon);
    }
    this.grammarSelect = toggles.createEl('select', { cls: 'era-grammar-select', attr: { 'aria-label': '语法提示层次' } });
    for (const [value, text] of [['backbone', '阅读主干'], ['full', '完整分析']]) this.grammarSelect.createEl('option', { value, text });
    this.grammarSelect.value = this.grammarMode;
    this.grammarSelect.addEventListener('change', () => { this.grammarMode = this.grammarSelect.value; this.syncLayers(); });
    this.sentenceButton = this.button(bar, '分析当前句', () => this.detailSentence(), 'text-cursor-input');
    this.sentenceButton.addEventListener('mousedown', e => e.preventDefault());
    this.sentenceButton.addEventListener('keydown', e => { if (e.key === 'Escape') this.clearSentence(); });
    this.focusButton = this.button(bar, '专注阅读', () => { const focus = this.layout.classList.toggle('era-focus'); this.focusButton.setAttribute('aria-pressed', String(focus)); }, 'panel-right-close');
    this.focusButton.setAttribute('aria-pressed', 'false');
    const legend = this.legend = this.contentEl.createDiv('era-legend');
    const swatches = legend.createSpan('era-swatches'); for (let i = 0; i < 2; i++) swatches.createSpan({ attr: { 'data-group': String(i), 'aria-hidden': 'true' } });
    legend.createSpan({ text: '意群分段' });
    for (const [role, label] of Object.entries(roles)) legend.createSpan({ text: label, attr: { 'data-role': role } });
    this.goal = this.contentEl.createEl('details', { cls: 'era-goal' });
    this.goalSummary = this.goal.createEl('summary');
    const goalActions = this.goal.createDiv('era-goal-actions');
    this.goalInput = goalActions.createEl('input', { attr: { type: 'text', maxlength: '500', placeholder: '这篇文章，我想弄懂什么？', 'aria-label': '当前阅读问题' } });
    this.button(goalActions, '设为目标', () => this.setGoal(this.goalInput.value));
    this.button(goalActions, '写回答', () => { const q = this.readingGoal(); if (!q) throw Error('先写下或从问题中选择一个目标。'); this.answerQuestion(q); });
    this.button(goalActions, '清除', () => this.setGoal(''));
    this.goalInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.setGoal(this.goalInput.value); } });
    this.showGoal();
    this.statusEl = this.contentEl.createDiv({ cls: 'era-status', text: '选择「分析文章」开启阅读辅助。', attr: { role: 'status', 'aria-live': 'polite' } });
    const wordBar = bar.createDiv('era-word-actions');
    this.linkButton = this.button(wordBar, '标为双链', () => this.linkSelection(), 'link');
    this.linkButton.addEventListener('mousedown', e => e.preventDefault());
    this.undoLinkButton = this.button(wordBar, '撤销标词', () => this.undoLink(), 'undo-2'); this.undoLinkButton.disabled = true;
    this.searchBar = this.contentEl.createDiv('era-search'); this.searchBar.hidden = true;
    const searchBox = this.searchBar.createDiv('era-search-box');
    setIcon(searchBox.createSpan({ cls: 'era-search-icon', attr: { 'aria-hidden': 'true' } }), 'search');
    this.searchInput = searchBox.createEl('input', { attr: { type: 'text', placeholder: '在正文中查找…', 'aria-label': '搜索正文', autocomplete: 'off', spellcheck: 'false' } });
    this.searchCount = searchBox.createSpan({ cls: 'era-search-count', attr: { role: 'status', 'aria-live': 'polite' } });
    this.findPrevious = this.button(searchBox, '上一处（Shift+Enter）', () => this.findText(-1), 'chevron-up');
    this.findNext = this.button(searchBox, '下一处（Enter）', () => this.findText(1), 'chevron-down');
    this.findPrevious.disabled = this.findNext.disabled = true;
    this.button(searchBox, '关闭搜索（Esc）', () => this.closeSearch(), 'x');
    this.searchInput.addEventListener('input', () => this.findText(0));
    this.searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); this.findText(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') { e.preventDefault(); this.closeSearch(); } });
    this.layout = this.contentEl.createDiv('era-layout');
    this.article = this.layout.createDiv('era-article markdown-rendered');
    this.article.setAttribute('tabindex', '0');
    this.article.setAttribute('aria-label', '文章正文'); this.article.setAttribute('aria-busy', 'true');
    this.article.addEventListener('keydown', e => { if (e.key === 'Escape') this.clearSentence(); });
    this.article.addEventListener('scroll', () => { if (this.article.scrollTop > 20) this.contentEl.classList.add('era-reading-started'); }, { passive: true });
    const doc = this.article.ownerDocument;
    this.child.registerDomEvent(doc, 'selectionchange', () => {
      const s = doc.getSelection();
      if (s?.rangeCount && !s.isCollapsed && this.article.contains(s.getRangeAt(0).commonAncestorContainer)) this.lastWordRange = s.getRangeAt(0).cloneRange();
    });
    this.article.addEventListener('mousedown', () => { this.lastWordRange = null; this.bracket = null; });
    this.child.registerDomEvent(doc.defaultView, 'keydown', e => this.readerKey(e), true);
    const loading = this.article.createDiv({ cls: 'era-loading', text: '正在打开文章…' });
    this.syncLayers();
    // Delegate to the article so freshly inserted links work without a rerender.
    this.hoverPopover = null;
    this.child.register(() => { this.hoverPopover?.unload(); this.hoverPopover = null; });
    this.child.registerDomEvent(this.article, 'mouseover', event => {
      const anchor = event.target.closest?.('a.internal-link');
      const href = anchor?.getAttribute('data-href');
      if (!href || this.linkWriting || event.buttons || (event.relatedTarget instanceof this.article.ownerDocument.defaultView.Node && anchor.contains(event.relatedTarget))) return;
      this.app.workspace.trigger('hover-link', { event, source: TYPE, hoverParent: this, targetEl: anchor, linktext: href, sourcePath: this.file.path });
    });
    const openLink = event => {
      if (event.type === 'auxclick' && event.button !== 1) return;
      const anchor = event.target.closest?.('a.internal-link');
      const href = anchor?.getAttribute('data-href');
      if (!href) return;
      event.preventDefault(); event.stopPropagation();
      const pane = Keymap.isModEvent(event);
      const target = href.startsWith('#^') ? this.article.querySelector(`[data-block-id="${CSS.escape(href.slice(2))}"]`) : null;
      if (target && !pane) target.scrollIntoView({ block: 'start' });
      else this.app.workspace.openLinkText(href, this.file.path, pane).catch(e => { this.status(e.message, 'error'); new Notice(e.message); });
    };
    this.child.registerDomEvent(this.article, 'click', openLink, true);
    this.child.registerDomEvent(this.article, 'auxclick', openLink, true);
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
    this.editingLabel = this.notesPanel.createDiv('era-editing-label'); this.editingLabel.hidden = true;
    this.quoteEl = this.notesPanel.createDiv('era-quote');
    this.questionEl = this.notesPanel.createDiv({ cls: 'era-question-label', text: this.draft().question }); this.questionEl.hidden = !this.draft().question;
    this.editor = this.notesPanel.createEl('textarea', { attr: { placeholder: '自己的理解、一个疑问，\n或这道题的答案…', 'aria-label': '手札或问题回答' } });
    this.editor.value = this.draft().text;
    this.editor.addEventListener('input', () => { this.draft().text = this.editor.value; this.plugin.scheduleFlush(); });
    this.editor.addEventListener('keydown', e => this.markdownKey(e));
    this.preview = this.notesPanel.createDiv('era-note-preview markdown-rendered'); this.preview.hidden = true;
    const noteActions = this.notesPanel.createDiv('era-note-actions');
    this.saveNoteButton = this.button(noteActions, '保存手札', () => this.saveNote(), 'check'); this.saveNoteButton.addClass('era-primary');
    this.button(noteActions, '打开笔记', () => this.openNotes(), 'external-link');
    this.previewButton = this.button(noteActions, 'Markdown 预览', () => this.togglePreview(), 'eye');
    const draftActions = this.notesPanel.createDiv('era-draft-actions');
    this.exitEditingButton = this.button(draftActions, '暂存并退出编辑', () => this.switchDraft({}), 'corner-up-left'); this.exitEditingButton.hidden = true;
    this.button(draftActions, '新手札', () => this.switchDraft({}), 'plus');
    this.clearQuoteButton = this.button(draftActions, '取消全部摘录', () => { setExcerpts(this.draft(), []); this.showDraft(); this.plugin.scheduleFlush(); });
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
    separateHeadings(content);
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
    const elements = [...this.article.querySelectorAll('p,li,td,th')].filter(el => !el.closest(SKIP) && !el.querySelector('p,li,table,pre') && /[a-zA-Z]/.test(el.textContent));
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
      decorate(elements[i], result.blocks[i], i);
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
    const items = excerpts(d);
    if (!items.some(item => ['quote', 'before', 'after'].every(key => item[key] === excerpt[key]))) setExcerpts(d, [...items, excerpt]);
    this.switchDraft(d);
  }
  readerKey(e) {
    if (this.app.workspace.activeLeaf?.view !== this || e.isComposing) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopImmediatePropagation(); this.openSearch(); return; }
    if (e.target.closest?.('textarea,input,[contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = ({ '[': '[', '{': '{', ']': ']', '}': '}' })[e.key];
    if (!key) { this.bracket = null; return; }
    let word;
    try { word = this.selectedWord(); } catch { this.bracket = null; return; }
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.repeat) return;
    const previous = this.bracket;
    this.bracket = { key, start: word.start, end: word.end, time: Date.now() };
    if (previous?.key === key && previous.start === word.start && previous.end === word.end && Date.now() - previous.time < 1500) {
      this.bracket = null;
      this.linkSelection().catch(error => { this.status(error.message, 'error'); new Notice(error.message); });
    }
  }
  openSearch() { this.searchBar.hidden = false; this.searchInput.focus({ preventScroll: true }); this.searchInput.select(); if (this.searchInput.value) this.findText(0); }
  closeSearch() { this.searchBar.hidden = true; this.article.focus({ preventScroll: true }); this.clearSearchHighlight(); }
  clearSearchHighlight() { this.article.ownerDocument.defaultView.CSS.highlights?.delete(`era-search-${this.leaf.id}`); }
  findText(direction) {
    const query = this.searchInput.value, text = this.article.textContent;
    const hits = [];
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const match of text.matchAll(pattern)) hits.push({ start: match.index, end: match.index + match[0].length });
    }
    this.clearSearchHighlight();
    this.searchIndex = !direction || this.searchQuery !== query ? 0 : ((this.searchIndex || 0) + direction + hits.length) % hits.length;
    this.searchQuery = query;
    this.searchCount.textContent = hits.length ? `${this.searchIndex + 1} / ${hits.length}` : query ? '无匹配' : '';
    this.findPrevious.disabled = this.findNext.disabled = !hits.length;
    if (!hits.length) return;
    const hit = hits[this.searchIndex], range = this.textRange(hit.start, hit.end), win = this.article.ownerDocument.defaultView;
    if (win.CSS.highlights && win.Highlight) win.CSS.highlights.set(`era-search-${this.leaf.id}`, new win.Highlight(range));
    const style = this.searchHighlightStyle ||= this.contentEl.createEl('style');
    style.textContent = `::highlight(era-search-${this.leaf.id}) { background-color: var(--text-highlight-bg); color: var(--text-normal); }`;
    range.startContainer.parentElement.scrollIntoView({ block: 'center' });
  }
  markdownKey(e) {
    if (!(e.ctrlKey || e.metaKey) || !['b', 'i'].includes(e.key.toLowerCase())) return;
    e.preventDefault(); e.stopPropagation();
    const token = e.key.toLowerCase() === 'b' ? '**' : '*', start = this.editor.selectionStart, end = this.editor.selectionEnd;
    this.editor.setRangeText(token + this.editor.value.slice(start, end) + token, start, end, 'select');
    this.editor.setSelectionRange(start + token.length, end + token.length);
    this.draft().text = this.editor.value; this.plugin.scheduleFlush();
  }
  async togglePreview() {
    if (!this.preview.hidden) { this.preview.hidden = true; this.editor.hidden = false; this.previewButton.setAttribute('aria-pressed', 'false'); this.editor.focus({ preventScroll: true }); return; }
    this.preview.empty();
    this.previewChild?.unload(); this.previewChild = new Component(); this.child.addChild(this.previewChild);
    await MarkdownRenderer.render(this.app, this.draft().text || '*还没有写下内容。*', this.preview, this.plugin.notePath(this.file.path), this.previewChild);
    this.preview.hidden = false; this.editor.hidden = true; this.previewButton.setAttribute('aria-pressed', 'true');
  }
  clearSentence() {
    for (const mark of this.article.querySelectorAll('[data-detail]')) delete mark.dataset.detail;
    this.sentenceButton?.setAttribute('aria-pressed', 'false');
    this.syncLayers();
  }
  detailSentence() {
    if (this.stale || !this.analysisReady) throw Error('请先分析当前文章。');
    const selection = this.article.ownerDocument.getSelection();
    const node = selection?.focusNode;
    const mark = (node?.nodeType === 1 ? node : node?.parentElement)?.closest('.era-mark');
    if (!mark || !this.article.contains(mark)) throw Error('请在要分析的句子中点一下或选词，再点「分析当前句」。');
    const wasOpen = mark.dataset.detail;
    this.clearSentence();
    if (!wasOpen) {
      for (const item of this.article.querySelectorAll(`[data-sentence="${mark.dataset.sentence}"]`)) item.dataset.detail = 'true';
      this.layers.verbs = true; this.syncLayers();
      this.sentenceButton.setAttribute('aria-pressed', 'true');
      this.status('当前句显示完整语法 · 再点一次或按 Esc 返回主干阅读。');
    }
  }
  selectedWord() {
    const selection = this.article.ownerDocument.getSelection();
    const live = selection?.rangeCount ? selection.getRangeAt(0) : null;
    let range = live && !live.collapsed && this.article.contains(live.commonAncestorContainer) ? live : this.lastWordRange;
    if (!range || range.collapsed) throw Error('请先选中正文中的英文单词。');
    if (!this.article.contains(range.startContainer) || !this.article.contains(range.endContainer)) throw Error('请在正文中选择单词。');
    const selected = range.toString(), quote = selected.trim(); vocabTarget(quote);
    const prefix = range.cloneRange(); prefix.selectNodeContents(this.article); prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length + selected.length - selected.trimStart().length, text = this.article.textContent;
    range = this.textRange(start, start + quote.length);
    const blocked = `${SKIP},a`;
    if ([range.startContainer, range.endContainer].some(n => (n.nodeType === 1 ? n : n.parentElement)?.closest(blocked)) || range.cloneContents().querySelector(blocked)) throw Error('已有链接、代码、公式和嵌入内容不能重复标词。');
    if (/[a-z'-]/i.test(text[start - 1] || '') || /[a-z'-]/i.test(text[start + quote.length] || '')) throw Error('请选择完整单词。');
    return { quote, start, end: start + quote.length, text };
  }
  async sourcePosition(selected, raw, file) {
    const candidates = linkCandidates(raw, selected.quote, this.app.metadataCache.getFileCache(file));
    if (!candidates.length) throw Error('这段选文无法安全映射到原文，请只选普通文本中的词。');
    // ponytail: one native render per marking operation; cache a source map only
    // if large-document measurements justify it. No second Markdown parser.
    const key = randomUUID(), marker = (id, edge) => `\uE000${key}:${id}:${edge}\uE001`;
    let probeRaw = '', previous = 0;
    candidates.forEach((c, i) => { probeRaw += raw.slice(previous, c.start) + marker(i, 's') + selected.quote + marker(i, 'e'); previous = c.end; });
    probeRaw += raw.slice(previous);
    probeRaw = probeRaw.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/, '');
    const probe = this.article.ownerDocument.createElement('div'), child = new Component(); child.load();
    try {
      await MarkdownRenderer.render(this.app, probeRaw, probe, file.path, child);
      const text = probe.textContent, pattern = new RegExp(`\uE000${key}:(\\d+):([se])\uE001`, 'g'), positions = new Map();
      let plain = '', last = 0;
      for (const m of text.matchAll(pattern)) {
        plain += text.slice(last, m.index); last = m.index + m[0].length;
        const id = Number(m[1]), item = positions.get(id) || {};
        if (item[m[2]] !== undefined) throw Error('选文存在重复渲染，未修改原文。');
        item[m[2]] = plain.length; positions.set(id, item);
      }
      plain += text.slice(last);
      if (plain !== selected.text) throw Error('这段 Markdown 的显示与原文映射不一致，未修改原文。');
      const hits = [...positions].filter(([, p]) => p.s === selected.start && p.e === selected.end);
      if (hits.length !== 1) throw Error('无法唯一确认选中位置，未修改原文。');
      return candidates[hits[0][0]].start;
    } finally { child.unload(); }
  }
  textRange(start, end) {
    const nodes = [], walker = this.article.ownerDocument.createTreeWalker(this.article, 4);
    let offset = 0;
    for (let n; (n = walker.nextNode());) { nodes.push({ n, start: offset, end: offset + n.length }); offset += n.length; }
    const first = nodes.find(x => x.end > start), last = nodes.find(x => x.end >= end && x.start < end);
    if (!first || !last) throw Error('选区已变化，请重新选择。');
    const range = this.article.ownerDocument.createRange();
    range.setStart(first.n, start - first.start); range.setEnd(last.n, end - last.start);
    return range;
  }
  restoreSelection(start, end) {
    const range = this.textRange(start, end);
    this.article.focus({ preventScroll: true });
    const selection = this.article.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  async linkSelection() {
    if (this.linkWriting || this.analysisTask) throw Error('正在更新阅读页，请稍后标词。');
    if (this.stale) throw Error('原文已变化，请先刷新。');
    const selected = this.selectedWord(), file = this.file, generation = this.generation, raw = this.sourceRaw;
    this.linkWriting = true; this.status('正在标记…', 'busy');
    try {
      await this.plugin.readyFile(file);
      const start = await this.sourcePosition(selected, raw, file);
      const target = vocabTarget(selected.quote);
      const existing = this.app.vault.getAbstractFileByPath(`Words/vocab/${target}.md`) || this.app.metadataCache.getFirstLinkpathDest(target, file.path);
      const destination = existing instanceof TFile ? this.app.metadataCache.fileToLinktext(existing, file.path, true) : target;
      if (/[\[\]|#^\r\n]/.test(destination)) throw Error('目标文件名无法安全生成双链，请在原文中处理。');
      const inserted = `[[${destination}${destination === selected.quote ? '' : `|${selected.quote}`}]]`;
      const after = applyLinkPatch(raw, this.sourceHash, start, selected.quote, inserted);
      await this.app.vault.process(file, current => applyLinkPatch(current, hash(raw), start, selected.quote, inserted));
      if (generation !== this.generation || this.file !== file) return;
      if (await this.app.vault.read(file) !== after) { this.stale = true; throw Error('双链已写入，但原文随后又有改动，请刷新后继续。'); }
      const scroll = this.article.scrollTop, anchors = [], walker = this.article.ownerDocument.createTreeWalker(this.article, 4), nodes = [];
      let offset = 0;
      for (let n; (n = walker.nextNode());) { nodes.push({ n, start: offset, end: offset + n.length }); offset += n.length; }
      for (const item of nodes.filter(x => x.start < selected.end && x.end > selected.start)) {
        let node = item.n;
        const from = Math.max(0, selected.start - item.start), to = Math.min(node.length, selected.end - item.start);
        if (to < node.length) node.splitText(to);
        if (from) node = node.splitText(from);
        const anchor = this.article.ownerDocument.createElement('a'); anchor.className = `internal-link${existing ? '' : ' is-unresolved'}`;
        anchor.dataset.href = destination; anchor.setAttribute('href', destination); anchor.setAttribute('aria-label', destination);
        node.replaceWith(anchor); anchor.append(node); anchors.push(anchor);
      }
      this.sourceRaw = after; this.sourceHash = hash(after); this.stale = false;
      this.article.classList.toggle('era-colors', !!this.analysisReady);
      this.linkHistory.push({ start, before: selected.quote, inserted, afterHash: hash(after), anchors, selection: selected });
      this.undoLinkButton.disabled = false; this.restoreSelection(selected.start, selected.end); this.article.scrollTop = scroll;
      this.status(`已标为双链：${selected.quote} · 可撤销，继续阅读。`);
    } finally { this.linkWriting = false; }
  }
  async undoLink() {
    const item = this.linkHistory.at(-1);
    if (!item || this.linkWriting) return;
    if (this.stale) throw Error('原文已变化，为避免覆盖新内容，本次不撤销。');
    const file = this.file, generation = this.generation;
    this.linkWriting = true;
    try {
      await this.plugin.readyFile(file);
      const after = applyLinkPatch(this.sourceRaw, item.afterHash, item.start, item.inserted, item.before);
      await this.app.vault.process(file, raw => applyLinkPatch(raw, item.afterHash, item.start, item.inserted, item.before));
      if (generation !== this.generation || this.file !== file) return;
      if (await this.app.vault.read(file) !== after) { this.stale = true; throw Error('已撤销，但原文随后又有改动，请刷新。'); }
      const scroll = this.article.scrollTop;
      for (const anchor of item.anchors) if (anchor.isConnected) anchor.replaceWith(...anchor.childNodes);
      this.sourceRaw = after; this.sourceHash = hash(after); this.stale = false;
      this.article.classList.toggle('era-colors', !!this.analysisReady);
      this.linkHistory.pop(); this.undoLinkButton.disabled = !this.linkHistory.length;
      this.restoreSelection(item.selection.start, item.selection.end); this.article.scrollTop = scroll;
      this.status('已撤销上次标词。');
    } finally { this.linkWriting = false; }
  }
  readingGoal() { return this.plugin.data.goals?.[this.file.path] || ''; }
  showGoal() {
    const q = this.readingGoal();
    this.goalSummary.textContent = q ? `当前问题 · ${q}` : '阅读目标 · 可选，写下自己想弄懂的问题';
    this.goalInput.value = q;
  }
  setGoal(text) {
    (this.plugin.data.goals ||= {})[this.file.path] = text.trim().slice(0, 500);
    this.showGoal(); this.goal.open = false; this.plugin.scheduleFlush();
  }
  answerQuestion(question) {
    this.setGoal(question);
    const d = this.draft(), next = d.question === question ? d : this.parkedDrafts().find(item => item.question === question);
    if (next) this.switchDraft(next);
    else if (!d.question && !d.text.trim()) { d.question = question; this.switchDraft(d); }
    else this.switchDraft({ question });
  }
  async saveNote() {
    if (this.saving) return;
    const original = this.draft(), snapshot = JSON.stringify(original), d = JSON.parse(snapshot);
    if (!d.text.trim()) throw Error('先写下手札或回答再保存。');
    this.saving = true;
    try {
      const result = d.edit ? await this.plugin.updateNote(this.file, d) : { file: await this.plugin.appendNote(this.file, d, this.sourceHash) };
      const note = result.file;
      if (JSON.stringify(original) === snapshot) {
        if (this.draft() === original) { Object.assign(original, { text: '', question: '' }); delete original.edit; setExcerpts(original, []); }
        else { const index = this.parkedDrafts().indexOf(original); if (index >= 0) this.parkedDrafts().splice(index, 1); }
        this.showDraft();
      } else if (d.edit && original.edit?.original === d.edit.original) {
        // A newer revision typed during save must use the just-written version as its baseline.
        original.edit = { ...original.edit, ...result.edit };
      }
      await this.plugin.flush(); await this.showSaved(); this.status(`${d.edit ? '已更新原手札' : '已保存'}：${note.path}`);
      for (const card of this.side.querySelectorAll('.era-question')) if (card.querySelector('p').textContent === d.question) { card.querySelector('small').textContent = '已回答'; card.classList.add('era-answered'); }
    } finally { this.saving = false; }
  }
  async openNotes(line = 0) {
    const file = this.app.vault.getAbstractFileByPath(this.plugin.notePath(this.file.path));
    if (!file) throw Error('尚未保存手札。');
    return this.app.workspace.getLeaf('split', 'vertical').openFile(file, { state: { mode: 'source' }, eState: { line, focus: true } });
  }
  async showSaved() {
    const expanded = this.saved.querySelector('details')?.open;
    this.saved.empty(); this.entries = [];
    const note = this.app.vault.getAbstractFileByPath(this.plugin.notePath(this.file.path));
    if (!note) return;
    await this.plugin.readyFile(note);
    const raw = await this.app.vault.read(note);
    this.entries = noteEntries(raw);
    if (this.entries.length) {
      const details = this.saved.createEl('details'); details.createEl('summary', { text: `已保存手札 · ${this.entries.length}` });
      details.open = !!expanded;
      this.button(details, '刷新已保存手札', () => this.showSaved(), 'refresh-cw');
      for (const item of this.entries) {
        const card = details.createEl('details', { cls: 'era-saved-entry' });
        card.createEl('summary', { text: item.question || item.label });
        this.button(card, '编辑这条手札', () => this.editSaved(item, note.path), 'pencil');
        for (const quote of excerpts(item)) this.button(card, quote.quote.slice(0, 60) + (quote.quote.length > 60 ? '…' : ''), () => this.jumpQuote(quote), 'corner-up-left');
        const preview = card.createDiv('markdown-rendered');
        card.addEventListener('toggle', async () => {
          if (!card.open || preview.childNodes.length) return;
          try { await MarkdownRenderer.render(this.app, item.markdown, preview, note.path, this.child); }
          catch (error) { this.status(error.message, 'error'); }
        });
      }
    }
  }
  editSaved(item, notePath = this.plugin.notePath(this.file.path)) {
    if (!item.editable) throw Error('手札结构已在外部调整，无法安全分离正文。请先在「打开笔记」中核对，原内容未改动。');
    const drafts = [this.draft(), ...this.parkedDrafts()];
    const existing = drafts.find(d => d.edit?.path === notePath && (d.edit.original === item.original || (item.id && d.edit.meta?.id === item.id)));
    if (existing) { this.switchDraft(existing); return; }
    const edit = { path: notePath, original: item.original, label: item.label, link: item.link, eol: item.eol, meta: item.meta };
    const next = { text: item.text, question: item.question || '', edit };
    setExcerpts(next, JSON.parse(JSON.stringify(excerpts(item))));
    this.switchDraft(next);
    this.notesPanel.scrollTop = 0;
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
      this.questionsPanel.createEl('p', { cls: 'era-muted', text: found.length ? '从正文提取的问题。' : '规则模板导读题 · 可选提示，也可以自己提问。' });
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
      this.button(actions, '设为目标', () => this.setGoal(q.text), 'flag');
      this.button(actions, '写回答', () => this.answerQuestion(q.text), 'pen-line');
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
    this.registerHoverLinkSource(TYPE, { display: this.manifest.name || '英文阅读助手', defaultMod: true });
    this.addCommand({ id: 'open-current', name: '为当前文章打开阅读助手', callback: () => this.open().catch(e => new Notice(e.message)) });
    for (const [id, name, method] of [['link-selection', '将阅读页选词标为双链', 'linkSelection'], ['undo-link', '撤销阅读页上次标词', 'undoLink'], ['detail-sentence', '分析阅读页当前句', 'detailSentence']]) {
      this.addCommand({ id, name, checkCallback: checking => {
        const view = this.app.workspace.activeLeaf?.view;
        if (!(view instanceof Reader)) return false;
        if (!checking) Promise.resolve().then(() => view[method]()).catch(e => { view.status(e.message, 'error'); new Notice(e.message); });
        return true;
      } });
    }
    this.addRibbonIcon('book-open-text', '为当前文章打开阅读助手', () => this.open().catch(e => new Notice(e.message)));
    this.registerEvent(this.app.vault.on('modify', file => {
      for (const leaf of this.app.workspace.getLeavesOfType(TYPE)) if (leaf.view.file?.path === file.path) {
        if (leaf.view.linkWriting) continue; // The writer verifies the final bytes before keeping decorations.
        leaf.view.stale = true; leaf.view.article?.classList.remove('era-colors'); leaf.view.status('原文有更新 · 点击「刷新」后继续。');
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, old) => {
      if (this.data.drafts[old]) { this.data.drafts[file.path] = this.data.drafts[old]; delete this.data.drafts[old]; }
      if (this.data.parkedDrafts?.[old]) { this.data.parkedDrafts[file.path] = this.data.parkedDrafts[old]; delete this.data.parkedDrafts[old]; }
      if (this.data.notes[old]) { this.data.notes[file.path] = this.data.notes[old]; delete this.data.notes[old]; }
      if (this.data.goals?.[old]) { this.data.goals[file.path] = this.data.goals[old]; delete this.data.goals[old]; }
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
  async updateNote(source, draft) {
    const edit = draft.edit;
    if (edit.path !== this.notePath(source.path)) throw Error('手札路径已变化，请核对后再保存。');
    const file = this.app.vault.getAbstractFileByPath(edit.path);
    await this.readyFile(source); await this.readyFile(file);
    const next = updatedEntry(edit, draft, edit.meta?.sourceHash || '');
    await this.app.vault.process(file, raw => replaceEntry(raw, edit, next).replace(/^modified:.*$/m, `modified: ${today()}`));
    const current = await this.app.vault.read(file);
    if (!current.includes(next)) throw Error('保存后手札又有变化，请核对。当前编辑仍保留。');
    const item = noteEntries(next)[0];
    if (!item?.editable) throw Error('更新后的手札结构需要核对，当前编辑仍保留。');
    return { file, edit: { ...edit, original: next, meta: item.meta } };
  }
  async appendNote(source, draft, sourceHash) {
    await this.readyFile(source);
    const target = this.notePath(source.path), date = today();
    await this.mkdir('Notes/reading-notes');
    const link = this.app.fileManager.generateMarkdownLink(source, target);
    const quotes = excerpts(draft);
    const item = { id: randomUUID(), ...quotes[0], quote: quotes[0]?.quote || '', excerpts: quotes, question: draft.question, sourceHash };
    const marker = Buffer.from(JSON.stringify(item), 'utf8').toString('base64');
    const quoted = quotes.map(item => item.quote.split('\n').map(line => `> ${line}`).join('\n')).join('\n\n');
    const entry = `\n## ${new Date().toLocaleString('zh-CN')}\n\n来源：${link}\n\n${draft.question ? `问题：${draft.question}\n\n` : ''}${quoted ? quoted + '\n\n' : ''}${draft.text}\n\n<!-- era:${marker} -->\n`;
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
module.exports.checks = { valid, locate, hash, vocabTarget, linkCandidates, applyLinkPatch, noteEntries, updatedEntry, replaceEntry };
