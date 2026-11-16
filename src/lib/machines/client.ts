// A client of a coordinator's /v1/machines routes, used by `kunj machine` (and, in phase 2, by
// `kunj ct` to locate a branch's machine). Errors come back as the MachineError the coordinator
// raised, so --json prints the same code.

import * as http from 'http';
import * as https from 'https';
import { ContainerError } from '../container/errors';
import type { InfoJson } from '../serve/protocol';
import type { MachineJson } from '../json-types';
import { Labels, MachineError, MachineErrorCode, MachineSize, ProviderFeatures } from './provider';

export interface MachineClientOptions {
  baseUrl: string;
  token: string;
  /** How the coordinator is called in messages */
  name: string;
}

export interface LocateBody {
  repo: string;
  repoName: string;
  branch: string;
  wake?: boolean;
  create?: boolean;
  size?: string;
}

export interface ProvidersJson {
  provider: string;
  features: ProviderFeatures;
  sizes: MachineSize[];
  network: 'private' | 'tunnel';
}

const MACHINE_CODES = new Set<string>([
  'machine-provider', 'machine-not-found', 'machine-ambiguous', 'machine-asleep', 'machine-exists', 'machine-not-kunj',
  'machine-create-failed', 'machine-token', 'machine-timeout', 'provider-cli-missing', 'provider-failed', 'bad-machine-config',
]);

export class MachineClient {
  constructor(readonly opts: MachineClientOptions) {}

  private request(method: string, route: string, body?: unknown): Promise<any> {
    const target = new URL(route, this.opts.baseUrl);
    const lib = target.protocol === 'https:' ? https : http;
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { authorization: `Bearer ${this.opts.token}` };
      if (data !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(data));
      }
      const req = lib.request(target, { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => {
          let parsed: any;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            return reject(new ContainerError(`${this.opts.name} answered HTTP ${res.statusCode}, but not as kunj serve.`, 'remote-unreachable'));
          }
          if (res.statusCode === 200) return resolve(parsed);
          if (res.statusCode === 401) return reject(new ContainerError(`${this.opts.name} refused the token.`, 'bad-remote'));
          const error = parsed?.error;
          const message = typeof error === 'object' ? error?.message : error;
          if (error?.code && MACHINE_CODES.has(error.code)) return reject(new MachineError(message, error.code as MachineErrorCode));
          reject(new MachineError(`${this.opts.name}: ${message ?? `HTTP ${res.statusCode}`}`, 'provider-failed'));
        });
        res.on('error', reject);
      });
      req.on('error', (err: NodeJS.ErrnoException) =>
        reject(new ContainerError(`${this.opts.name} is unreachable (${err.code ?? err.message}).`, 'remote-unreachable')));
      req.end(data);
    });
  }

  info(): Promise<InfoJson> {
    return this.request('GET', '/v1/info');
  }

  async list(filter: Labels = {}): Promise<MachineJson[]> {
    const params = new URLSearchParams();
    for (const k of Object.keys(filter).sort()) params.append('label', `${k}=${filter[k]}`);
    return (await this.request('GET', `/v1/machines${params.size ? `?${params}` : ''}`)).machines;
  }

  providers(): Promise<ProvidersJson> {
    return this.request('GET', '/v1/machines/providers');
  }

  locate(body: LocateBody): Promise<{ machine: MachineJson; created: boolean; woke: boolean }> {
    return this.request('POST', '/v1/machines/locate', body);
  }

  async action(name: string, verb: 'suspend' | 'resume' | 'stop' | 'start'): Promise<MachineJson> {
    return (await this.request('POST', `/v1/machines/${encodeURIComponent(name)}/${verb}`)).machine;
  }

  async delete(name: string, opts: { disks: boolean }): Promise<void> {
    await this.request('DELETE', `/v1/machines/${encodeURIComponent(name)}${opts.disks ? '' : '?disks=0'}`);
  }
}
