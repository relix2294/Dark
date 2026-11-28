import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { asc, eq } from 'drizzle-orm';
import type { StaffRole } from '@dark/contracts';
import { IdParams, StaffInput, StaffListView, StaffPatch, StaffQuery, StaffView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import type { Tx } from '../../shared/db/client.js';
import { authAttempt, userStaff } from '../../shared/db/schema/index.js';
import { audit } from '../../shared/audit.js';
import { hashPin, requireStaff } from '../../shared/auth/index.js';
import { AppError, notFound } from '../../shared/errors/index.js';
import { ensureCourier } from '../dispatch/index.js';

/**
 * Персонал и роли (ТЗ §9): админ — все точки и роли; управляющий — только своя точка и роли ниже себя.
 * Изменение роли и блокировка — в журнал. PIN в ответах не возвращается никогда.
 */

const tags = ['admin'];
const sec = [{ bearer: [] }];
const MANAGER_CAN_GRANT: StaffRole[] = ['picker', 'cook', 'courier', 'shift_lead'];
const STORE_ROLES: StaffRole[] = ['picker', 'cook', 'courier', 'shift_lead', 'manager'];

const view = (u: typeof userStaff.$inferSelect) => ({ id: u.id, phone: u.phone, name: u.name, role: u.role, store_id: u.storeId, is_active: u.isActive, dc_user_id: u.dcUserId });

function assertCanManage(me: { role: StaffRole; store_id: string | null }, role: StaffRole, storeId: string | null) {
  if (STORE_ROLES.includes(role) && !storeId) throw new AppError('VALIDATION', `Роль ${role} требует точку`);
  if (me.role === 'admin') return;
  if (!MANAGER_CAN_GRANT.includes(role)) throw new AppError('FORBIDDEN', `Управляющий не назначает роль ${role}`);
  if (storeId !== me.store_id) throw new AppError('FORBIDDEN', 'Только своя точка');
}

/** Один кошелёк DC — один сотрудник: иначе выплата уйдёт не тому. */
async function assertWalletFree(tx: Tx, dcUserId: string, selfId: string | null) {
  const [other] = await tx.select({ id: userStaff.id }).from(userStaff).where(eq(userStaff.dcUserId, dcUserId));
  if (other && other.id !== selfId) throw new AppError('VALIDATION', 'Этот кошелёк DC уже привязан к другому сотруднику');
}

export async function registerStaffAdmin(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/admin/staff', { schema: { tags, security: sec, querystring: StaffQuery, response: { 200: StaffListView } } }, async (req) => {
    const me = requireStaff(req.principal, 'staff.write');
    const storeId = me.role === 'admin' ? req.query.store_id : me.store_id;
    const rows = await deps.db.select().from(userStaff).where(storeId ? eq(userStaff.storeId, storeId) : undefined).orderBy(asc(userStaff.role), asc(userStaff.name));
    return { staff: rows.map(view) };
  });

  r.post('/admin/staff', { schema: { tags, security: sec, body: StaffInput, response: { 201: StaffView } } }, async (req, reply) => {
    const me = requireStaff(req.principal, 'staff.write');
    const b = req.body;
    assertCanManage(me, b.role, b.store_id);
    const u = await deps.db.transaction(async (tx) => {
      const [dup] = await tx.select({ id: userStaff.id }).from(userStaff).where(eq(userStaff.phone, b.phone));
      if (dup) throw new AppError('VALIDATION', 'Сотрудник с таким телефоном уже есть');
      if (b.dc_user_id) await assertWalletFree(tx, b.dc_user_id, null);
      const [u] = await tx.insert(userStaff).values({ phone: b.phone, name: b.name, role: b.role, storeId: b.store_id, pinHash: hashPin(b.pin), dcUserId: b.dc_user_id ?? null }).returning();
      if (b.role === 'courier') await ensureCourier(tx, u!.id, b.transport ?? 'bike', b.store_id);
      await audit(tx, { actorType: 'staff', actorId: me.staff_id, action: 'staff.create', objectType: 'user_staff', objectId: u!.id, after: view(u!), storeId: b.store_id });
      return u!;
    });
    return reply.status(201).send(view(u));
  });

  r.patch('/admin/staff/:id', { schema: { tags, security: sec, params: IdParams, body: StaffPatch, response: { 200: StaffView } } }, async (req) => {
    const me = requireStaff(req.principal, 'staff.write');
    const { reason, pin, ...b } = req.body;
    return deps.db.transaction(async (tx) => {
      const [before] = await tx.select().from(userStaff).where(eq(userStaff.id, req.params.id)).for('update');
      if (!before) throw notFound('Сотрудник', req.params.id);
      if (before.id === me.staff_id && (b.role !== undefined || b.is_active === false)) throw new AppError('FORBIDDEN', 'Нельзя менять свою роль или блокировать себя');
      assertCanManage(me, before.role, before.storeId);
      if (b.dc_user_id) await assertWalletFree(tx, b.dc_user_id, before.id);
      const role = b.role ?? before.role;
      const storeId = b.store_id !== undefined ? b.store_id : before.storeId;
      assertCanManage(me, role, storeId);
      const [u] = await tx
        .update(userStaff)
        .set({
          ...(b.name !== undefined && { name: b.name }),
          ...(b.role !== undefined && { role: b.role }),
          ...(b.store_id !== undefined && { storeId: b.store_id }),
          ...(b.is_active !== undefined && { isActive: b.is_active }),
          ...(pin !== undefined && { pinHash: hashPin(pin) }),
          ...(b.dc_user_id !== undefined && { dcUserId: b.dc_user_id }),
        })
        .where(eq(userStaff.id, before.id))
        .returning();
      if (u!.role === 'courier') await ensureCourier(tx, u!.id, 'bike', u!.storeId);
      activeCache.delete(u!.id);
      // новый PIN снимает блокировку входа по перебору
      if (pin !== undefined) await tx.delete(authAttempt).where(eq(authAttempt.key, `phone:${u!.phone}`));
      await audit(tx, {
        actorType: 'staff',
        actorId: me.staff_id,
        action: 'staff.update',
        objectType: 'user_staff',
        objectId: u!.id,
        before: view(before),
        after: { ...b, ...(pin !== undefined ? { pin: 'изменён' } : {}) },
        reason,
        storeId: u!.storeId,
      });
      return view(u!);
    });
  });
}

/**
 * Активен ли сотрудник: заблокированный теряет доступ сразу, не дожидаясь истечения токена.
 * Кэш 30 с сбрасывается при изменении сотрудника в этом процессе; в другом инстансе — не позже чем через 30 с.
 */
const activeCache = new Map<string, { ok: boolean; at: number }>();
export async function isStaffActive(deps: AppDeps, staffId: string): Promise<boolean> {
  const c = activeCache.get(staffId);
  if (c && Date.now() - c.at < 30_000) return c.ok;
  const [u] = await deps.db.select({ a: userStaff.isActive }).from(userStaff).where(eq(userStaff.id, staffId));
  const ok = !!u?.a;
  activeCache.set(staffId, { ok, at: Date.now() });
  return ok;
}
