import {normalizePhone} from './domain.ts';

export const workflowStatuses = ['NEEDS_MATCHING', 'ZALO_MATCHED', 'READY', 'CONFIRMED'] as const;
export const issueCodes = ['MISSING_PHONE', 'MISSING_INFORMATION', 'DUPLICATE', 'OTHER'] as const;

type CheckableOrder = {
  status: string; workflowStatus: string; zaloContact: string | null; issues: string[];
  phone: string; customerName: string | null; address: string | null;
  payments: {status: string}[];
};

export function orderChecks(order: CheckableOrder) {
  const detected = [...order.issues];
  if (!normalizePhone(order.phone)) detected.push('MISSING_PHONE');
  if (!order.customerName?.trim() || !order.address?.trim()) detected.push('MISSING_INFORMATION');
  if (order.status === 'PAYMENT_REVIEW' || order.payments.some(p => ['REVIEW', 'RECONCILE'].includes(p.status))) detected.push('PAYMENT_REVIEW');
  const checkIssues = [...new Set(detected)];
  const inactive = ['CANCELLED', 'EXPIRED'].includes(order.status);
  const checkStatus = inactive ? order.status : checkIssues.length ? 'ISSUES' : !order.zaloContact?.trim() ? 'NEEDS_MATCHING' : order.workflowStatus;
  return {checkIssues, checkStatus};
}
