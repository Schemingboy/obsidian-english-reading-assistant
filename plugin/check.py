"""Run with ../.runtime/Scripts/python.exe check.py from this folder."""
import json
import spacy
from analyzer import analyze

samples = [
    ('Moving south while braving high winds that reached 120 degrees, William Loftus led a small expedition.', {'Moving': 'nonfinite', 'braving': 'nonfinite', 'reached': 'subordinate', 'led': 'main'}),
    ('Loftus and his small group were soon overwhelmed by what they saw.', {'were': 'main', 'overwhelmed': 'main', 'saw': 'subordinate'}),
    ('She is reading.', {'is': 'main', 'reading': 'main'}),
    ('She wants to read.', {'wants': 'main', 'to': 'nonfinite', 'read': 'nonfinite'}),
    ('The book written by John was lost.', {'written': 'nonfinite', 'was': 'main', 'lost': 'main'}),
    ('She has been reading and writing all day.', {'has': 'main', 'been': 'main', 'reading': 'main', 'writing': 'main'}),
    ('Did he really leave?', {'Did': 'main', 'leave': 'main'}),
    ('They will not have finished when we arrive.', {'will': 'main', 'not': 'main', 'have': 'main', 'finished': 'main', 'arrive': 'subordinate'}),
    ('😀 She said that he was tired.', {'said': 'main', 'was': 'subordinate'}),
    ('Reading books helps us learn.', {'Reading': 'nonfinite', 'helps': 'main', 'learn': 'nonfinite'}),
]
result = analyze(spacy.load('en_core_web_sm', disable=['ner']), [s[0] for s in samples])
for (text, expected), block in zip(samples, result['blocks']):
    actual = {p['text']: p['role'] for p in block['predicates']}
    for token, role in expected.items():
        assert actual.get(token) == role, (text, token, role, actual)
    utf16 = text.encode('utf-16-le')
    for kind in ['groups', 'predicates']:
        previous = 0
        for span in block[kind]:
            assert span['start'] >= previous
            assert utf16[span['start'] * 2:span['end'] * 2].decode('utf-16-le') == span['text']
            previous = span['end']
    assert ''.join(g['text'] for g in block['groups']) == text
print(json.dumps({'grammar_samples': len(samples), 'offsets': 'UTF-16 checked including emoji', 'status': 'passed'}))

segmentation = [
    ('Farmers grew wheat, barley and peas.', ['Farmers grew wheat, barley and peas.']),
    ('The farmers, traders and rulers worked together.', ['The farmers, traders and rulers', 'worked together.']),
    ('People relied on farming, hunting and fishing.', ['People relied on farming, hunting and fishing.']),
    ('The village grew, and trade increased.', ['The village grew,', 'and trade increased.']),
    ('People built houses and stored grain.', ['People built houses and stored grain.']),
    ('A plan that looks simple may fail when the conditions change.', ['A plan that looks simple', 'may fail', 'when the conditions change.']),
    ('To understand how people learn, we need to consider what they already know.', ['To understand how people learn,', 'we need to consider what they already know.']),
    ('The key to understanding the argument is to identify what the author assumes.', ['The key to understanding the argument', 'is to identify what the author assumes.']),
    ('After reading the report, she decided to ask two questions.', ['After reading the report,', 'she decided to ask two questions.']),
    ('He has not been able to finish the work.', ['He has not been able to finish the work.']),
    ('She has read and written all day. He turned off the light.', ['She has read and written all day.', 'He turned off the light.']),
]
results = analyze(spacy.load('en_core_web_sm', disable=['ner']), [text for text, _ in segmentation])
for (text, expected), block in zip(segmentation, results['blocks']):
    assert [g['text'].strip() for g in block['groups']] == expected, (text, block['groups'])
    assert ''.join(g['text'] for g in block['groups']) == text
    for sentence in block['sentences']:
        assert text[sentence['start']:sentence['end']] == sentence['text']
print(json.dumps({'segmentation_regressions': len(segmentation), 'status': 'passed'}))

# Reader-level contracts, rather than freezing every optional cut position.
# All fixtures are invented; real reading samples stay in local validation data.
reading_samples = [
    ('The village expanded from 2500 to 1800 B.C. Farmers stored grain in stone houses.', ['2500 to 1800 B.C.'], 'Farmers'),
    ('The style of fifth-century B.C. Athens influenced later painters.', ['B.C. Athens'], None),
    ('Farmers grew wheat, barley, and peas in the valley; rice and beans in the hills; and corn near the coast.', ['wheat, barley, and peas', 'rice and beans'], ';'),
    ('Although the villagers cultivated several kinds of crops in the fertile valley, they depended on trade with distant towns during the winter.', ['Although the villagers'], 'in the fertile valley'),
    ('The growing of crops on a regular basis gave rise to permanent villages.', ['The growing of crops', 'on a regular basis', 'gave rise to'], 'on a regular basis'),
    ('A division of labor allowed people to use larger animals as beasts of burden.', ['division of labor', 'beasts of burden'], None),
    ('A settlement discovered beside the river (named after the explorer who found it) contained houses and workshops.', ['who found it)'], None),
    ('The guide said: “People worked together.” Then she closed the book.', ['“People'], None),
    ('The workers kept making tools [and] carrying supplies to the village.', ['[and] carrying'], None),
    ('The settlement existed as long as three to four million years ago.', ['as long as', 'three to four million'], None),
]
blocks = analyze(spacy.load('en_core_web_sm', disable=['ner']), [s[0] for s in reading_samples])['blocks']
for (text, phrases, boundary), block in zip(reading_samples, blocks):
    groups = block['groups']
    assert ''.join(g['text'] for g in groups) == text
    for phrase in phrases:
        assert any(phrase in g['text'] for g in groups), (phrase, groups)
    assert all(any(c.isalnum() for c in g['text']) for g in groups), groups
    assert not any(g['text'].lstrip().startswith((')', ']', '”', '’')) for g in groups), groups
    if boundary == ';':
        assert all(';' not in g['text'].rstrip().rstrip(';') for g in groups), groups
    elif boundary:
        assert any(g['text'].startswith(boundary) for g in groups), (boundary, groups)
    if 'B.C. Farmers' in text:
        assert len(block['sentences']) == 2, block['sentences']
        assert all(p['role'] == 'main' for p in block['predicates'] if p['text'] in ('expanded', 'stored'))
    if 'B.C. Athens' in text:
        assert len(block['sentences']) == 1, block['sentences']
print(json.dumps({'reading_contracts': len(reading_samples), 'status': 'passed'}))
