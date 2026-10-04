// Run: node check.js. Uses the actual plugin helpers with only Obsidian's host classes stubbed.
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const sandbox = { module: { exports: {} }, process, require: name => name === 'obsidian' ? { Plugin: class {
  registerView() {} addCommand() {} addRibbonIcon() {} registerEvent() {}
}, ItemView: class {} } : require(name) };
vm.runInNewContext(fs.readFileSync(__dirname + '/main.js', 'utf8'), sandbox);
const { valid, locate, hash, vocabTarget, linkCandidates, applyLinkPatch } = sandbox.module.exports.checks;
assert.equal(locate('same same', 'same'), -1);
assert.equal(locate('one same two same end', 'same', 'two ', ' end'), 13);
assert.equal(locate('changed', 'old'), -1);
assert.equal(locate('a unique sentence', 'unique'), 2);
const good = { version: 'spacy-en-sm-3.8.0-r2', blocks: [{ groups: [{ start: 0, end: 5, text: 'hello' }], predicates: [], sentences: [{ start: 0, end: 5, text: 'hello' }] }] };
assert(valid(good, ['hello']));
assert(!valid(good, ['world']));
good.blocks[0].groups[0].end = 50;
assert(!valid(good, ['hello']));
assert(!valid(null, []));
console.log('PASS: ambiguous/changed quotations rejected; contextual match; invalid and stale spans rejected.');
assert.throws(() => vocabTarget('word]] [[injection'));
assert.throws(() => vocabTarget('one two three four'));
assert.equal(vocabTarget('Reading'), 'reading');
assert.equal(vocabTarget('well-being'), 'well-being');
assert.equal(vocabTarget("don't"), "don't");
const raw = '---\ntitle: word\n---\n\nword and **word** and [[word]].';
const link = raw.indexOf('[[word]]');
const hits = linkCandidates(raw, 'word', { links: [{ position: { start: { offset: link }, end: { offset: link + 8 } } }] });
assert.deepEqual(JSON.parse(JSON.stringify(hits)), [{ start: 21, end: 25 }, { start: 32, end: 36 }]);
assert.throws(() => applyLinkPatch(raw + 'changed', hash(raw), 32, 'word', '[[word]]'));
assert.throws(() => applyLinkPatch(raw, hash(raw), 31, 'word', '[[word]]'));
const marked = applyLinkPatch(raw, hash(raw), 32, 'word', '[[word]]');
assert.equal(marked, '---\ntitle: word\n---\n\nword and **[[word]]** and [[word]].');
assert.equal(applyLinkPatch(marked, hash(marked), 32, '[[word]]', 'word'), raw);
console.log('PASS: safe vocabulary target, frontmatter/link exclusions, exact occurrence, concurrent edit rejection and reversible patch.');
(async () => {
  const plugin = new sandbox.module.exports();
  plugin.manifest = { dir: '.obsidian/plugins/english-reading-assistant' };
  const reads = [];
  plugin.app = { vault: { on() {}, adapter: { exists: async () => false, read: async path => { reads.push(path); throw Error('Unexpected read'); }, getBasePath: () => '/test-vault' } } };
  await plugin.onload();
  assert.equal(plugin.questions.length, 0);
  assert.equal(reads.length, 0);
  assert(plugin.pythonPath.includes('.runtime'));
  plugin.app.vault.adapter.exists = async path => path.endsWith('/runtime.json');
  plugin.app.vault.adapter.read = async () => JSON.stringify({ pythonPath: '/custom/python' });
  await plugin.onload();
  assert.equal(plugin.pythonPath, '/custom/python');
  console.log('PASS: clean install needs no personal question bank; explicit local Python configuration supported.');
})().catch(error => { console.error(error); process.exitCode = 1; });
