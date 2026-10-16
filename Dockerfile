FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY db/migrations ./db/migrations
RUN mkdir -p /data/telegram && chown node:node /data/telegram && \
    node --input-type=module -e 'import Database from "better-sqlite3"; import {TelegramClient} from "@mtcute/node"; const db=new Database(":memory:"); db.exec("CREATE TABLE native_probe(id INTEGER)"); db.close(); const tg=new TelegramClient({apiId:1,apiHash:"offline-build-probe",storage:":memory:"}); await tg.prepare(); await tg.destroy();'
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
