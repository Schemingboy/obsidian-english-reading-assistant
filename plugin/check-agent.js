// Run: node plugin/check-agent.js. Synthetic fixtures; no credentials or live model calls.
const assert = require('assert/strict');
const http = require('http');
const A = require('./agent');
const methods = require('./agent-ui');

(async () => {
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com?key=secret', 'file:///tmp/model', 'https://example.com#key']) assert.throws(() => A.endpoint(url));
  assert.equal(A.endpoint('https://example.com/v1/').href, 'https://example.com/v1/chat/completions');
  assert.equal(A.endpoint('https://example.com/v1/chat/completions').href, 'https://example.com/v1/chat/completions');
  assert.equal(A.secretId('https://example.com/v1/'), A.secretId('https://example.com/v1/chat/completions'));
  assert.notEqual(A.secretId('https://example.com/v1/'), A.secretId('https://other.example.com/v1/'));
  assert.throws(() => A.prompt('other', 'text'));
  assert.throws(() => A.prompt('review', ' '));
  assert.throws(() => A.prompt('review', 'x'.repeat(A.MAX_INPUT)));
  assert(A.prompt('sentence', 'Mira stayed home.', '简短一点').includes('简短一点'));
  const inertDraft = A.draftText('**Answer**\n```dataviewjs\nsecret()\n```\n<img src="remote">\n![[other-note]]\n![pixel](https://example.com)\n<!-- era:AAAA -->');
  assert(inertDraft.startsWith('**Answer**'));
  assert(!inertDraft.includes('<') && !inertDraft.includes('\n```') && !inertDraft.includes('\n![[') && !inertDraft.includes('\n!['));
  console.log('PASS: endpoint validation, per-endpoint secrets, task and input bounds.');

  let hits = 0, route = 'ok', lastBody;
  const server = http.createServer((req, res) => {
    hits++;
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (req.method === 'GET') {
        if (route === 'models-missing') { res.writeHead(404); res.end('private error'); return; }
        assert.equal(req.url, '/v1/models');
        res.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] })); return;
      }
      lastBody = JSON.parse(data);
      if (route === 'wait') return;
      if (route === 'redirect') { res.writeHead(302, { Location: '/stolen' }); res.end('secret-from-error'); return; }
      if (route === 'auth') { res.writeHead(401); res.end('secret-from-error'); return; }
      if (route === 'rate') { res.writeHead(429); res.end('private-provider-diagnostics'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (route === 'invalid') { res.end('{bad json'); return; }
      const content = route === 'empty' ? '' : '**有依据**：The bridge was closed.';
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: route === 'truncated' ? 'length' : 'stop' }] }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'fixture' };
  try {
    for (const failure of ['auth', 'rate', 'redirect', 'invalid', 'empty', 'truncated']) {
      route = failure; const before = hits;
      await assert.rejects(A.apiCall(config, 'synthetic-token', 'fixture', null), error => !error.message.includes('secret-from-error') && !error.message.includes('private-provider-diagnostics'));
      assert.equal(hits, before + 1, 'must not follow redirects or auto retry');
    }
    route = 'models-missing'; await assert.rejects(A.listModels(config, 'fake-key', null), /手动/);
    route = 'ok'; assert.deepEqual(await A.listModels(config, 'fake-key', null), ['model-a', 'model-b']);
    const answer = await A.apiCall(config, '', '本文虚构材料', null);
    assert.match(answer, /有依据/);
    assert.equal(lastBody.messages[1].content, '本文虚构材料');
    assert.equal(lastBody.messages[0].content, A.SYSTEM);
    assert.equal(lastBody.stream, false);
    assert(!('tools' in lastBody));
    const canceled = new AbortController(); canceled.abort(); const before = hits;
    await assert.rejects(A.apiCall(config, '', 'fixture', canceled.signal), /取消/);
    assert.equal(hits, before);
    route = 'wait';
    const controller = new AbortController();
    const call = A.apiCall(config, '', 'fixture', controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(call, /取消/);
    await assert.rejects(A.apiCall(config, '', 'fixture', null, 30), /超时/);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  console.log('PASS: real HTTP transport success, auth/rate/schema failures, no redirects/retries, cancel and timeout.');

  const args = A.claudeArgs('custom-model');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert(args.includes('--strict-mcp-config') && args.includes('--disable-slash-commands') && args.includes('--no-session-persistence'));
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks, true);
  assert(!args.some(a => a.includes('bypass')));
  assert.throws(() => A.findClaude('/missing/claude.cmd'));
  console.log('PASS: CLI tool/MCP/hook restrictions and shell launcher rejection.');

  const R = require('./agent-reading');
  const fixture = { task: 'review', article: '[P1] Mira stayed home because the bridge was closed.', question: 'Why did Mira stay home?', answer: 'STUDENT_ANSWER: the bridge was closed', config: { provider: 'api', model: 'fixture', contextChars: 16000 }, history: [{ role: 'user', text: 'HISTORY_PRIVATE_ANSWER' }], cache: new Map() };
  const calls = [];
  const call = async text => { calls.push(text); return calls.length === 1 ? '[P1] Reference: bridge closed.' : 'An alternative answer with evidence is valid.'; };
  const result = await R.run(fixture, call);
  assert.equal(calls.length, 2);
  assert(!calls[0].includes('STUDENT_ANSWER') && !calls[0].includes('HISTORY_PRIVATE_ANSWER'));
  assert(calls[1].includes('STUDENT_ANSWER') && calls[1].includes('HISTORY_PRIVATE_ANSWER') && calls[1].includes('bridge closed'));
  assert.equal(result.coverage.mode, 'full');
  const beforeCalls = calls.length; await R.run(fixture, call); assert.equal(calls.length, beforeCalls + 1, 'reference reused only for same model/material/question');
  await R.run({ ...fixture, question: 'What changed?' }, call); assert.equal(calls.length, beforeCalls + 3);
  let noAnswerCalls = 0;
  await R.run({ ...fixture, answer: '', cache: new Map() }, async () => { noAnswerCalls++; return 'Reference with evidence'; });
  assert.equal(noAnswerCalls, 1, 'no answer does not block reference help');
  const longText = Array.from({ length: 120 }, (_, i) => `[P${i + 1}] Evidence number ${i + 1}. ` + 'A fictional paragraph. '.repeat(45)).join('\n\n');
  assert.equal(R.splitText(longText, 2700).join(''), longText);
  assert.equal(R.splitText('a'.repeat(2000) + '😀' + 'b'.repeat(2000), 2001).join(''), 'a'.repeat(2000) + '😀' + 'b'.repeat(2000));
  const readChunks = [], progress = [];
  const longResult = await R.run({ ...fixture, article: longText, config: { ...fixture.config, contextChars: 8000 }, cache: new Map(), progress: (text, coverage) => { if (coverage) progress.push(coverage); } }, async text => {
    const data = JSON.parse(text.slice(text.indexOf('{')));
    if (data.label === '文章') { if (data.round === 0) readChunks.push(data.text); return `[P1] Evidence retained from part ${data.part}.`; }
    return '[P1] grounded answer';
  });
  assert.equal(readChunks.join(''), longText, 'every source character was read; none silently dropped');
  assert.equal(longResult.coverage.mode, 'segmented');
  assert.equal(longResult.coverage.read, longResult.coverage.total);
  const controller = new AbortController(); let cancellationCalls = 0;
  await assert.rejects(R.run({ ...fixture, article: longText, config: { contextChars: 8000 }, cache: new Map(), signal: controller.signal }, async () => { cancellationCalls++; controller.abort(); return 'unused'; }), /取消/);
  assert.equal(cancellationCalls, 1, 'cancel stops the next part');
  assert(R.diffLines('Keep\nOld\nEnd', 'Keep\nNew\nEnd').some(x => x.kind === 'removed' && x.text === 'Old'));
  assert(R.diffLines('Keep\nOld\nEnd', 'Keep\nNew\nEnd').some(x => x.kind === 'added' && x.text === 'New'));
  console.log('PASS: independent reference excludes answer/history; cache scoped to question/model; long article completely covered; cancellation stops remaining parts.');

  let draft = { text: 'Original voice.', question: 'Why?', excerpts: [] };
  const reader = { ...methods, file: { path: 'fiction.md' }, sourceHash: 'v1', stale: false,
    plugin: { data: {}, checkFile() {}, scheduleFlush() {} }, draft: () => draft,
    showDraft() {}, selectPanel() {}, updateAgentUI() {}, renderAgentRevision() {}, status() {}, checkAgentSource: async () => {},
    agentState: { revision: { source: 'fiction.md', sourceHash: 'v1', snapshot: JSON.stringify(draft), before: draft.text, text: 'Original voice. Added evidence.' } }
  };
  draft.text = 'New user thought'; assert.throws(() => reader.applyAgentRevision(), /修改/);
  assert.equal(draft.text, 'New user thought'); assert(reader.agentState.revision);
  draft.text = 'Original voice.'; reader.applyAgentRevision();
  assert.equal(draft.text, 'Original voice. Added evidence.');
  assert.equal(reader.plugin.data.agentUndo['fiction.md'].before.text, 'Original voice.');
  draft.text += ' Another edit.'; await assert.rejects(reader.undoAgentEdit(), /后来/);
  draft.text = 'Original voice. Added evidence.'; await reader.undoAgentEdit(); assert.equal(draft.text, 'Original voice.');
  console.log('PASS: revision preview changes nothing; apply rejects concurrent edits; original retained; guarded undo restores exact text.');

})().catch(error => { console.error(error); process.exitCode = 1; });
