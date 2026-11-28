import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Principal, StaffRole } from '@dark/contracts';
import { Principal as PrincipalSchema } from '@dark/contracts';
import { AppError, forbidden } from '../errors/index.js';

/** PIN — scrypt из node:crypto, без нативных зависимостей. Формат: salt:hash (hex). */
export function hashPin(pin: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pin, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = scryptSync(pin, Buffer.from(saltHex, 'hex'), 32);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}

export class TokenService {
  private readonly key: Uint8Array;
  constructor(secret: string, private readonly ttlSec = 12 * 3600) {
    this.key = new TextEncoder().encode(secret);
  }

  async sign(p: Principal): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + this.ttlSec * 1000);
    const token = await new SignJWT({ p })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.key);
    return { token, expiresAt };
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.key);
      return PrincipalSchema.parse(payload['p']);
    } catch {
      throw new AppError('UNAUTHORIZED', 'Недействительный токен');
    }
  }
}

/** Матрица прав (ТЗ §9) — действие → роли. Проверяется сервером на каждом запросе. */
export const PERMISSIONS = {
  'wms.pick': ['picker', 'shift_lead', 'manager'],
  'wms.receive': ['picker', 'shift_lead', 'manager'],
  'wms.place': ['picker', 'shift_lead', 'manager'],
  'wms.write_off.request': ['picker', 'cook'],
  'wms.write_off.approve': ['shift_lead', 'manager'],
  'wms.stock.adjust': ['manager'],
  'kds.queue': ['cook', 'shift_lead', 'manager'],
  'kds.stop_list': ['cook', 'shift_lead', 'manager'],
  'dispatch.manual_assign': ['shift_lead', 'manager'],
  'orders.cancel_after_start': ['shift_lead', 'manager'],
  'payments.refund.under_limit': ['shift_lead', 'manager', 'finance'],
  'payments.refund.over_limit': ['manager', 'finance'],
  'catalog.write': ['manager', 'admin'],
  'stores.write': ['admin'],
  'stores.read': ['shift_lead', 'manager', 'finance', 'admin'],
  'wms.cells.write': ['manager', 'admin'],
  'wms.supply.create': ['shift_lead', 'manager', 'admin'],
  'dispatch.plan': ['shift_lead', 'manager', 'admin'],
  'promo.write': ['manager', 'admin'],
  'finance.reports': ['manager', 'finance'],
  /** Выплаты курьерам: доплата, повтор неудачной выплаты. */
  'payouts.manage': ['manager', 'finance'],
  'audit.read': ['shift_lead', 'manager', 'admin', 'finance'],
  'finance.reconcile': ['finance'],
  'staff.write': ['manager', 'admin'],
  'params.write': ['manager', 'admin'],
  'courier.app': ['courier'],
  'shift_lead.console': ['shift_lead', 'manager'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type Permission = keyof typeof PERMISSIONS;

export function hasPermission(role: StaffRole, perm: Permission): boolean {
  return (PERMISSIONS[perm] as readonly StaffRole[]).includes(role);
}

export function requireStaff(p: Principal | undefined, perm: Permission, storeId?: string) {
  if (!p) throw new AppError('UNAUTHORIZED', 'Требуется вход');
  if (p.kind !== 'staff') throw forbidden('Только для персонала');
  if (!hasPermission(p.role, perm)) throw forbidden(`Роль ${p.role} не имеет права ${perm}`);
  // Сотрудник точки видит только свою точку; admin/finance — без привязки.
  if (storeId && p.store_id && p.store_id !== storeId) throw forbidden('Чужая точка');
  return p;
}

/** Любое из прав подходит (например, запрос списания или его утверждение). */
export function requireStaffAny(p: Principal | undefined, perms: Permission[], storeId?: string) {
  if (!p) throw new AppError('UNAUTHORIZED', 'Требуется вход');
  if (p.kind !== 'staff') throw forbidden('Только для персонала');
  if (!perms.some((perm) => hasPermission(p.role, perm))) throw forbidden(`Роль ${p.role} не имеет прав ${perms.join(' / ')}`);
  if (storeId && p.store_id && p.store_id !== storeId) throw forbidden('Чужая точка');
  return p;
}

export function requireCustomer(p: Principal | undefined) {
  if (!p) throw new AppError('UNAUTHORIZED', 'Требуется вход');
  if (p.kind !== 'customer') throw forbidden('Только для клиента');
  return p;
}
