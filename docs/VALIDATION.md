# Validation of the two-project release

- Frontend and backend installed independently with their own package-lock.json.
- Both projects built and checked using **Node.js 22.12.0**, matching the reported Windows environment.
- All 20 backend unit tests passed with the explicit TypeScript stripping flag.
- The Node 22.12 seed command passed against the generated schema.
- The demo API integration workflow passed after the split.
- The standalone frontend served successfully, proxied administrator login/dashboard requests to the standalone backend, forwarded the HttpOnly cookie, and blocked access to connector-ingestion routes through its proxy.
- Lockfiles contain no npm workspace links or dependencies on the other project.

The API/seed integration used PGlite over a PostgreSQL wire-protocol test server. Native PostgreSQL, Redis/BullMQ runtime operation, Docker builds, live TikTok, real banking and Zalo/SMS delivery were not exercised here. Browser visual testing remains unavailable. External integration limits are documented in INTEGRATIONS.md.

Node 22.12 may print an ExperimentalWarning for type stripping; that warning is expected. Backend framework code is compiled with tsc before running and does not rely on runtime decorator stripping.
