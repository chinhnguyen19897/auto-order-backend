import type {CommentInput} from './validation.ts';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'bigint') return String(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}

/** Supports the installed v3 protobuf names and the older normalized payload.
 * Never coerce an unsafe numeric ID: lost digits could merge different buyers. */
export function normalizeTikTokEvent(sessionId: string, payload: unknown, now = Date.now()): CommentInput | null {
  const data = record(payload), user = record(data.user), common = record(data.common);
  const eventId = text(common.msgId || data.msgId);
  const id = text(user.id || user.userId);
  const handle = text(user.displayId || user.uniqueId);
  const content = text(data.content || data.comment);
  if (!eventId || eventId === '0' || !content || !handle) return null;
  const rawTime = Number(common.createTime || 0);
  const occurredAt = rawTime > 0 ? (rawTime < 1e12 ? rawTime * 1000 : rawTime) : now;
  return {
    sessionId, eventId, text: content, userId: /^[1-9]\d*$/.test(id) ? id : `handle:${handle}`,
    handle, displayName: text(user.nickname) || handle,
    occurredAt: new Date(Number.isFinite(occurredAt) && Math.abs(occurredAt) < 8.64e15 ? occurredAt : now).toISOString()
  };
}
