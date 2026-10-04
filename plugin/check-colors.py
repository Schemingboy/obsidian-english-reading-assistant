"""Run: python check-colors.py. Check neutral layers, text and boundary contrast.

Neutral-chroma and lightness thresholds are project regression checks,
not WCAG rules or a numerical guarantee of aesthetic harmony.
"""
from pathlib import Path
import json
import math
import re


def rgb(value):
    if value.startswith('#'):
        return [int(value[i:i + 2], 16) for i in (1, 3, 5)]
    return list(map(float, re.findall(r'[\d.]+', value)))


def linear(color):
    return [v / 255 / 12.92 if v / 255 <= .04045 else ((v / 255 + .055) / 1.055) ** 2.4 for v in color[:3]]


def luminance(color):
    return sum(v * w for v, w in zip(linear(color), [.2126, .7152, .0722]))


def contrast(a, b):
    x, y = sorted([luminance(a), luminance(b)])
    return (y + .05) / (x + .05)


def lab(color):
    r, g, b = linear(color)
    xyz = [(r * .4124564 + g * .3575761 + b * .1804375) / .95047,
           r * .2126729 + g * .7151522 + b * .072175,
           (r * .0193339 + g * .119192 + b * .9503041) / 1.08883]
    x, y, z = [v ** (1 / 3) if v > (6 / 29) ** 3 else v / (3 * (6 / 29) ** 2) + 4 / 29 for v in xyz]
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)]


def check():
    css = Path(__file__).with_name('styles.css').read_text(encoding='utf-8-sig')
    results = {}
    for theme, selector, body in [('light', '.era-view', '#1d1f20'), ('dark', '.theme-dark .era-view', '#d3dade')]:
        block = re.search(re.escape(selector) + r'\s*\{([^}]+)', css)[1]
        values = dict(re.findall(r'--era-([\w-]+):\s*(#[0-9a-f]{6});', block))
        groups = [rgb(values[f'group-{i}']) for i in range(2)]
        inks = [rgb(body)] + [rgb(values[key]) for key in ['main', 'subordinate', 'nonfinite']]
        ratios = [contrast(ink, bg) for ink in inks for bg in groups]
        boundaries = [contrast(rgb(values['boundary']), bg) for bg in groups]
        chroma = [math.hypot(*lab(bg)[1:]) for bg in groups]
        lightness = abs(lab(groups[0])[0] - lab(groups[1])[0])
        assert min(ratios) >= 4.5, (theme, 'text contrast', ratios)
        assert min(boundaries) >= 3, (theme, 'boundary contrast', boundaries)
        assert max(chroma) <= 10, (theme, 'background must remain neutral', chroma)
        assert lightness >= 5, (theme, 'alternating lightness', lightness)
        assert values['main'] == values['subordinate'], 'Finite verbs share one accent hue.'
        assert 'data-group-start' in css and 'content: \'\'' in css, 'Group boundaries must have a non-color cue.'
        results[theme] = {'groups': [values[f'group-{i}'] for i in range(2)],
                          'minimumTextContrast': round(min(ratios), 2),
                          'minimumBoundaryContrast': round(min(boundaries), 2),
                          'maximumBackgroundChroma': round(max(chroma), 2),
                          'lightnessDifference': round(lightness, 2)}
    return results


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))
