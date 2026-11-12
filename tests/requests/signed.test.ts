import { describe, expect, it } from 'vitest';
import { openSigned, SIGNATURE_LENGTH, signValue } from '../../lib/requests/signed';
import { STATE_SECRET } from '../fixtures';

const OTHER_SECRET = 'another test state secret, not a real one';

describe('a signed Slack value', () => {
  it('opens with the secret and kind it was signed with', () => {
    const value = signValue('pending', '{"a":1}', STATE_SECRET);
    expect(value).toHaveLength('{"a":1}'.length + SIGNATURE_LENGTH);
    expect(openSigned('pending', value, STATE_SECRET)).toBe('{"a":1}');
  });

  it('refuses an altered payload, another secret, another kind, or no signature', () => {
    const value = signValue('pending', '{"amount":950}', STATE_SECRET);
    expect(openSigned('pending', value.replace('950', '9500'), STATE_SECRET)).toBeNull();
    expect(openSigned('pending', value, OTHER_SECRET)).toBeNull();
    expect(openSigned('created', value, STATE_SECRET)).toBeNull();
    expect(openSigned('pending', '{"amount":950}', STATE_SECRET)).toBeNull();
    expect(openSigned('pending', `${'A'.repeat(43)}.{"amount":950}`, STATE_SECRET)).toBeNull();
    expect(openSigned('pending', '', STATE_SECRET)).toBeNull();
  });
});
