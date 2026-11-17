import { idleWatch } from '../self-suspend';

describe('the machine-side idle timer', () => {
  const MIN = 60_000;
  const setup = (busy = false) => {
    const s = { clock: 0, busy, fired: 0, log: [] as string[] };
    const watch = idleWatch({
      idleMs: 30 * MIN,
      tickMs: MIN,
      now: () => s.clock,
      busy: async () => s.busy,
      fire: async () => void s.fired++,
      log: l => s.log.push(l),
    });
    const pass = async (minutes: number) => {
      for (let i = 0; i < minutes; i++) {
        s.clock += MIN;
        await watch.tick();
      }
    };
    return { s, watch, pass };
  };

  it('suspends after a quiet spell, once, and a use starts the spell again', async () => {
    const { s, watch, pass } = setup();
    await pass(29);
    expect(s.fired).toBe(0);
    watch.touch();
    await pass(29);
    expect(s.fired).toBe(0);
    await pass(1);
    expect(s.fired).toBe(1);
    expect(s.log[0]).toMatch(/idle for 30 min/);
    await pass(5);
    expect(s.fired).toBe(1);
    watch.stop();
  });

  it('never suspends while an agent works, and a busy check that fails counts as busy', async () => {
    const { s, watch, pass } = setup(true);
    await pass(90);
    expect(s.fired).toBe(0);
    const failing = idleWatch({ idleMs: MIN, tickMs: MIN, now: () => s.clock, busy: async () => Promise.reject(new Error('docker down')), fire: async () => void s.fired++, log: () => {} });
    s.clock += 10 * MIN;
    await failing.tick();
    expect(s.fired).toBe(0);
    watch.stop();
    failing.stop();
  });

  it('does not count the time the machine slept as idle time', async () => {
    const { s, watch, pass } = setup();
    await pass(20);
    s.clock += 8 * 60 * MIN; // suspended overnight, then woken
    await watch.tick();
    expect(s.fired).toBe(0);
    await pass(29);
    expect(s.fired).toBe(0);
    await pass(1);
    expect(s.fired).toBe(1);
    watch.stop();
  });
});
