import * as vscode from 'vscode';

/**
 * An output channel that keeps only its last `maxLines` lines. Every kunj call appends a line, so
 * a window left open for days would otherwise grow the channel without end. When it reaches
 * `maxLines` the oldest quarter is dropped and the channel's text replaced with the rest.
 */
export class CappedOutputChannel implements vscode.OutputChannel {
  private lines: string[] = [];
  /** Text appended without a newline yet (`append`) */
  private partial = '';

  constructor(private readonly channel: vscode.OutputChannel, private readonly maxLines = 1000) {}

  get name(): string {
    return this.channel.name;
  }

  append(value: string): void {
    this.channel.append(value);
    this.track(value);
  }

  appendLine(value: string): void {
    this.channel.appendLine(value);
    this.track(value + '\n');
  }

  replace(value: string): void {
    this.channel.replace(value);
    this.lines = [];
    this.partial = '';
    this.track(value);
  }

  clear(): void {
    this.channel.clear();
    this.lines = [];
    this.partial = '';
  }

  show(columnOrPreserveFocus?: vscode.ViewColumn | boolean, preserveFocus?: boolean): void {
    if (typeof columnOrPreserveFocus === 'boolean' || columnOrPreserveFocus === undefined) {
      this.channel.show(columnOrPreserveFocus);
    } else {
      this.channel.show(columnOrPreserveFocus, preserveFocus);
    }
  }

  hide(): void {
    this.channel.hide();
  }

  dispose(): void {
    this.channel.dispose();
  }

  private track(text: string): void {
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop() ?? '';
    this.lines.push(...parts);
    if (this.lines.length < this.maxLines) return;
    this.lines = this.lines.slice(this.lines.length - Math.floor(this.maxLines * 0.75));
    this.channel.replace(this.lines.join('\n') + '\n' + this.partial);
  }
}
