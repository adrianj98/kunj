// The machine-side idle timer (docs/specs/cloud-machines.md, "Idle"): a machine's own kunj serve
// suspends the machine when nothing has used it for a while. The coordinator's idle loop is the
// primary one; this is the fallback for a local coordinator whose laptop was shut, so it waits longer.
// Pure timing: the caller says what "busy" is and how to suspend.

export interface IdleWatchOptions {
  idleMs: number;
  /** How often to look (default one minute) */
  tickMs?: number;
  now?: () => number;
  /** How long the busy question may take before it counts as unanswered (default 30 s) */
  busyTimeoutMs?: number;
  /** An agent is working, or a terminal or stream is open: asked only once the quiet spell is long enough */
  busy(): Promise<boolean>;
  /** Suspends the machine; a failure is logged and tried again after another full spell */
  fire(): Promise<void>;
  log(line: string): void;
}

export interface IdleWatch {
  /** A request that is use (not the coordinator's own idle question) */
  touch(): void;
  /** One look; the timer calls it, tests call it directly */
  tick(): Promise<void>;
  stop(): void;
}

export function idleWatch(opts: IdleWatchOptions): IdleWatch {
  const now = opts.now ?? Date.now;
  const tickMs = opts.tickMs ?? 60_000;
  let lastUse = now();
  let lastTick = now();
  let running = false;
  let unanswered = 0;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const t = now();
      // The clock jumped: the machine slept between two looks. Whoever woke it is about to use it,
      // and the time asleep is not idle time
      if (t - lastTick > tickMs * 3) lastUse = t;
      lastTick = t;
      if (t - lastUse < opts.idleMs) return;
      // A question that fails or hangs (Docker wedged) is not proof of use, as for the coordinator's
      // loop: suspend keeps memory, and a machine nobody can ask must not bill for ever
      let timer: NodeJS.Timeout | undefined;
      const asked = await Promise.race([
        opts.busy().catch(() => undefined),
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), opts.busyTimeoutMs ?? 30_000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      // One slow answer is not an idle machine: only a question unanswered three looks in a row is
      if (asked === undefined && ++unanswered < 3) return;
      unanswered = 0;
      if (asked) {
        lastUse = now();
        return;
      }
      opts.log(`idle for ${Math.round((t - lastUse) / 60_000)} min with no agent working: suspending this machine`);
      lastUse = now();
      await opts.fire().catch(err => opts.log(`could not suspend this machine: ${(err as Error).message}`));
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), tickMs);
  timer.unref();
  return {
    touch: () => {
      lastUse = now();
    },
    tick,
    stop: () => clearInterval(timer),
  };
}
