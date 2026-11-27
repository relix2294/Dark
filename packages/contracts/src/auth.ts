import { z } from 'zod';
import { StaffRole } from './enums.js';
import { Uuid } from './common.js';

export const DcAuthRequest = z.object({ dc_token: z.string().min(1) });
export const StaffLoginRequest = z.object({
  phone: z.string().regex(/^\+?\d{9,15}$/),
  pin: z.string().regex(/^\d{4,6}$/),
});

export const AuthResponse = z.object({
  token: z.string(),
  expires_at: z.iso.datetime(),
});

export const StaffPrincipal = z.object({
  kind: z.literal('staff'),
  staff_id: Uuid,
  role: StaffRole,
  store_id: Uuid.nullable(),
});
export const CustomerPrincipal = z.object({
  kind: z.literal('customer'),
  customer_id: Uuid,
  dc_user_id: z.string(),
});
export const Principal = z.discriminatedUnion('kind', [StaffPrincipal, CustomerPrincipal]);
export type Principal = z.infer<typeof Principal>;
export type StaffPrincipal = z.infer<typeof StaffPrincipal>;
export type CustomerPrincipal = z.infer<typeof CustomerPrincipal>;
