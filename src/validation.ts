import {BadRequestException} from '@nestjs/common';
import {z} from 'zod';
import {normalizePhone} from './domain.ts';

export function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (!result.success) throw new BadRequestException(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return result.data;
}

export const productSchema = z.object({
  sku: z.string().regex(/^[A-Z]{1,8}\d{1,8}$/),
  name: z.string().trim().min(2).max(100),
  price: z.number().int().min(1000).max(100_000_000),
  deposit: z.number().int().min(1000),
  stock: z.number().int().min(0).max(100000),
  active: z.boolean().default(true),
}).refine(v => v.deposit <= v.price, {message: 'Deposit cannot exceed price.'});
export const sessionSchema = z.object({
  title: z.string().trim().min(2).max(100),
  username: z.string().regex(/^[a-zA-Z0-9_.]{2,50}$/),
  currentProductId: z.string().nullable().default(null)
});
export const commentSchema = z.object({
  sessionId: z.string().min(1),
  eventId: z.string().min(1).max(200),
  text: z.string().min(1).max(1000),
  userId: z.string().min(1).max(100),
  handle: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  occurredAt: z.iso.datetime().optional()
});
export const detailsSchema = z.object({
  customerName: z.string().trim().min(2).max(100),
  phone: z.string().transform(normalizePhone).refine(v => v !== null, 'Valid Vietnamese phone required.'),
  address: z.string().trim().min(10).max(500), consent: z.literal(true)
});
export type CommentInput = z.infer<typeof commentSchema>;
