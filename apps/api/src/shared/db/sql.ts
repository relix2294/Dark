import { getTableName, sql, type Column } from 'drizzle-orm';

/**
 * Полностью квалифицированная ссылка на колонку: "table"."column".
 * Нужна в коррелированных подзапросах: в запросе к одной таблице Drizzle пишет колонки без имени таблицы,
 * и внутри подзапроса "id" молча начинает указывать на внутреннюю таблицу.
 */
export const ref = (c: Column) => sql.raw(`"${getTableName(c.table)}"."${c.name}"`);
