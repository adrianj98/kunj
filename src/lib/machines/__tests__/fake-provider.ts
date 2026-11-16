// An in-memory MachineProvider for unit tests, like FakeBackend for containers: machines and images
// live in maps, every call is recorded, and tests steer it through public fields.

import {
  Labels,
  Machine,
  MachineError,
  MachineImage,
  MachineProvider,
  MachineSize,
  MachineSpec,
  ProviderFeatures,
  TunnelSpec,
  isKunjMachine,
  labelsInclude,
  shapeOf,
} from '../provider';

export class FakeProvider implements MachineProvider {
  readonly name = 'fake';
  features: ProviderFeatures = { suspend: true, spot: true, images: true, diskSnapshots: false, selfSuspend: true };
  readonly machines = new Map<string, Machine>();
  readonly images_ = new Map<string, MachineImage>();
  readonly specs = new Map<string, MachineSpec>();
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  /** A method name that throws a provider-failed error */
  failOn: string | undefined;
  /** create() leaves the machine in this state (default running) */
  createState: Machine['state'] = 'running';
  private nextIp = 10;

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    if (this.failOn === method) throw new MachineError(`fake ${method} failed`, 'provider-failed');
  }

  methods(): string[] {
    return this.calls.map(c => c.method);
  }

  callsOf(method: string): Array<{ method: string; args: unknown[] }> {
    return this.calls.filter(c => c.method === method);
  }

  /** A machine kunj did not make (no kunj.role), for the "never touch it" rule. */
  addForeign(name: string, labels: Labels = { team: 'other' }): void {
    this.machines.set(name, { name, state: 'running', labels, size: 'n1', createdAt: new Date(0).toISOString(), addresses: { internal: '10.9.9.9' } });
  }

  setState(name: string, state: Machine['state']): void {
    const m = this.machines.get(name);
    if (!m) throw new Error(`no fake machine ${name}`);
    m.state = state;
  }

  private kunjOnly(name: string): Machine | undefined {
    const m = this.machines.get(name);
    if (m && !isKunjMachine(m)) throw new MachineError(`${name} was not created by kunj; it is left alone.`, 'machine-not-kunj');
    return m;
  }

  async list(filter: Labels): Promise<Machine[]> {
    this.record('list', filter);
    return [...this.machines.values()].filter(m => labelsInclude(m.labels, filter)).map(m => ({ ...m, labels: { ...m.labels } }));
  }

  async get(name: string): Promise<Machine | null> {
    this.record('get', name);
    const m = this.machines.get(name);
    return m ? { ...m, labels: { ...m.labels } } : null;
  }

  async create(spec: MachineSpec): Promise<Machine> {
    this.record('create', spec);
    if (this.machines.has(spec.name)) throw new MachineError(`A machine named ${spec.name} already exists.`, 'machine-exists');
    const m: Machine = {
      name: spec.name,
      state: this.createState,
      labels: { ...spec.labels },
      size: shapeOf(this, spec.size),
      zone: spec.zone ?? 'fake-zone',
      createdAt: new Date().toISOString(),
      addresses: { internal: `10.0.0.${this.nextIp++}` },
    };
    this.machines.set(spec.name, m);
    this.specs.set(spec.name, spec);
    return { ...m, labels: { ...m.labels } };
  }

  async suspend(name: string): Promise<void> {
    this.record('suspend', name);
    const m = this.kunjOnly(name);
    if (!m) throw new MachineError(`No machine named ${name}.`, 'machine-not-found');
    if (m.state !== 'suspended') m.state = this.features.suspend ? 'suspended' : 'stopped';
  }

  async resume(name: string): Promise<void> {
    this.record('resume', name);
    const m = this.kunjOnly(name);
    if (!m) throw new MachineError(`No machine named ${name}.`, 'machine-not-found');
    m.state = 'running';
  }

  async stop(name: string): Promise<void> {
    this.record('stop', name);
    const m = this.kunjOnly(name);
    if (!m) throw new MachineError(`No machine named ${name}.`, 'machine-not-found');
    m.state = 'stopped';
  }

  async start(name: string): Promise<void> {
    this.record('start', name);
    const m = this.kunjOnly(name);
    if (!m) throw new MachineError(`No machine named ${name}.`, 'machine-not-found');
    m.state = 'running';
  }

  async delete(name: string, opts: { disks: boolean }): Promise<void> {
    this.record('delete', name, opts);
    if (!this.kunjOnly(name)) return;
    this.machines.delete(name);
  }

  address(machine: Machine, port: number): { host: string; port: number } | null {
    return machine.addresses.internal ? { host: machine.addresses.internal, port } : null;
  }

  tunnel(machine: Machine, port: number, localPort: number): TunnelSpec {
    return { argv: ['fake-tunnel', machine.name, String(port), String(localPort)] };
  }

  images = {
    list: async (filter: Labels): Promise<MachineImage[]> => {
      this.record('images.list', filter);
      return [...this.images_.values()].filter(i => labelsInclude(i.labels, filter));
    },
    createFrom: async (machine: Machine, name: string, labels: Labels): Promise<MachineImage> => {
      this.record('images.createFrom', machine.name, name, labels);
      const image = { name, labels: { ...labels }, createdAt: new Date().toISOString() };
      this.images_.set(name, image);
      return image;
    },
    delete: async (name: string): Promise<void> => {
      this.record('images.delete', name);
      this.images_.delete(name);
    },
  };

  sizes(): MachineSize[] {
    return [
      { name: 'small', shape: 'fake-4', vcpus: 2, memoryGb: 4 },
      { name: 'medium', shape: 'fake-8', vcpus: 2, memoryGb: 8 },
      { name: 'large', shape: 'fake-16', vcpus: 4, memoryGb: 16 },
    ];
  }
}
