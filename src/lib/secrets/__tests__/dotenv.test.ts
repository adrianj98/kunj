import { parseDotenv, isSecretName, NAME_PATTERN } from '../dotenv';

describe('parseDotenv', () => {
  const one = (text: string): string => {
    const entries = parseDotenv(text);
    expect(entries).toHaveLength(1);
    return entries[0].value;
  };

  it.each([
    ['A=1', 'A', '1'],
    ['export B=2', 'B', '2'],
    ["C='x # y'", 'C', 'x # y'],
    ['D="a\\nb"', 'D', 'a\nb'],
    ['E="line1\nline2"', 'E', 'line1\nline2'],
    ['F=val # comment', 'F', 'val'],
    ['G=${HOME}', 'G', '${HOME}'],
    ['H=', 'H', ''],
    ['J="say \\"hi\\" \\\\ # = x"', 'J', 'say "hi" \\ # = x'],
    ["K='a=b \"c\"'", 'K', 'a=b "c"'],
    ['L="a#b"', 'L', 'a#b'],
    ['M=a#b', 'M', 'a#b'],
    ['N = spaced ', 'N', 'spaced'],
  ])('%s', (text, name, value) => {
    expect(parseDotenv(text)).toEqual([{ name, value }]);
    expect(one(text)).toBe(value);
  });

  it('skips blank lines and comments', () => {
    expect(parseDotenv('\n# comment\n   \nA=1\n  # indented\n')).toEqual([{ name: 'A', value: '1' }]);
  });

  it('handles CRLF line endings', () => {
    expect(parseDotenv('A=1\r\nB="x"\r\n')).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: 'x' },
    ]);
  });

  it('rejects an unterminated double-quoted value, naming its line', () => {
    expect(() => parseDotenv('I="unterminated')).toThrow(/line 1/);
    expect(() => parseDotenv('A=1\nI="unterminated\nmore')).toThrow(/line 2/);
  });

  it('rejects an unterminated single-quoted value', () => {
    expect(() => parseDotenv("A='open")).toThrow(/line 1/);
  });

  it('rejects a bad name', () => {
    expect(() => parseDotenv('1X=y')).toThrow(/line 1/);
    expect(() => parseDotenv('A=1\nA-B=2')).toThrow(/line 2/);
  });

  it('rejects a line without =', () => {
    expect(() => parseDotenv('JUSTANAME')).toThrow(/line 1/);
  });

  it('rejects trailing text after a closing quote', () => {
    expect(() => parseDotenv('A="x" y')).toThrow(/line 1/);
    expect(parseDotenv('A="x" # ok')).toEqual([{ name: 'A', value: 'x' }]);
  });

  it('keeps the last of duplicate names', () => {
    expect(parseDotenv('A=1\nB=2\nA=3')).toEqual([
      { name: 'A', value: '3' },
      { name: 'B', value: '2' },
    ]);
  });

  it('counts lines inside multi-line values for later errors', () => {
    expect(() => parseDotenv('E="a\nb"\n1X=y')).toThrow(/line 3/);
  });
});

describe('isSecretName', () => {
  it('accepts shell names only', () => {
    expect(isSecretName('A_1')).toBe(true);
    expect(isSecretName('_x')).toBe(true);
    expect(isSecretName('A-1')).toBe(false);
    expect(isSecretName('1A')).toBe(false);
    expect(isSecretName('')).toBe(false);
    expect(NAME_PATTERN.test('A_1')).toBe(true);
  });
});
