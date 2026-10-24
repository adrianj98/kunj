// Parse .env files for `kunj secret import`: KEY=value, `export KEY=`, single quotes (literal),
// double quotes (\n \" \\ escapes, may span lines), comments and blank lines. `${X}` is never
// expanded. Errors name the line the entry starts on.

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isSecretName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

export function parseDotenv(text: string): Array<{ name: string; value: string }> {
  const src = text.replace(/\r\n?/g, '\n');
  const result = new Map<string, string>();
  let pos = 0;
  let line = 1;

  const fail = (at: number, msg: string): never => {
    throw new Error(`line ${at}: ${msg}`);
  };
  const lineEnd = (from: number): number => {
    const nl = src.indexOf('\n', from);
    return nl === -1 ? src.length : nl;
  };
  // Advance to the start of the next line.
  const nextLine = (from: number): void => {
    const end = lineEnd(from);
    pos = end + 1;
    line++;
  };
  // After a closing quote only whitespace or a comment may follow.
  const finishQuoted = (from: number, start: number): void => {
    const end = lineEnd(from);
    const rest = src.slice(from, end);
    if (!/^[ \t]*(#.*)?$/.test(rest)) fail(start, `unexpected text after closing quote: ${rest.trim()}`);
    nextLine(from);
  };

  while (pos < src.length) {
    const start = line;
    const end = lineEnd(pos);
    const raw = src.slice(pos, end);
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      nextLine(pos);
      continue;
    }

    const eq = raw.indexOf('=');
    if (eq === -1) fail(start, 'expected NAME=value');
    let name = raw.slice(0, eq).trim();
    const exported = /^export[ \t]+(.*)$/.exec(name);
    if (exported) name = exported[1].trim();
    if (!isSecretName(name)) fail(start, `invalid name "${name}"`);

    let i = pos + eq + 1;
    while (src[i] === ' ' || src[i] === '\t') i++;
    const quote = src[i];

    if (quote === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) fail(start, 'unterminated single-quoted value');
      const value = src.slice(i + 1, close);
      line += countNewlines(value);
      result.set(name, value);
      finishQuoted(close + 1, start);
      continue;
    }

    if (quote === '"') {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < src.length) {
        const c = src[j];
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < src.length) {
          const n = src[j + 1];
          if (n === 'n') value += '\n';
          else if (n === '"' || n === '\\') value += n;
          else value += c + n;
          if (n === '\n') line++;
          j += 2;
          continue;
        }
        if (c === '\n') line++;
        value += c;
        j++;
      }
      if (!closed) fail(start, 'unterminated double-quoted value');
      result.set(name, value);
      finishQuoted(j + 1, start);
      continue;
    }

    // Unquoted: a comment starts at whitespace followed by '#'.
    let value = raw.slice(eq + 1);
    const comment = /[ \t]#/.exec(value);
    if (comment) value = value.slice(0, comment.index);
    result.set(name, value.trim());
    nextLine(pos);
  }

  return Array.from(result, ([name, value]) => ({ name, value }));
}

function countNewlines(s: string): number {
  let n = 0;
  for (const c of s) if (c === '\n') n++;
  return n;
}
