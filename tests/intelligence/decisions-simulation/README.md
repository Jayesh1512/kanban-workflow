This local Postman stand-in exercises the production native OpenAI Decisions
adapter over real HTTP. It uses only synthetic Cedar fixture data and a synthetic
key. It verifies transport/schema handling, not model classification quality.
The owner's published mock search was not used; the fixture follows the fetched
[official API reference](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create).

Run the simulation in one terminal:

```sh
postman simulation run tests/intelligence/decisions-simulation/decisions.sim.yaml --port 19395 --no-history --output ndjson
```

Run the caller in another terminal:

```sh
DECISIONS_SIMULATION_URL=http://127.0.0.1:19395 node --import tsx tests/intelligence/decisions-simulation/probe.ts
```

The caller must pass, and the simulation must log a POST `/v1/decisions` with HTTP
200. Stop this owned local simulation with Ctrl-C. No cloud publication, private
credential or personal service action is needed. Other paths return501 explicitly.
Failure/timeout/refusal/malformed distribution cases run in
`tests/intelligence/openai-decisions.test.ts`; durable provenance and pending-only
proposal behavior run in `tests/workflow/analysis.test.ts`.
