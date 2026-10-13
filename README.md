# Auto Order Backend

Standalone NestJS / TypeScript project. Owns the API, PostgreSQL schema, payOS integration, notification outbox and persistent TikTok/BullMQ worker.

```bash
npm ci
npm run setup
docker compose up -d --wait
npm run db:migrate
npm run db:seed
npm run dev
```

Node 22.12+ is supported. The seed runs with --experimental-strip-types. API port: 4000. Login credentials and all integration secrets are in .env; never commit that file.

- `npm run dev`: compile, watch TypeScript, run API and worker.
- `npm run dev:api`: run just the API and compiler watcher.
- `npm run worker:dev`: run worker against existing dist output; build first.
- `npm run build`: generate Prisma client and compile API/worker.
- `npm start`: run compiled API.
- `npm run worker`: run compiled persistent worker.
- `npm test`: run unit tests.
- `npm run test:integration`: test a running demo API; creates records.
- `npm run db:migrate`: deploy committed migrations.
- `npm run db:push`: development-only schema sync; excludes custom SQL constraints.

Configure WEB_URL to the frontend's exact browser origin. No permissive CORS is needed because the frontend proxies requests through its own server. Direct connector ingestion uses INGEST_SECRET; payOS webhooks go directly to /webhooks/payos.

For production, deploy API and worker as separate processes/services, inject database/Redis/provider secrets, set real providers and DEMO_MODE=false. Do not place the persistent worker in a short-lived serverless function.

If copied into its own Git repository, retain the included docs directory. This project's .github workflow checks Node 22.12 builds/tests independently.
