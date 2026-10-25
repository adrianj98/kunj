import { CHANNEL, ServeError, decodeFrame, encodeFrame, labelQuery, parseControl, parseLabelQuery } from '../protocol';
import { frameWriter } from '../streams';
import type WebSocket from 'ws';
import { loadOrCreateToken, rotateToken, tokenMatches } from '../token';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('frames', () => {
  it('round-trips a channel and its bytes', () => {
    const frame = encodeFrame(CHANNEL.stdout, Buffer.from([0, 255, 10]));
    expect(decodeFrame(frame)).toEqual({ channel: 1, data: Buffer.from([0, 255, 10]) });
  });

  it('encodes an EOF as a bare channel byte', () => {
    const frame = encodeFrame(CHANNEL.stdin, '');
    expect(frame).toEqual(Buffer.from([0]));
    expect(decodeFrame(frame).data.length).toBe(0);
  });

  it('refuses an empty frame and an unknown channel', () => {
    expect(() => decodeFrame(Buffer.alloc(0))).toThrow(ServeError);
    expect(() => decodeFrame(Buffer.from([7, 1]))).toThrow(/unknown channel 7/);
  });
});

describe('frameWriter', () => {
  it('swallows a write after end instead of raising an uncaught error (a late pty byte must not end kunj serve)', async () => {
    const sent: Buffer[] = [];
    const ws = { readyState: 1, send: (b: Buffer, _o: unknown, cb: (e?: Error) => void) => (sent.push(b), setTimeout(cb, 20)) } as unknown as WebSocket;
    const writer = frameWriter(ws, CHANNEL.stdout);
    writer.write('a');
    writer.end();
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    try {
      writer.write('late');
      await new Promise(r => setTimeout(r, 100));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
    expect(sent.map(b => b.toString('latin1'))).toEqual(['\u0001a']);
  });
});

describe('control frames', () => {
  it('parses exit, error and resize', () => {
    expect(parseControl('{"exit":3}')).toEqual({ exit: 3 });
    expect(parseControl('{"error":"timeout"}')).toEqual({ error: 'timeout' });
    expect(parseControl('{"resize":{"cols":80,"rows":24}}')).toEqual({ resize: { cols: 80, rows: 24 } });
  });

  it('refuses junk and a zero-sized resize', () => {
    expect(() => parseControl('nope')).toThrow(/not JSON/);
    expect(() => parseControl('[]')).toThrow(ServeError);
    expect(() => parseControl('{"resize":{"cols":0,"rows":24}}')).toThrow(/unknown control/);
  });
});

describe('label queries', () => {
  it('round-trips labels, including an any-value filter and = in values', () => {
    const labels = { 'kunj.repo': 'a=b', 'kunj.branch': '', 'kunj.managed': 'true' };
    const query = labelQuery(labels);
    expect(parseLabelQuery(new URLSearchParams(query))).toEqual(labels);
  });

  it('refuses a filter without a key', () => {
    expect(() => parseLabelQuery(new URLSearchParams('label==v'))).toThrow(/key=value/);
  });
});

describe('tokens', () => {
  it('matches only the same token', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true);
    expect(tokenMatches('abd', 'abc')).toBe(false);
    expect(tokenMatches('ab', 'abc')).toBe(false);
    expect(tokenMatches(undefined, 'abc')).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
  });

  it('creates a 0600 token file once and rotates it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kunj-token-'));
    const file = path.join(dir, 'serve', 'token');
    const first = loadOrCreateToken(file);
    expect(first.created).toBe(true);
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = loadOrCreateToken(file);
    expect(again).toEqual({ token: first.token, created: false });
    const rotated = rotateToken(file);
    expect(rotated).not.toBe(first.token);
    expect(loadOrCreateToken(file).token).toBe(rotated);
    fs.rmSync(dir, { recursive: true });
  });
});
