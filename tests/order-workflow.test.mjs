import test from 'node:test';
import assert from 'node:assert/strict';
import {orderChecks} from '../src/order-workflow.ts';

const order = {
  status: 'AWAITING_PAYMENT', workflowStatus: 'NEEDS_MATCHING', zaloContact: null,
  phone: '0901234567', customerName: 'Buyer', address: '123 Main Street', issues: [], payments: []
};
test('complete unmatched orders need a Zalo match', () => {
  assert.deepEqual(orderChecks(order), {checkStatus: 'NEEDS_MATCHING', checkIssues: []});
});
test('missing details are detected without hiding missing phone', () => {
  assert.deepEqual(orderChecks({...order, phone: '', address: null}), {
    checkStatus: 'ISSUES', checkIssues: ['MISSING_PHONE', 'MISSING_INFORMATION']
  });
});
test('payment changes preserve the independent ready workflow', () => {
  for (const status of ['AWAITING_PAYMENT', 'DEPOSIT_PAID', 'PAID']) {
    assert.equal(orderChecks({...order, status, workflowStatus: 'READY', zaloContact: 'Buyer Zalo'}).checkStatus, 'READY');
  }
});
test('new payment review overrides a previously ready order', () => {
  const ready = {...order, workflowStatus: 'READY', zaloContact: 'Buyer Zalo'};
  assert.equal(orderChecks({...ready, payments: [{status: 'RECONCILE'}]}).checkStatus, 'ISSUES');
  assert.deepEqual(orderChecks({...ready, status: 'PAYMENT_REVIEW'}).checkIssues, ['PAYMENT_REVIEW']);
});
test('manual duplicate flags are deduplicated and clear when resolved', () => {
  assert.deepEqual(orderChecks({...order, issues: ['DUPLICATE', 'DUPLICATE']}), {checkStatus: 'ISSUES', checkIssues: ['DUPLICATE']});
  assert.equal(orderChecks({...order, issues: []}).checkStatus, 'NEEDS_MATCHING');
});
test('inactive orders stay inactive even with unresolved issues', () => {
  for (const status of ['EXPIRED', 'CANCELLED']) assert.equal(orderChecks({...order, status, phone: ''}).checkStatus, status);
});
