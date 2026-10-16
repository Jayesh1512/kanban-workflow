<img src="assets/icon.svg" width="64" height="64" alt="">

# kanban

Created in [T3 Code](https://t3.codes).

AntSeed backend foundation: TypeScript, Fastify and PostgreSQL.

```sh
npm ci
npm run check
npm start
```

The M0 server exposes `/health/live` (200) and `/health/ready` (503 while domain
modules are unconfigured). See [the architecture and builder integration
contract](docs/ARCHITECTURE.md) and [the project brief](docs/PROJECT_BRIEF.md).
