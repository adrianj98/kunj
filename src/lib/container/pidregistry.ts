// A JSON list of records owned by background kunj processes (auto forwarders, MCP bridges), each
// with the pid that owns it. Records of dead processes are pruned on read.
import * as fs from 'fs';
import * as path from 'path';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface PidRegistry<T extends { pid: number }> {
  /** The live records; entries of dead processes are pruned (and the file rewritten without them). */
  read(file?: string): T[];
  /** Written to a temp file and renamed, so concurrent writers never see a half-written file. */
  write(records: T[], file?: string): void;
  update(change: (records: T[]) => T[], file?: string): T[];
}

export function pidRegistry<T extends { pid: number }>(defaultFile: () => string, isRecord: (r: any) => r is T): PidRegistry<T> {
  const write = (records: T[], file: string = defaultFile()): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
    fs.renameSync(tmp, file);
  };
  const read = (file: string = defaultFile()): T[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return [];
    }
    const valid = (r: any): r is T => !!r && Number.isInteger(r.pid) && r.pid > 0 && isRecord(r);
    const live = Array.isArray(parsed) ? parsed.filter(valid).filter(r => isAlive(r.pid)) : [];
    if (live.length !== (Array.isArray(parsed) ? parsed.length : -1)) {
      try {
        write(live, file);
      } catch {
        // read-only home: the pruned list is still right for this caller
      }
    }
    return live;
  };
  return { read, write, update: (change, file = defaultFile()) => {
    const next = change(read(file));
    write(next, file);
    return next;
  } };
}
