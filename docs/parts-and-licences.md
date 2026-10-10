# Installed parts and licences — I1

Local project source has no granted project licence. Node.js26.4.0 supplies local runtime/crypto/HTTPS/SQLite/test facilities (Node MIT and bundled third-party notices; SQLite public domain). Product storage uses node:sqlite. No inference runtime/weights are installed.

Official OpenAI and TypeSafe Jev are hosted services, neither asserted open-source/self-hosted. SDK licensing does not grant rights to the hosted models/services or establish retention. [OpenAI decision](/Users/jys/Documents/Projects/hello/.context/decisions/2026-10-10-openai-cloud-llm.md), [Jev decision](/Users/jys/Documents/Projects/hello/.context/decisions/2026-10-10-jev-swimlane-decisions.md). Keys/model access/quality/latency/cost remain unverified.

The tables enumerate the recursively resolved installed dependency/optional-dependency closure from root package.json and each installed package.json on2026-10-10. All versions are lockfile-pinned; package licence declarations/notices and executable/source files live at `node_modules/.pnpm/<package>@<version>.../node_modules/<package>/`. Direct packages are linked under node_modules. This is install/licence evidence, not C1's behavioral source audit or [U] traffic observation.

## Production closure

| Installed part | Version | Declared licence |
|---|---|---|
| `@fuman/io` | 0.0.21 | MIT |
| `@fuman/net` | 0.0.21 | MIT |
| `@fuman/node` | 0.0.21 | MIT |
| `@fuman/utils` | 0.0.21 | MIT |
| `@hono/node-server` | 2.1.4 | MIT |
| `@modelcontextprotocol/core` | 2.3.1 | Apache-2.0 |
| `@modelcontextprotocol/hono` | 2.0.2 | Apache-2.0 |
| `@modelcontextprotocol/server` | 2.3.1 | Apache-2.0 |
| `@mtcute/core` | 0.32.4 | MIT |
| `@mtcute/file-id` | 0.32.0 | MIT |
| `@mtcute/html-parser` | 0.32.4 | MIT |
| `@mtcute/markdown-parser` | 0.32.4 | MIT |
| `@mtcute/node` | 0.32.4 | MIT |
| `@mtcute/tl-runtime` | 0.32.0 | MIT |
| `@mtcute/wasm` | 0.32.0 | MIT |
| `@types/events` | 3.0.0 | MIT |
| `base64-js` | 1.5.1 | MIT |
| `better-sqlite3` | 12.11.1 | MIT |
| `bindings` | 1.5.0 | MIT |
| `bl` | 4.1.0 | MIT |
| `buffer` | 5.7.1 | MIT |
| `chownr` | 1.1.4 | ISC |
| `decompress-response` | 6.0.0 | MIT |
| `deep-extend` | 0.6.0 | MIT |
| `detect-libc` | 2.1.2 | Apache-2.0 |
| `dom-serializer` | 2.0.0 | MIT |
| `domelementtype` | 2.3.0 | BSD-2-Clause |
| `domhandler` | 5.0.3 | BSD-2-Clause |
| `domutils` | 3.2.2 | BSD-2-Clause |
| `end-of-stream` | 1.4.5 | MIT |
| `entities` | 4.5.0 | BSD-2-Clause |
| `entities` | 7.0.1 | BSD-2-Clause |
| `expand-template` | 2.0.3 | (MIT OR WTFPL) |
| `file-uri-to-path` | 1.0.0 | MIT |
| `fs-constants` | 1.0.0 | MIT |
| `github-from-package` | 0.0.0 | MIT |
| `hono` | 4.13.13 | MIT |
| `htmlparser2` | 10.1.0 | MIT |
| `ieee754` | 1.2.1 | BSD-3-Clause |
| `inherits` | 2.0.4 | ISC |
| `ini` | 1.3.8 | ISC |
| `long` | 5.3.2 | Apache-2.0 |
| `mimic-response` | 3.1.0 | MIT |
| `minimist` | 1.2.8 | MIT |
| `mkdirp-classic` | 0.5.3 | MIT |
| `napi-build-utils` | 2.0.0 | MIT |
| `node-abi` | 3.98.0 | MIT |
| `once` | 1.4.0 | ISC |
| `openai` | 7.31.0 | Apache-2.0 |
| `prebuild-install` | 7.1.3 | MIT |
| `pump` | 3.0.4 | MIT |
| `rc` | 1.2.8 | (BSD-2-Clause OR MIT OR Apache-2.0) |
| `readable-stream` | 3.6.2 | MIT |
| `safe-buffer` | 5.2.1 | MIT |
| `semver` | 7.8.5 | ISC |
| `simple-concat` | 1.0.1 | MIT |
| `simple-get` | 4.0.1 | MIT |
| `string_decoder` | 1.3.0 | MIT |
| `strip-json-comments` | 2.0.1 | MIT |
| `tar-fs` | 2.1.5 | MIT |
| `tar-stream` | 2.2.0 | MIT |
| `tunnel-agent` | 0.6.0 | Apache-2.0 |
| `util-deprecate` | 1.0.2 | MIT |
| `wrappy` | 1.0.2 | ISC |
| `zod` | 4.6.5 | MIT |

## Additional development/test closure

| Installed part | Version | Declared licence |
|---|---|---|
| `@biomejs/biome` | 2.5.15 | MIT OR Apache-2.0 |
| `@biomejs/cli-darwin-arm64` | 2.5.15 | MIT OR Apache-2.0 |
| `@modelcontextprotocol/client` | 2.3.1 | Apache-2.0 |
| `@types/node` | 26.4.0 | MIT |
| `@typescript/typescript-darwin-arm64` | 7.0.2 | Apache-2.0 |
| `cross-spawn` | 7.0.6 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `isexe` | 2.0.0 | ISC |
| `jose` | 6.2.12 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `typescript` | 7.0.2 | Apache-2.0 |
| `undici-types` | 8.3.0 | MIT |
| `which` | 2.0.2 | ISC |

App source that handles runtime content includes contracts/auth/store/log/ingest/board/graph/agent/web/MCP/purge/connectors; feature bodies remain at their named stream gates. Hono renders content locally; Zod validates it; MCP core/server/hono serializes permitted content. OpenAI SDK7.31.0 transports bounded general payloads; node:https transports bounded Jev movement. SDK constructor/request options were read at node_modules/openai/src/client.ts and src/resources/responses/responses.ts; explicit server key/fixed baseURL/maxRetries0/no redirects are tested. No provider inference was called.

Mtcute node/core/html-parser/markdown-parser0.32.4, wasm/file-id/tl-runtime0.32.0 and fuman io/net/node/utils0.0.21 are installed for C1's source/import audit. better-sqlite3's native build is skipped; product use requires MemoryStorage, with session strings exported and sealed. Importing TelegramClient from @mtcute/node succeeded without building better-sqlite3. C1 must read all relevant request/dynamic/transport paths before a real-account procedure is accepted; this document does not invent that finding.

Official independent @modelcontextprotocol/client2.3.1 is DEVELOPMENT ONLY, matching core/server2.3.1. Imported Client/StreamableHTTPClientTransport constructors were verified; documented definitions are in node_modules/@modelcontextprotocol/client/dist/index.d.mts. Independent connection/tool-list/every-tool evidence remains P1/E2, never established by this import or the raw foundation HTTP helper.
