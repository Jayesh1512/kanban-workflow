import type { ApplicationModule } from './shared/ports.js';
import { loadRuntimeConfig } from './platform/config.js';
import { createPlatformModule } from './platform/module.js';
import { createWorkflowModule } from './workflow/module.js';

/** All modules register before platform startup; workflow stops before platform ports close. */
export async function createModules(): Promise<ApplicationModule[]> {
  const config = await loadRuntimeConfig();
  const platform = await createPlatformModule(config);
  try {
    return [platform, await createWorkflowModule(platform.services)];
  } catch (error) {
    await platform.stop().catch(() => {});
    throw error;
  }
}
