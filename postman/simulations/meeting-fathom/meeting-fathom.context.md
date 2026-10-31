# Fathom contract simulation

The local mock follows the published Fathom List meetings contract, checked
26 October 2026. Its single response uses the synthetic repository fixture;
no private recordings or real API keys are required. Unknown routes return 501.

Start from the repository root:

```sh
postman simulation run postman/simulations/meeting-fathom/meeting-fathom.sim.yaml --port 19482 --output ndjson --no-history
npx tsx tests/meetings/fathom-simulation.ts
```

On 26 October 2026 the actual Fathom client passed: GET
`/fathom/external/v1/meetings`, synthetic `X-Api-Key`, all four content inclusion
flags, creation bounds and no unsupported page-size query. The simulation log
recorded HTTP 200; the smoke script verified all four transcript segments and
both action items. `FATHOM_SIM_BASE_URL` can override the local address.

Live activation on 26 October 2026 established that the last page may return
`next_cursor: ""`. The mock now reproduces that response, and the actual client
normalizes it to null. The simulation and targeted HTTP/pagination tests passed
after the fix; a missing cursor is still rejected.

This proves the local HTTP contract path. Pagination, rate limiting, webhook
signatures, task writes and PostgreSQL concurrency have separate Vitest tests.
The configured live key was separately verified against Fathom and the first
30-day scan imported three meetings. This simulation does not establish actual
webhook delivery or authenticated Hermes configuration. Stop the simulation
with Ctrl-C when finished; it is not needed to run the application or demo.
