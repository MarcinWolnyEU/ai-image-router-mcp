/**
 * Helpers that used to be duplicated per tool and are now shared: the aspect-ratio parser
 * (generate_image + the fal gateway) and the input → filename-stem rule (transform_media's
 * ICO unpack naming + build_icon_set's set name / variant labels). Pure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { aspectRatioValue, nearestAspectRatio } from '../src/util/aspect.js';
import { inputStem } from '../src/util/inputs.js';

describe('aspectRatioValue', () => {
  it('parses W:H to W/H', () => {
    assert.equal(aspectRatioValue('16:9'), 16 / 9);
    assert.equal(aspectRatioValue(' 4 : 3 '), 4 / 3);
  });
  it('is 1 for missing, unparseable, or zero-height ratios', () => {
    for (const r of [null, undefined, '', 'square', '3:0']) assert.equal(aspectRatioValue(r), 1, String(r));
  });
  it('parses decimal ratios (Krea 2.35:1, Seedream 9:19.5) instead of treating them as square', () => {
    assert.equal(aspectRatioValue('2.35:1'), 2.35);
    assert.equal(aspectRatioValue('9:19.5'), 9 / 19.5);
  });
});

describe('nearestAspectRatio', () => {
  it('picks the closest ratio on a log scale and skips non-ratios', () => {
    assert.equal(nearestAspectRatio(640 / 384, ['auto', '1:1', '3:2', '16:9']), '16:9');
    assert.equal(nearestAspectRatio(1, ['2:1', '1:2', '1:1']), '1:1');
    assert.equal(nearestAspectRatio(0.5, ['auto']), null);
  });
});

describe('inputStem', () => {
  it('is the filename without its extension for paths and URLs', () => {
    assert.equal(inputStem('C:\\icons\\favicon.ico'), 'favicon');
    assert.equal(inputStem('/tmp/app.icon.png'), 'app.icon');
    assert.equal(inputStem('https://example.com/a/b/logo.png?size=2'), 'logo');
  });
  it('is empty for inline data (data: URLs, raw base64) — callers choose their fallback', () => {
    assert.equal(inputStem('data:image/png;base64,iVBORw0KGgo='), '');
    assert.equal(inputStem('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'), '');
  });
});
