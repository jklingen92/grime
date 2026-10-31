import { describe, expect, it } from 'vitest';
import {
  IMAGE_DEFAULTS,
  buildLut,
  formatSliderVal,
  isDirty,
  isIdentity,
  slidersToParams,
} from '../src/viewer/state/imageParams.js';

describe('slidersToParams', () => {
  it('maps defaults to identity params', () => {
    const p = slidersToParams(IMAGE_DEFAULTS);
    expect(p).toMatchObject({ brightness: 0, contrast: 1, gamma: 1, black: 0, white: 255 });
    expect(isIdentity(p)).toBe(true);
  });

  it('scales percent sliders and renames rotateFine', () => {
    const p = slidersToParams({ ...IMAGE_DEFAULTS, brightness: 25, contrast: 150, rotateFine: 1.5 });
    expect(p.brightness).toBe(0.25);
    expect(p.contrast).toBe(1.5);
    expect(p.rotate_fine).toBe(1.5);
  });

  it('keeps white above black', () => {
    expect(slidersToParams({ ...IMAGE_DEFAULTS, black: 200, white: 100 }).white).toBe(201);
  });

  it('passes threshold through as an int, or null when disabled', () => {
    expect(slidersToParams({ ...IMAGE_DEFAULTS, threshold: '128' }).threshold).toBe(128);
    expect(slidersToParams(IMAGE_DEFAULTS).threshold).toBeNull();
  });

  it('is not identity once any adjustment is set', () => {
    for (const patch of [{ grayscale: true }, { invert: true }, { sharpen: true }, { rotate90: 1 }, { threshold: 10 }, { gamma: 120 }]) {
      expect(isIdentity(slidersToParams({ ...IMAGE_DEFAULTS, ...patch }))).toBe(false);
    }
  });
});

describe('buildLut', () => {
  const lut = (patch) => buildLut(slidersToParams({ ...IMAGE_DEFAULTS, ...patch })).split(' ').map(Number);

  it('has 256 entries and is the identity ramp by default', () => {
    const l = lut({});
    expect(l).toHaveLength(256);
    expect(l[0]).toBe(0);
    expect(l[255]).toBe(1);
    expect(l[128]).toBeCloseTo(128 / 255, 3);
  });

  it('clamps values below black and above white', () => {
    const l = lut({ black: 50, white: 200 });
    expect(l[10]).toBe(0);
    expect(l[250]).toBe(1);
  });

  it('brightness shifts and clamps', () => {
    const l = lut({ brightness: 100 });
    expect(l[0]).toBe(1);
  });
});

describe('isDirty', () => {
  it('detects differences and ignores falsy boolean variants', () => {
    expect(isDirty(IMAGE_DEFAULTS, { ...IMAGE_DEFAULTS })).toBe(false);
    expect(isDirty({ ...IMAGE_DEFAULTS, grayscale: undefined }, IMAGE_DEFAULTS)).toBe(false);
    expect(isDirty({ ...IMAGE_DEFAULTS, black: 5 }, IMAGE_DEFAULTS)).toBe(true);
    expect(isDirty({ ...IMAGE_DEFAULTS, threshold: 0 }, IMAGE_DEFAULTS)).toBe(true);
  });
});

describe('formatSliderVal', () => {
  it('formats per key', () => {
    expect(formatSliderVal('contrast', 150)).toBe('1.50');
    expect(formatSliderVal('gamma', 80)).toBe('0.80');
    expect(formatSliderVal('brightness', 10)).toBe('+10');
    expect(formatSliderVal('brightness', -10)).toBe('-10');
    expect(formatSliderVal('black', 12)).toBe('12');
  });
});
