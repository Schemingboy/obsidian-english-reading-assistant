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
    ('A plan that looks simple may fail when the conditions change.', ['A plan that looks simple', 'may fail', 'when the conditions change.']),
    ('To understand how people learn, we need to consider what they already know.', ['To understand how people learn,', 'we need to consider', 'what they already know.']),
    ('The key to understanding the argument is to identify what the author assumes.', ['The key to understanding the argument', 'is to identify', 'what the author assumes.']),
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
