import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  if (process.env.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production.');
  for (const product of [
    { sku: 'A12', name: 'Vintage cotton shirt', price: 230000, deposit: 50000, stock: 12 },
    { sku: 'B07', name: 'Relaxed denim jacket', price: 390000, deposit: 100000, stock: 6 },
    { sku: 'C03', name: 'Canvas shoulder bag', price: 230000, deposit: 50000, stock: 8 },
  ]) await db.product.upsert({ where: { sku: product.sku }, update: {}, create: product });
  const product = await db.product.findUniqueOrThrow({ where: { sku: 'A12' } });
  const existing = await db.liveSession.findFirst({ where: { username: 'your_shop', status: 'ACTIVE' } });
  if (!existing) await db.liveSession.create({ data: { title: 'Evening vintage drop', username: 'your_shop', currentProductId: product.id, connectionStatus: 'DEMO' } });
  console.log('Seed complete. Add comments using the dashboard simulator.');
} finally { await db.$disconnect(); }
