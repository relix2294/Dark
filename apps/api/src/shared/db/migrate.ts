import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL не задан');

const { db, close } = createDb(url);
await migrate(db, { migrationsFolder: new URL('../../../drizzle', import.meta.url).pathname });
console.log('Миграции применены');
await close();
