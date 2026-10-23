// The host MCP bridge (kunj ct mcp) with a fake stdio MCP server on the host, through the built CLI.
// Opt-in: npm run test:functional.
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import type { ContainerListJson } from '../../src/lib/json-types';
import { USER, describeFunctional, docker, useFixture, waitFor } from './harness';

// A stdio MCP server: initialize, a tools/list with an allowed tool, a tool with a path argument and a
// refused tool, and tools/call echoing the tool's name. It also records every request it gets.
const FAKE_SERVER = `
const fs = require('fs');
const log = process.argv[2];
const tools = [
  { name: 'navigate_page', inputSchema: { type: 'object', properties: { url: { type: 'string' }, type: { type: 'string' } } } },
  { name: 'take_screenshot', inputSchema: { type: 'object', properties: { format: { type: 'string' }, filePath: { type: 'string' } } } },
  { name: 'upload_file', inputSchema: { type: 'object', properties: { uid: { type: 'string' }, filePath: { type: 'string' } }, required: ['uid', 'filePath'] } },
];
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  fs.appendFileSync(log, line + '\\n');
  if (m.id === undefined) return;
  let result;
  if (m.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
  else if (m.method === 'tools/list') result = { tools };
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'called ' + m.params.name }] };
  else result = {};
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});
`;

const SOCKET = '/run/kunj-mcp/chrome.sock';

describeFunctional('kunj ct (functional): MCP bridge', () => {
  const ctx = useFixture('mcp');

  describe('kunj ct mcp', () => {
    it('bridges a host stdio server into the container: tools filtered, paths and upload_file refused', async () => {
      const { fx } = ctx;
      const branch = 'ft-mcp';
      const script = path.join(fx.scratch, 'fake-mcp.js');
      const requests = path.join(fx.scratch, 'fake-mcp.log');
      fs.writeFileSync(script, FAKE_SERVER);
      fx.writeConfig({ container: { mcp: { chrome: { command: process.execPath, args: [script, requests] } } } });
      const started = await fx.start(branch);
      const container = started.names.container;

      const bridge = fx.spawn(['ct', 'mcp', branch]);
      await waitFor(() => {
        try {
          docker(['exec', '-u', USER, container, 'test', '-S', SOCKET]);
          return true;
        } catch {
          return false;
        }
      }, 'the MCP socket in the container', 60_000);

      // The container's Claude Code is pointed at the socket
      const claude = JSON.parse(docker(['exec', '-u', USER, container, 'sh', '-c', 'cat "$HOME/.claude.json"']));
      expect(claude.mcpServers.chrome).toEqual({ command: 'socat', args: ['-', `UNIX-CONNECT:${SOCKET}`] });

      // One session per connection, from inside the container as its user
      const ask = async (msg: object): Promise<any> => {
        const line = JSON.stringify(msg).replace(/'/g, `'\\''`);
        let reply = '';
        await waitFor(async () => {
          const r = await fx.sh(branch, `(printf '%s\\n' '${line}'; sleep 1) | socat - UNIX-CONNECT:${SOCKET}`);
          reply = r.stdout.trim();
          return reply !== '';
        }, 'a reply over the MCP socket', 30_000);
        return JSON.parse(reply.split('\n').pop()!);
      };

      const listed = await ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const tools = listed.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>;
      expect(tools.map(t => t.name)).toEqual(['navigate_page', 'take_screenshot']);
      expect(Object.keys(tools.find(t => t.name === 'take_screenshot')!.inputSchema.properties)).toEqual(['format']);

      const allowed = await ask({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'take_screenshot', arguments: { format: 'png' } } });
      expect(allowed).toEqual({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'called take_screenshot' }] } });

      const withPath = await ask({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'take_screenshot', arguments: { filePath: '/tmp/x.png' } } });
      expect(withPath).toMatchObject({ id: 3, error: { code: -32602 } });
      const upload = await ask({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'upload_file', arguments: { uid: '1' } } });
      expect(upload).toMatchObject({ id: 4, error: { code: -32602 } });

      // The refused calls never reached the host server
      const seen = fs.readFileSync(requests, 'utf8');
      expect(seen).toContain('"tools/list"');
      expect(seen).not.toContain('upload_file');
      expect(seen).not.toContain('filePath');

      const list = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(list.containers.find(c => c.branch === branch)?.bridges).toEqual([{ name: 'chrome', pid: bridge.pid }]);

      await bridge.stop();
      const after = await fx.kunjJson<ContainerListJson>(['ct', 'list']);
      expect(after.containers.find(c => c.branch === branch)?.bridges).toEqual([]);
    });
  });
});
