"""Run: python check-colors.py. Check text contrast and pairwise group separation.

Delta E 76 >= 18 is this project's regression threshold, not a WCAG rule
or a guarantee for every display or kind of color vision.
"""
from pathlib import Path
from itertools import combinations
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


def separation(groups):
    return [math.dist(lab(a), lab(b)) for a, b in combinations(groups, 2)]


def check():
    css = Path(__file__).with_name('styles.css').read_text(encoding='utf-8-sig')
    results = {}
    for theme, selector, body in [('light', '.era-view', '#1d1f20'), ('dark', '.theme-dark .era-view', '#d3dade')]:
        block = re.search(re.escape(selector) + r'\s*\{([^}]+)', css)[1]
        values = dict(re.findall(r'--era-([\w-]+):\s*(#[0-9a-f]{6});', block))
        groups = [rgb(values[f'group-{i}']) for i in range(3)]
        inks = [rgb(body)] + [rgb(values[key]) for key in ['main', 'subordinate', 'nonfinite']]
        ratios = [contrast(ink, bg) for ink in inks for bg in groups]
        distances = separation(groups)
        assert min(ratios) >= 4.5, (theme, 'text contrast', ratios)
        assert min(distances) >= 18, (theme, 'group separation', distances)
        results[theme] = {'groups': [values[f'group-{i}'] for i in range(3)],
                          'minimumTextContrast': round(min(ratios), 2),
                          'pairwiseDeltaE76': [round(v, 2) for v in distances]}
    return results


if __name__ == '__main__':
    print(json.dumps(check(), indent=2))
