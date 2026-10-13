# API reference

Browser route prefix: `/api/backend/` on the Next.js origin. Direct API URL in development: `http://localhost:4000`.

Use JSON bodies. Browser mutations send `X-Admin-Action: 1`; administrator requests also carry the `ao_session` cookie. The API deliberately has no permissive CORS configuration. Success POSTs normally return 201; GET/PATCH return 200.

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/login` | `{email,password}` → HttpOnly session cookie |
| POST | `/auth/logout` | Clear session cookie |
| GET | `/admin/dashboard` | Recent records, metrics, provider status |
| POST | `/admin/products` | `{sku,name,price,deposit,stock,active}` |
| PATCH | `/admin/products/:id` | Replace editable fields; include `expectedVersion` from the dashboard |
| POST | `/admin/sessions` | `{title,username,currentProductId}` |
| PATCH | `/admin/sessions/:id` | `{status?,currentProductId?}` |
| POST | `/admin/comments/demo` | Submit a normalized comment in demo mode |
| POST | `/admin/comments/:id/resolve` | `{productId,phone}` → staff-confirmed draft |
| POST | `/admin/comments/:id/ignore` | Dismiss a review/duplicate comment |
| POST | `/admin/orders/:id/notify` | Add notification to outbox |
| POST | `/admin/orders/:id/cancel` | Cancel unpaid order and release stock |
| POST | `/admin/payments/:id/reconcile` | Inspect provider; apply receipts or close unpaid link |
| GET | `/checkout/:token` | Minimal order view; phone is masked |
| POST | `/checkout/:token/details` | `{customerName,phone,address,consent:true}` |
| POST | `/checkout/:token/payment` | `{kind:"deposit"|"full"}` → QR view |
| POST | `/checkout/:token/demo-pay` | Simulate receipt, demo provider only |
| POST | `/ingest/comments` | Authenticated connector ingestion |
| GET | `/ingest/sessions` | Active session list for external collectors |
| POST | `/ingest/sessions/:id/heartbeat` | Connector status and sanitized error |
| POST | `/webhooks/payos` | Official signed provider webhook |
| GET | `/health` | Database connectivity check |

Ingestion endpoints require `Authorization: Bearer <INGEST_SECRET>` and are not exposed through the frontend proxy. The bundled worker processes comments through the same service directly; these endpoints also support a separate collector.

Normalized comment body:

```json
{
  "sessionId": "your-session-id",
  "eventId": "provider-event-id-as-string",
  "text": "A12 - 230k - 0901234567",
  "userId": "9876543210987654321",
  "handle": "buyer_handle",
  "displayName": "Buyer",
  "occurredAt": "2026-10-12T15:00:00.000Z"
}
```

Keep IDs as strings. Use the provider's event ID so reconnect/retry deliveries can be deduplicated. Future timestamps are rejected; events older than two minutes require staff confirmation.

Error envelope: `{ "message": "human-readable error" }`. Typical statuses: 400 invalid data, 401 missing/invalid session, 403 invalid request origin, 404 unknown record/token, 409 state/stock/payment conflict, 410 checkout token expired, 429 rate limit. Checkout tokens expire after seven days.

Dashboard lists the newest 100 orders/comments/notifications and 30 sessions. Metrics are global. Add cursor pagination/export routes for larger deployments.
