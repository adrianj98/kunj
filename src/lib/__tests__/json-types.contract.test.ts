import type { ContainerJson, EventJson } from '../json-types';

// Type-level checks: this file fails to compile when the published types lose these fields
test('ContainerJson.agent declares the hook state', () => {
  const agent: ContainerJson['agent'] = { running: true, state: 'waiting' };
  expect(agent.state).toBe('waiting');
});

test('the agent event may carry the repo', () => {
  const e: EventJson = { type: 'agent', session: 's', running: true, state: null, repo: { name: 'app', root: '/r' }, at: '' };
  expect(e.type).toBe('agent');
});
