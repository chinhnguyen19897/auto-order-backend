// Run after compiling: node --test tests/order-checks-service.mjs
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import {OrdersService} from '../dist/orders.service.js';

const current = {
  id: 'order-1', status: 'AWAITING_PAYMENT', workflowStatus: 'NEEDS_MATCHING',
  zaloContact: null, phone: '0901234567', customerName: 'Buyer', address: '123 Main Street',
  issues: [], payments: []
};
const input = {workflowStatus: 'READY', zaloContact: 'Buyer on Zalo', issues: [], issueNote: null};
function service(order = current) {
  const writes = [];
  const tx = {order: {findUniqueOrThrow: async () => order, update: async args => writes.push(args)}};
  return {service: new OrdersService({$transaction: async fn => fn(tx)}, {}), writes};
}
test('ready and confirmed require a contact and resolved issues', async () => {
  for (const workflowStatus of ['READY', 'CONFIRMED']) {
    for (const changed of [{phone: ''}, {address: null}, {customerName: null}, {status: 'PAYMENT_REVIEW'}, {payments: [{status: 'RECONCILE'}]}]) {
      const {service: api, writes} = service({...current, ...changed});
      await assert.rejects(api.updateChecks(current.id, {...input, workflowStatus}), /Resolve missing/);
      assert.equal(writes.length, 0);
    }
    const {service: api} = service();
    await assert.rejects(api.updateChecks(current.id, {...input, workflowStatus, zaloContact: null}), /matched Zalo/);
    await assert.rejects(api.updateChecks(current.id, {...input, workflowStatus, issues: ['DUPLICATE']}), /Resolve missing/);
  }
});
test('invalid statuses, unknown fields and unexplained issues are rejected', async () => {
  const {service: api, writes} = service();
  await assert.rejects(api.updateChecks(current.id, {...input, workflowStatus: 'PAID'}));
  await assert.rejects(api.updateChecks(current.id, {...input, amountPaid: 1000}));
  await assert.rejects(api.updateChecks(current.id, {...input, workflowStatus: 'ZALO_MATCHED', issues: ['OTHER']}), /Describe/);
  assert.equal(writes.length, 0);
});
test('cancelled and expired orders cannot be marked ready', async () => {
  for (const status of ['CANCELLED', 'EXPIRED']) {
    const {service: api, writes} = service({...current, status});
    await assert.rejects(api.updateChecks(current.id, input), /Inactive/);
    assert.equal(writes.length, 0);
  }
});
test('saving checks changes only the check fields', async () => {
  const {service: api, writes} = service();
  assert.deepEqual(await api.updateChecks(current.id, input), {updated: true});
  assert.deepEqual(writes, [{where: {id: current.id}, data: input}]);
});
