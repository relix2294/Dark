# Dark — заметки для разработки

Платформа Lablabu (дарк-стор) + Sor Box (кухня). ТЗ — `docs/spec/TECH_SPEC.md`, архитектура — `docs/ARCHITECTURE.md`, решения — `docs/adr/`.
Язык общения и комментариев в коде — русский.

## Команды
- `pnpm install`, затем `pnpm --filter @dark/contracts build` (api зависит от собранных контрактов).
- `pnpm check` — границы модулей, типы, тесты. Это то, что гоняет CI; перед коммитом должно быть зелёным.
- Тесты ходят в Postgres: `TEST_DATABASE_URL=postgres://dark:dark@127.0.0.1:5432/dark_test pnpm test`.
- Схема изменилась → `pnpm db:generate` (новая миграция в `apps/api/drizzle`), затем `pnpm db:migrate`. Инварианты — руками в отдельной миграции.
- Локальный API: `pnpm db:migrate && pnpm db:seed && pnpm api` → `http://localhost:3000/docs`.

## Правила кода
- Деньги и остатки — целые (`shared/money.ts`). Новое денежное поле — `integer` в БД, `Dirams` в контракте.
- Любое изменение `stock_lot` сопровождается строкой `stock_move` в той же транзакции.
- Переход статуса — только через `transition()` (orders) или `*.assert()` машины состояний; никаких прямых `update status`.
- Новый код ошибки — сначала в `@dark/contracts` `ErrorCode`, потом в `shared/errors` таблица статусов.
- Новый enum — кортеж `*_VALUES` в `@dark/contracts`, из него zod-схема и `pgEnum`.
- Модуль импортирует другой модуль только через его `index.ts`. `shared/` не импортирует `modules/`.
- Событие — только через `publish(tx, …)` внутри транзакции; темы — `shared/events/topics.ts`.
- Изменяющие маршруты требуют `Idempotency-Key`; исключение — `config: { idempotency: false }` с обоснованием.
- Сценарий из таблицы крайних случаев ТЗ §11 реализуется вместе с тестом в `apps/api/test/`.
