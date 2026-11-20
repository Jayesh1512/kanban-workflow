import { beforeEach, expect, it, vi } from 'vitest';

const factories = vi.hoisted(() => ({ config: vi.fn(), platform: vi.fn(), workflow: vi.fn(), reply: vi.fn() }));
vi.mock('../src/platform/config.js', () => ({ loadRuntimeConfig: factories.config }));
vi.mock('../src/platform/module.js', () => ({ createPlatformModule: factories.platform }));
vi.mock('../src/workflow/module.js', () => ({ createWorkflowModule: factories.workflow }));
vi.mock('../src/reply/module.js', () => ({ createReplyModule: factories.reply }));
import { createModules } from '../src/composition.js';

beforeEach(() => { vi.resetAllMocks(); });

it('composes workflow and reply over the same platform services without starting any module', async () => {
  const config = {}, services = {};
  const platform = { name: 'platform', services, start: vi.fn(), stop: vi.fn() };
  const workflow = { name: 'workflow', start: vi.fn() };
  const reply = { name: 'reply', start: vi.fn() };
  factories.config.mockResolvedValue(config);
  factories.platform.mockResolvedValue(platform);
  factories.workflow.mockResolvedValue(workflow);
  factories.reply.mockResolvedValue(reply);
  expect(await createModules()).toEqual([platform, workflow, reply]);
  expect(factories.platform).toHaveBeenCalledWith(config);
  expect(factories.workflow).toHaveBeenCalledWith(services);
  expect(factories.reply).toHaveBeenCalledWith(services);
  expect(platform.start).not.toHaveBeenCalled();
  expect(workflow.start).not.toHaveBeenCalled();
  expect(reply.start).not.toHaveBeenCalled();
});

it('closes the constructed platform if module construction fails and preserves that failure', async () => {
  const failure = new Error('Workflow construction failed');
  const stop = vi.fn().mockRejectedValue(new Error('Cleanup also failed'));
  factories.config.mockResolvedValue({});
  factories.platform.mockResolvedValue({ services: {}, stop });
  factories.workflow.mockRejectedValue(failure);
  await expect(createModules()).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledOnce();
});
