/** Runs against a running demo API and a disposable PostgreSQL database.
 * Creates test records. Never point this at production. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import 'reflect-metadata';
config({ path: new URL('../.env', import.meta.url).pathname, quiet: true });
const base = process.env.INTEGRATION_API_URL || 'http://127.0.0.1:4000';
let cookie = '';
async function request(path, body, { expected = 200, auth = true, method = 'POST', headers = {} } = {}) {
  const res = await fetch(`${base}/${path}`, { method: body === undefined ? 'GET' : method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Action': '1', ...(auth && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json();
  assert.equal(res.status, expected, `${path}: ${JSON.stringify(data)}`);
  return { data, res };
}
const event = (sessionId, overrides = {}) => ({ sessionId, eventId: randomUUID(), text: 'A999 230k - 0901234567', userId: '10001', handle: 'test_buyer', displayName: 'Test Buyer', ...overrides });
const tokenFrom = order => new URL(order.checkoutUrl).pathname.split('/').at(-1);
test('API demo workflow, authentication, idempotence, payment balance and inventory', async t => {
  await request('admin/dashboard', undefined, { auth: false, expected: 401 });
  await request('auth/login', { email: process.env.ADMIN_EMAIL, password: 'incorrect-password' }, { auth: false, expected: 401 });
  const login = await request('auth/login', { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }, { expected: 201 });
  cookie = login.res.headers.get('set-cookie').split(';')[0];
  const initial = (await request('admin/dashboard')).data;
  assert.equal(initial.config.demo, true, 'Integration suite requires demo mode');
  const uniqueSku = `A${Date.now().toString().slice(-8)}`;
  const product = (await request('admin/products', { sku: uniqueSku, name: 'Integration shirt', price: 230000, deposit: 50000, stock: 2 }, { expected: 201 })).data;
  const session = (await request('admin/sessions', { title: 'Integration test', username: 'test_shop', currentProductId: product.id }, { expected: 201 })).data;
  const input = event(session.id, { text: `${uniqueSku} 230k - 0901234567` });
  const created = (await request('admin/comments/demo', input, { expected: 201 })).data;
  assert.equal(created.status, 'ORDERED');
  const replay = (await request('admin/comments/demo', input, { expected: 201 })).data;
  assert.equal(replay.replay, true); assert.equal(replay.order.id, created.order.id);
  const repeated = (await request('admin/comments/demo', { ...input, eventId: randomUUID() }, { expected: 201 })).data;
  assert.equal(repeated.status, 'DUPLICATE');
  const incomplete = (await request('admin/comments/demo', event(session.id, { text: '230k - 090xxxx', userId: '10002' }), { expected: 201 })).data;
  assert.equal(incomplete.status, 'REVIEW');
  const discussion = (await request('admin/comments/demo', event(session.id, { text: 'Hello everyone!', userId: '10002' }), { expected: 201 })).data;
  assert.equal(discussion.status, 'IGNORED');
  const dashboard = (await request('admin/dashboard')).data;
  const order = dashboard.orders.find(o => o.id === created.order.id);
  assert.equal(dashboard.products.find(p => p.id === product.id).stock, 1);
  assert.equal('tokenHash' in order, false); assert.equal('tokenEncrypted' in order, false);
  await request(`admin/products/${product.id}`, { sku: product.sku, name: product.name, price: product.price, deposit: product.deposit, stock: 2, active: true, expectedVersion: product.version }, { method: 'PATCH', expected: 409 });
  const token = tokenFrom(order);
  await request(`checkout/${'x'.repeat(43)}`, undefined, { auth: false, expected: 404 });
  const publicOrder = (await request(`checkout/${token}`, undefined, { auth: false })).data;
  assert.equal('phone' in publicOrder, false);
  await request(`checkout/${token}/payment`, { kind: 'deposit' }, { auth: false, expected: 409 });
  await request(`checkout/${token}/details`, { customerName: 'Test Buyer', phone: '0912345678', address: '123 Test Street, Hanoi', consent: true }, { auth: false, expected: 400 });
  await request(`checkout/${token}/details`, { customerName: 'Test Buyer', phone: '0901234567', address: '123 Test Street, Hanoi', consent: true }, { auth: false, expected: 201 });
  const deposit = (await request(`checkout/${token}/payment`, { kind: 'deposit' }, { auth: false, expected: 201 })).data;
  assert.equal(deposit.payment.amount, 50000); assert.match(deposit.payment.qrImage, /^data:image\/png/);
  const existing = (await request(`checkout/${token}/payment`, { kind: 'full' }, { auth: false, expected: 201 })).data;
  assert.equal(existing.payment.id, deposit.payment.id, 'Reuse outstanding link instead of double charging');
  const depositPaid = (await request(`checkout/${token}/demo-pay`, {}, { auth: false, expected: 201 })).data;
  assert.equal(depositPaid.status, 'DEPOSIT_PAID'); assert.equal(depositPaid.amountPaid, 50000);
  await request(`checkout/${token}/payment`, { kind: 'deposit' }, { auth: false, expected: 409 });
  const balance = (await request(`checkout/${token}/payment`, { kind: 'full' }, { auth: false, expected: 201 })).data;
  assert.equal(balance.payment.amount, 180000);
  const paid = (await request(`checkout/${token}/demo-pay`, {}, { auth: false, expected: 201 })).data;
  assert.equal(paid.status, 'PAID'); assert.equal(paid.amountPaid, 230000);
  await request(`checkout/${token}/demo-pay`, {}, { auth: false, expected: 409 });
  await request(`admin/orders/${order.id}/cancel`, {}, { expected: 409 });
  const second = (await request('admin/comments/demo', event(session.id, { text: `${uniqueSku} 230k - 0912345678`, userId: '10002' }), { expected: 201 })).data;
  assert.equal(second.status, 'ORDERED');
  const soldOut = (await request('admin/comments/demo', event(session.id, { text: `${uniqueSku} 230k - 0923456789`, userId: '10003' }), { expected: 201 })).data;
  assert.equal(soldOut.status, 'REVIEW');
  const secondView = (await request('admin/dashboard')).data.orders.find(o => o.id === second.order.id);
  const secondToken = tokenFrom(secondView);
  await request(`checkout/${secondToken}/details`, { customerName: 'Second Buyer', phone: '0912345678', address: '456 Test Street, Hanoi', consent: true }, { auth: false, expected: 201 });
  await request(`checkout/${secondToken}/payment`, { kind: 'deposit' }, { auth: false, expected: 201 });
  await request(`admin/orders/${second.order.id}/cancel`, {}, { expected: 201 });
  const { Db } = await import('../dist/db.js');
  const { OrdersService } = await import('../dist/orders.service.js');
  const { PaymentGateway } = await import('../dist/payments.js');
  const db = new Db();
  try {
    const service = new OrdersService(db, new PaymentGateway());
    const payment = await db.payment.findFirstOrThrow({ where: { orderId: second.order.id } });
    const receipt = { orderCode: payment.orderCode, amount: 50000, reference: randomUUID(), paymentLinkId: payment.paymentLinkId, currency: 'VND' };
    await service.applyReceipt(receipt);
    const duplicateReceipt = await service.applyReceipt(receipt);
    assert.equal(duplicateReceipt.duplicate, true);
    const late = await db.order.findUniqueOrThrow({ where: { id: second.order.id } });
    assert.equal(late.status, 'PAYMENT_REVIEW'); assert.equal(late.amountPaid, 50000); assert.equal(late.stockHeld, false);
    const unmatched = await service.applyReceipt({ orderCode: 987654321, amount: 3000, reference: randomUUID(), paymentLinkId: 'registration-test', currency: 'VND' });
    assert.equal(unmatched.unmatched, true);
  } finally { await db.$disconnect(); }

  const after = (await request('admin/dashboard')).data;
  assert.equal(after.products.find(p => p.id === product.id).stock, 1);
  await request('ingest/comments', event(session.id), { auth: false, expected: 401 });
  await request('webhooks/payos', { signature: 'invalid' }, { auth: false, expected: 400 });
  await request('admin/products', { sku: 'BAD1', name: 'Bad', price: 1000, deposit: 2000, stock: 1 }, { expected: 400 });
  await request(`admin/sessions/${session.id}`, { status: 'CLOSED' }, { method: 'PATCH' });
});
