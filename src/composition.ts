import type { ApplicationModule } from './shared/ports.js';
import { loadRuntimeConfig } from './platform/config.js';
import { createPlatformModule } from './platform/module.js';

/** Canonical runtime composition; workflow is added after its bounded implementation handoff. */
export async function createModules(): Promise<ApplicationModule[]> {
  const config = await loadRuntimeConfig();
  return [await createPlatformModule(config)];
}
