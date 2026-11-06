import { describe, expect, it } from 'vitest';
import { applyMapping, guessMapping, IMPORT_TEMPLATE_HEADERS } from '../src';

// Wave 3: the optional Route column (the server places the address on that route).
describe('import Route column', () => {
  it('is recognised from common headers and passed through', () => {
    const headers = ['Customer name', 'Mobile', 'Area', 'Delivery notes', 'Rider route'];
    const mapping = guessMapping(headers);
    expect(mapping.route).toBe(4);
    expect(mapping.delivery_notes).toBe(3);
    const [row] = applyMapping([['Asha', '9861012345', 'Patia', 'Ring bell', 'North']], mapping);
    expect(row?.route).toBe('North');
  });

  it('is in the downloadable template, last so older sheets still line up', () => {
    expect(IMPORT_TEMPLATE_HEADERS.at(-1)).toBe('Route');
    expect(guessMapping(IMPORT_TEMPLATE_HEADERS).route).toBe(IMPORT_TEMPLATE_HEADERS.length - 1);
  });
});
