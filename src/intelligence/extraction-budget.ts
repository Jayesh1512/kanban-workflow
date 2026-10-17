/** Extend large imported contexts only; keep a fixed bound and covering lease. */
export const LARGE_EXTRACTION_TIMEOUT_MS=180000;
export function extractionTimeoutMs(configured:number,promptLength:number):number{
  return promptLength>=48000?Math.max(configured,LARGE_EXTRACTION_TIMEOUT_MS):configured;
}
