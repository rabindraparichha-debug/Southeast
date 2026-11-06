import { describe, expect, it } from 'vitest';
import { compareVersions, isUpdateRequired, parseVersion } from '../src';

describe('app versions', () => {
  it('parses dotted numeric versions', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion(' v2.0 ')).toEqual([2, 0]);
    expect(parseVersion('1')).toEqual([1]);
    expect(parseVersion('1.2.x')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it('compares numerically, not as text', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.0', '1.2.1')).toBe(-1);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
    expect(compareVersions('junk', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', 'junk')).toBe(1);
  });

  it('requires an update only below a readable minimum', () => {
    expect(isUpdateRequired('1.0.0', '1.2.0')).toBe(true);
    expect(isUpdateRequired('1.2.0', '1.2.0')).toBe(false);
    expect(isUpdateRequired('1.3.0', '1.2.0')).toBe(false);
    expect(isUpdateRequired('1.0.0', null)).toBe(false);
    expect(isUpdateRequired('1.0.0', '')).toBe(false);
    expect(isUpdateRequired('1.0.0', 'soon')).toBe(false);
    expect(isUpdateRequired(undefined, '1.0.0')).toBe(true);
  });
});
