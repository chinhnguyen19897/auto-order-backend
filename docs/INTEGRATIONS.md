# External integrations

## TikTok LIVE

The worker uses `tiktok-live-connector` 2.5.x, an **unofficial** reverse engineering project. It connects to the username selected for each active session. `processInitialData:false` avoids treating recent history as fresh orders; real message IDs protect against replay. If a signing-service key is needed, use `TIKTOK_SIGN_API_KEY` on the worker only.

The adapter was checked against the installed library's v3 protobuf types, rather than assuming its README's older flattened payload examples still apply. `tiktok-event.ts` is the narrow place to update when upstream fields change.

Only comment reading is implemented. There is no automatic TikTok private message or public posting of buyer links. A missed event during a TikTok outage cannot be recovered reliably from this library. Keep manual order entry/review procedures available and verify the connector on the actual seller account before using it during a paid sale.

Repository/docs: https://github.com/zerodytrash/TikTok-Live-Connector

## Banking QR with payOS

1. Create an eligible payOS account/channel and configure its receiving bank account.
2. Add `PAYOS_CLIENT_ID`, `PAYOS_API_KEY` and `PAYOS_CHECKSUM_KEY` to API environment secrets.
3. Set `PAYMENT_PROVIDER=payos`. The installed official SDK is `@payos/node` 2.x.
4. Register an externally reachable HTTPS webhook at `https://YOUR_API_DOMAIN/webhooks/payos` using payOS's channel configuration/SDK. This endpoint is on the API service, not the frontend proxy.
5. Set `WEB_URL` to the actual frontend URL; both return and cancel URLs lead back to the private checkout.
6. Perform a controlled real-provider transaction and confirm the signed webhook, amount, reference and order update before rollout.

Signed receipts with an unknown order code are persisted as unmatched bank receipts and acknowledged with 2xx, so provider registration tests can complete without losing accounting evidence. They appear under Integrations in the seller dashboard. Registration-test receipts may appear there; review them against the provider records. Repeated references are deduplicated.

The server verifies with `payos.webhooks.verify()`. It never trusts a screenshot, browser redirect, or user-supplied `paid=true` value. QR images are rendered locally from the SDK-returned QR payload. No third-party QR image service receives checkout data.

Uncertain creation is recoverable through the administrator Reconcile action. Already-paid, partial, excess and late transfers need accounting review; no automatic refund is implemented.

Docs: https://payos.vn/docs/api/
SDK: https://github.com/payOSHQ/payos-lib-node

## Zalo / SMS notification gateway

This source includes the app-side transport, outbox and retries. It does **not** include a working business-account-specific Zalo template sender or arbitrary Zalo profile search.

Zalo's current OA docs describe ZBS approved template messages sent by phone number or OA user ID. Ordinary OA messaging requires the applicable user interaction and messaging permissions. Obtain the required business-account credentials, eligible template and permissions, then implement the gateway against that approved API. You may also use an SMS provider in the same gateway.

Set:

```dotenv
NOTIFICATION_PROVIDER=webhook
NOTIFICATION_WEBHOOK_URL=https://your-messaging-gateway.example/send-order
NOTIFICATION_WEBHOOK_SECRET=<a-random-secret-at-least-32-characters>
```

The API/worker sends:

```json
{
  "id": "notification-id",
  "phone": "0901234567",
  "orderCode": "AO1234567890",
  "checkoutUrl": "https://your-app.example/checkout/<private-token>",
  "amount": 50000
}
```

Headers:

- `Idempotency-Key`: notification ID
- `X-Timestamp`: Unix milliseconds
- `X-Signature`: hex HMAC-SHA256 over `<timestamp>.<exact-raw-JSON-body>`

The gateway must:

1. Verify signature with a constant-time comparison and reject stale timestamps.
2. Atomically deduplicate the idempotency key; retry delivery of an already-sent request must not send another message.
3. Enforce the messaging provider's consent/eligibility/template rules.
4. Map the approved template parameters to the order code, amount and private checkout URL.
5. Respond with 2xx only after accepting delivery durably; return a failure for rejected requests.
6. Avoid logging full phone numbers, private checkout tokens, or credentials.

Demo mode consumes the outbox and records `DEMO` without making a network request. Provider success means the gateway accepted delivery; final handset-delivery callbacks are an extension point.

Zalo docs: https://oa.zalo.me/home/documents/vie/guides/tong-quan-cac-loai-tin-nhan-tren-zalo-official-account-_3651713298729094511

## Identity and shipping details

TikTok ID, TikTok handle, Zalo OA UID and phone number are different identifiers. Do not infer one from another. The checkout collects shipping details from the buyer and requires a matching comment phone. An optional Zalo interaction flow can link a verified OA UID later. The starter does not retrieve a buyer's address from TikTok or Zalo.
