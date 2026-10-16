import type { ApplicationModule } from './shared/ports.js';

/** Architect/PM-owned integration seam. M1/M3 add the two explicit factories here. */
export async function createModules(): Promise<ApplicationModule[]> {
  return [];
}
