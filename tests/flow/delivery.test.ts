import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeliveryIo, processDelivery } from '../../lib/flow/delivery';
import { fakeWorld } from '../../lib/flow/fakes';
import { loadFixture } from '../fixtures';

const ARRIVED = new Date('2026-11-12T08:30:00Z');

function setup(overrides: Partial<DeliveryIo> = {}) {
  const { email, reading } = loadFixture('single-amount');
  const world = fakeWorld({ reading });
  const io: DeliveryIo = {
    fetchEmail: async () => email,
    allowSender: () => true,
    ready: async () => world.deps,
    ...overrides,
  };
  return { world, io, email };
}

describe('handling an accepted email delivery', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the email and sends the approval cards', async () => {
    const { world, io } = setup();
    expect(await processDelivery('em_0001', ARRIVED, io)).toBe('carded');
    expect(world.chat.cards).toHaveLength(1);
    expect(world.chat.alerts).toHaveLength(0);
  });

  it('drops an email from a sender over the hourly limit, without telling anyone', async () => {
    const { world, io } = setup({ allowSender: () => false });
    expect(await processDelivery('em_0001', ARRIVED, io)).toBe('sender-limited');
    expect(world.chat.cards).toHaveLength(0);
    expect(world.chat.alerts).toHaveLength(0);
  });

  it('tells the admins when an email could not be read, with only the time and the email id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { world, io, email } = setup({
      fetchEmail: async () => {
        throw new Error('Resend GET /emails/receiving failed: 500');
      },
    });
    expect(await processDelivery('em_0001', ARRIVED, io)).toBe('failed-notified');
    expect(world.chat.alerts).toEqual([
      {
        admins: world.deps.settings.adminSlackIds,
        text: 'An email arrived at 2026-11-12 08:30 UTC and could not be read. Check the inbox. (Email id: em_0001)',
      },
    ]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).not.toContain(email.from.address);
  });

  it('also tells the admins when the flow itself fails after the email was read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { world, io } = setup();
    world.deps.extract = async () => {
      throw new Error('model unavailable');
    };
    expect(await processDelivery('em_0001', ARRIVED, io)).toBe('failed-notified');
    expect(world.chat.alerts).toHaveLength(1);
  });

  it('logs and stops when telling the admins fails too', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { world, io } = setup({
      fetchEmail: async () => {
        throw new Error('down');
      },
    });
    world.chat.postAlert = async () => {
      throw new Error('slack down');
    };
    expect(await processDelivery('em_0001', ARRIVED, io)).toBe('failed-silent');
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[1][0])).toContain('failed to tell the admins');
  });
});
