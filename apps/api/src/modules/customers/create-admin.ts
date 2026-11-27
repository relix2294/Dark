/**
 * Первый админ на чистой базе (в продакшене демо-данных нет):
 *   node dist/modules/customers/create-admin.js +992XXXXXXXXX 'Имя' 123456
 * Повторный запуск с тем же телефоном меняет PIN и включает доступ. Всё пишется в журнал действий.
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../../shared/db/client.js';
import { userStaff } from '../../shared/db/schema/index.js';
import { hashPin } from '../../shared/auth/index.js';
import { audit } from '../../shared/audit.js';

const [phone, name, pin] = process.argv.slice(2);
if (!phone || !/^\+?\d{9,15}$/.test(phone) || !name || !pin || !/^\d{4,6}$/.test(pin)) {
  console.error("Использование: create-admin.js +992XXXXXXXXX 'Имя' 123456 (PIN — 4–6 цифр)");
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');
const { db, close } = createDb(url);
await db.transaction(async (tx) => {
  const [ex] = await tx.select().from(userStaff).where(eq(userStaff.phone, phone));
  const [u] = ex
    ? await tx.update(userStaff).set({ role: 'admin', name, pinHash: hashPin(pin), isActive: true, storeId: null }).where(eq(userStaff.id, ex.id)).returning()
    : await tx.insert(userStaff).values({ phone, name, role: 'admin', storeId: null, pinHash: hashPin(pin) }).returning();
  await audit(tx, { actorType: 'system', actorId: null, action: ex ? 'staff.admin_reset' : 'staff.admin_create', objectType: 'user_staff', objectId: u!.id, after: { phone, name, role: 'admin' }, reason: 'create-admin' });
  console.log(`${ex ? 'Обновлён' : 'Создан'} админ ${name} (${phone}). Вход в /office/ по телефону и PIN.`);
});
await close();
