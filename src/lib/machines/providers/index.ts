// The registered machine providers, by the name `machine.provider` gives. Each is loaded lazily, so
// a coordinator only imports the cloud it uses. registerProvider() adds one (tests, or a provider
// that lives outside this repository).

import { CliRunner } from '../cli';
import { MachineError, MachineProvider } from '../provider';

export interface ProviderDeps {
  /** How the provider runs its cloud CLI (tests give a fake) */
  run?: CliRunner;
}

/** `config` is the provider's own block, `machine.<name>` in the coordinator's config. */
export type ProviderFactory = (config: Record<string, unknown>, deps: ProviderDeps) => Promise<MachineProvider>;

const FACTORIES = new Map<string, ProviderFactory>([
  ['gce', async (config, deps) => new (await import('./gce')).GceProvider(config, deps)],
]);

export function registerProvider(name: string, factory: ProviderFactory): void {
  FACTORIES.set(name, factory);
}

export function unregisterProvider(name: string): void {
  FACTORIES.delete(name);
}

export function providerNames(): string[] {
  return [...FACTORIES.keys()].sort();
}

export async function createProvider(name: string, config: Record<string, unknown> = {}, deps: ProviderDeps = {}): Promise<MachineProvider> {
  if (!name) {
    throw new MachineError('No machine provider is configured. Set machine.provider (for example: kunj config --set machine.provider=gce --global) and its machine.<provider>.* settings.', 'machine-provider');
  }
  const factory = FACTORIES.get(name);
  if (!factory) throw new MachineError(`Unknown machine provider "${name}". Known: ${providerNames().join(', ')}.`, 'machine-provider');
  return factory(config, deps);
}
