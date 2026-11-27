import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { desc, eq, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { IdParams, PromoInput, PromoListView, PromoPatch, PromoView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { promo, promoUse } from '../../shared/db/schema/index.js';
import { audit } from '../../shared/audit.js';
import { ref } from '../../shared/db/sql.js';
import { requireStaff } from '../../shared/auth/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';

/** Админка промокодов (ТЗ §2, §9, §11). Любое изменение — в журнал. */

const tags = ['admin'];
const sec = [{ bearer: [] }];

const view = (p: typeof promo.$inferSelect, uses: number): z.infer<typeof PromoView> => ({
  id: p.id,
  code: p.code,
  brand: p.brand,
  type: p.type,
  value: p.value,
  audience: p.audience,
  per_customer_limit: p.perCustomerLimit,
  budget_dirams: p.budgetDirams,
  spent_dirams: p.spentDirams,
  valid_from: p.validFrom?.toISOString() ?? null,
  valid_to: p.validTo?.toISOString() ?? null,
  uses,
});

function validate(type: string, value: number) {
  if (type === 'percent' && (value < 1 || value > 100)) throw new AppError('VALIDATION', 'Процент скидки — от 1 до 100');
  if (type === 'fixed' && value < 1) throw new AppError('VALIDATION', 'Фиксированная скидка — в дирамах, больше 0');
}

export async function registerPromoAdmin(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/admin/promos', { schema: { tags, security: sec, response: { 200: PromoListView } } }, async (req) => {
    requireStaff(req.principal, 'promo.write');
    const rows = await deps.db
      .select({ p: promo, uses: sql<number>`(select count(*)::int from ${promoUse} where ${promoUse.promoId} = ${ref(promo.id)})` })
      .from(promo)
      .orderBy(desc(promo.createdAt));
    return { promos: rows.map((x) => view(x.p, x.uses)) };
  });

  r.post('/admin/promos', { schema: { tags, security: sec, body: PromoInput, response: { 201: PromoView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'promo.write');
    const b = req.body;
    validate(b.type, b.value);
    const p = await deps.db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: promo.id }).from(promo).where(eq(promo.code, b.code));
      if (dup) throw new AppError('VALIDATION', 'Промокод с таким кодом уже есть');
      const [p] = await tx
        .insert(promo)
        .values({
          code: b.code,
          brand: b.brand,
          type: b.type,
          value: b.type === 'free_delivery' ? 0 : b.value,
          audience: b.audience,
          perCustomerLimit: b.per_customer_limit,
          budgetDirams: b.budget_dirams,
          validFrom: b.valid_from ? new Date(b.valid_from) : null,
          validTo: b.valid_to ? new Date(b.valid_to) : null,
        })
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'promo.create', objectType: 'promo', objectId: p!.id, after: b });
      return p!;
    });
    return reply.status(201).send(view(p, 0));
  });

  r.patch('/admin/promos/:id', { schema: { tags, security: sec, params: IdParams, body: PromoPatch, response: { 200: PromoView } } }, async (req) => {
    const me = requireStaff(req.principal, 'promo.write');
    const { reason, ...b } = req.body;
    return deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(promo).where(eq(promo.id, req.params.id)).for('update');
      if (!before) throw notFound('Промокод', req.params.id);
      validate(b.type ?? before.type, b.value ?? before.value);
      if (b.budget_dirams != null && b.budget_dirams < before.spentDirams) throw new AppError('VALIDATION', 'Бюджет меньше уже потраченного', { spent: before.spentDirams });
      const [p] = await tx
        .update(promo)
        .set({
          ...(b.brand !== undefined && { brand: b.brand }),
          ...(b.type !== undefined && { type: b.type }),
          ...(b.value !== undefined && { value: b.value }),
          ...(b.audience !== undefined && { audience: b.audience }),
          ...(b.per_customer_limit !== undefined && { perCustomerLimit: b.per_customer_limit }),
          ...(b.budget_dirams !== undefined && { budgetDirams: b.budget_dirams }),
          ...(b.valid_from !== undefined && { validFrom: b.valid_from ? new Date(b.valid_from) : null }),
          ...(b.valid_to !== undefined && { validTo: b.valid_to ? new Date(b.valid_to) : null }),
        })
        .where(eq(promo.id, before.id))
        .returning();
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'promo.update', objectType: 'promo', objectId: p!.id, before, after: b, reason });
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(promoUse).where(eq(promoUse.promoId, p!.id));
      return view(p!, n);
    });
  });
}
