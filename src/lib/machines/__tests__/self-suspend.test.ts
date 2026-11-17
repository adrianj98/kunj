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

  it('never suspends while an agent works; a question that fails or hangs is not proof of use', async () => {
    const { s, watch, pass } = setup(true);
    await pass(90);
    expect(s.fired).toBe(0);
    watch.stop();
    for (const busy of [async () => Promise.reject(new Error('docker down')), () => new Promise<boolean>(() => {})]) {
      const fired = { n: 0 };
      const w = idleWatch({ idleMs: MIN, tickMs: MIN, busyTimeoutMs: 20, now: () => s.clock, busy, fire: async () => void fired.n++, log: () => {} });
      // one or two unanswered looks are a slow Docker, not an idle machine; the third in a row is
      for (let look = 1; look <= 3; look++) {
        s.clock += MIN;
        await w.tick();
        expect(fired.n).toBe(look === 3 ? 1 : 0);
      }
      w.stop();
    }
  });

  it('counts unanswered looks only within one quiet spell', async () => {
    const s = { clock: 0, fired: 0 };
    const w = idleWatch({ idleMs: 5 * MIN, tickMs: MIN, busyTimeoutMs: 20, now: () => s.clock, busy: async () => Promise.reject(new Error('slow')), fire: async () => void s.fired++, log: () => {} });
    const look = async () => {
      s.clock += MIN;
      await w.tick();
    };
    for (let i = 0; i < 6; i++) await look(); // idle at the 5th look: two unanswered questions
    expect(s.fired).toBe(0);
    w.touch(); // used again
    for (let i = 0; i < 6; i++) await look(); // a new spell: its first unanswered look must not be "the third"
    expect(s.fired).toBe(0);
    await look();
    expect(s.fired).toBe(1);
    w.stop();
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
