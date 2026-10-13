# Architecture and business rules

The Next.js frontend proxies browser calls to NestJS through `/api/backend/*`. Administrator routes require an HttpOnly signed session cookie. Mutations require a custom request header and validate the browser Origin. Checkout routes use a 256-bit random bearer token. Only its hash and authenticated encrypted form are persisted; the encrypted copy is needed to deliver/recover private links.

The app never treats a public TikTok nickname as a real shipping name. The buyer confirms their information in checkout. Phone numbers posted in comments are unverified. Possession of the private checkout link grants order access; phone equality is not proof of phone ownership. Add OTP verification before offering customer account recovery or phone-based order search.

## Comment ingestion

TikTok collector → Redis `live-comments` queue → processing worker → PostgreSQL transaction.

The event adapter supports current v3 `common.msgId`, `content`, `user.id`, `user.displayId` fields plus older normalized names. IDs remain strings to avoid JavaScript integer precision loss. Events without a real event ID or handle are skipped rather than assigned fabricated identity. Missing stable numeric user IDs go to staff review.

`(sessionId,eventId)` is unique in the database. Comment capture, stock reservation, order creation and notification-outbox insertion happen in one serializable transaction. Stock is decremented with an atomic conditional update. Product edits require the version observed by the editor, so a concurrent reservation cannot be overwritten by stale stock. Serialization/uniqueness conflicts retry up to three times. Redis stores successfully queued events; it cannot recover TikTok events missed while disconnected or before a failed Redis enqueue. Monitor the stream connection and worker heartbeat during selling.

## Order lifecycle

- `AWAITING_DETAILS`: item reserved for 15 minutes; private checkout is ready.
- `AWAITING_PAYMENT`: buyer confirmed name, matching phone and address.
- `DEPOSIT_PAID`: deposit received; item remains allocated and balance can be paid.
- `PAID`: the full order total has been received.
- `CANCELLED` / `EXPIRED`: unpaid reservation is closed and its inventory released.
- `PAYMENT_REVIEW`: late, partial, excess, or otherwise unexpected transfer; staff accounting action needed.

Products store **available stock**, excluding units held by active or paid orders. Cancellation/expiry releases an unpaid reservation once. Paid orders cannot be cancelled through the simple cancellation action; refunds must be handled separately.

## Payments

The backend snapshots product price/deposit when creating the order. Customers cannot change totals. One outstanding payment link per order is created under a serializable transaction. If a pending deposit link exists, another request reuses it rather than creating a simultaneous full-payment link.

Deposit amount = max(0, deposit − already received). Balance/full amount = max(0, total − already received).

A durable local payment record and unique integer orderCode are written **before** calling payOS. An uncertain create response remains `RECONCILE`, preventing a second charge attempt. Staff can reconcile it through the dashboard: authenticated provider transactions are applied, or an unpaid link is closed before a replacement is allowed. If the provider cannot prove its state, the record remains blocked for manual investigation.

payOS signatures are verified by its official SDK. Unique transaction references prevent duplicate receipts. Amount, currency, payment code and available payment-link ID are checked. Signed unknown-code receipts are retained in an unmatched-receipt ledger and acknowledged, including provider registration tests. Receipts are kept even for unexpected transfers; such orders go to `PAYMENT_REVIEW`, never silently reclaiming released stock. Browser return/cancel URL parameters have no authority over payment status.

Remote links are cancelled before cancelling/releasing unpaid stock. Failure keeps the reservation held. Delayed verified transfers after stock release are recorded for manual accounting review.

## Notifications

The order transaction creates an outbox record. The worker scans it and submits jobs with a stable idempotency key. A gateway must deduplicate retries; exactly-once external delivery cannot be guaranteed without that contract. Demo delivery records `DEMO`, never `SENT`. Failed delivery remains visible in the dashboard; Resend creates a new record deliberately.

## Runtime boundaries

Next.js is an HTTP frontend, NestJS is the API, and a separate Node worker owns long-lived TikTok and BullMQ connections. Worker status updates every 5 seconds. The dashboard polls the backend every 5 seconds; no WebSocket dependency is needed for the starter.

This is a single-shop application. Never expose it as a multi-shop SaaS without tenant ownership checks on every data path and integration credential.
