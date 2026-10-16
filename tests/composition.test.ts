import { beforeEach, expect, it, vi } from 'vitest';

const factories = vi.hoisted(() => ({ config: vi.fn(), platform: vi.fn(), workflow: vi.fn() }));
vi.mock('../src/platform/config.js', () => ({ loadRuntimeConfig: factories.config }));
vi.mock('../src/platform/module.js', () => ({ createPlatformModule: factories.platform }));
vi.mock('../src/workflow/module.js', () => ({ createWorkflowModule: factories.workflow }));
import { createModules } from '../src/composition.js';

beforeEach(() => { vi.resetAllMocks(); });

it('composes workflow over the same platform services without starting either module', async () => {
  const config = {}, services = {};
  const platform = { name: 'platform', services, start: vi.fn(), stop: vi.fn() };
  const workflow = { name: 'workflow', start: vi.fn() };
  factories.config.mockResolvedValue(config);
  factories.platform.mockResolvedValue(platform);
  factories.workflow.mockResolvedValue(workflow);
  expect(await createModules()).toEqual([platform, workflow]);
  expect(factories.platform).toHaveBeenCalledWith(config);
  expect(factories.workflow).toHaveBeenCalledWith(services);
  expect(platform.start).not.toHaveBeenCalled();
  expect(workflow.start).not.toHaveBeenCalled();
});

it('closes the constructed platform if workflow construction fails and preserves that failure', async () => {
  const failure = new Error('Workflow construction failed');
  const stop = vi.fn().mockRejectedValue(new Error('Cleanup also failed'));
  factories.config.mockResolvedValue({});
  factories.platform.mockResolvedValue({ services: {}, stop });
  factories.workflow.mockRejectedValue(failure);
  await expect(createModules()).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledOnce();
});
