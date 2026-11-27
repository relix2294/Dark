# Dark — Lablabu + Sor Box

Платформа быстрой доставки для Душанбе: **Lablabu** (дарк-стор, обещание 15 минут) и **Sor Box** (кухня, 45 минут).
Один бэкенд, два бренда, много точек. Бренд и точка — поля данных, не отдельные инсталляции.

- Бизнес-ТЗ и техническая спецификация: [docs/spec/TECH_SPEC.md](docs/spec/TECH_SPEC.md)
- Архитектура и выбор стека: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), решения — [docs/adr](docs/adr)

## Стек

| Слой | Выбор | Почему |
| --- | --- | --- |
| Язык | TypeScript везде (Node 22) | Один язык на сервере и во всех клиентах; типы контракта общие |
| API | Fastify 5 + zod | Схема запроса = валидация = OpenAPI; быстрый, без магии |
| БД | PostgreSQL 16 + Drizzle ORM | Транзакции, CHECK-инварианты, миграции SQL в репозитории |
| Очереди | pg-boss | Очередь прямо в Postgres: outbox, повторы capture, тик диспетчера. Без Redis |
| Realtime | SSE (клиент), WebSocket (экраны персонала) | По ТЗ §1 |
| Фронты | React 19 + Vite + PWA | Витрина, админка/пульт, кухня, терминал сборщика |
| Курьер | Expo (React Native) | Фоновая геопозиция и пуши — PWA этого не умеет |
| Монорепо | pnpm workspaces + Turborepo | Общий пакет контрактов, одна команда проверки |

## Структура

```
apps/api            модульный монолит (Fastify): core-api, payments, wms, kds, dispatch, backoffice, notify
apps/storefront     витрина клиента внутри DC Next (React PWA)        — этап 0: макеты
apps/backoffice     админка + пульт старшего смены (React)            — этап 0
apps/kds            экран кухни (React, планшет)                      — этап 0
apps/picker         терминал сборщика (React PWA, Android-терминал)   — этап 0
apps/courier        приложение курьера (Expo)                         — этап 0
packages/contracts  zod-схемы API: единственный источник типов для сервера и клиентов
deploy/             docker-compose + Caddy для VPS
docs/               ТЗ, архитектура, ADR
scripts/            проверка границ модулей
```

## Запуск локально

Нужны Node 22, pnpm 10 и PostgreSQL 16 (локально или в Docker).

```bash
pnpm install
cp .env.example .env            # поправьте DATABASE_URL и JWT_SECRET
pnpm --filter @dark/contracts build
pnpm db:migrate                 # применить миграции
pnpm db:seed                    # демо-точка в Душанбе, персонал +99290000000{1..7}, PIN 1234
pnpm api                        # http://localhost:3000, Swagger — /docs
```

Проверка всего проекта одной командой (то же, что в CI):

```bash
pnpm check                      # границы модулей, типы, тесты
```

Тесты сценариев приёмки ходят в настоящий Postgres: `TEST_DATABASE_URL=postgres://dark:dark@127.0.0.1:5432/dark_test`.

## Что уже работает

- Контракт API в `packages/contracts`: бренды, статусы, коды ошибок, схемы запросов/ответов (ТЗ §3, §4).
- Схема БД для всех таблиц ТЗ §2 плюс `outbox`, `idempotency_key`, `parameter`, `audit_log`, `kds_item`, `stop_list`.
  Инварианты — CHECK-ограничения и триггеры в миграции `0001_invariants.sql`.
- Машины состояний заказа, платежа, задания курьера и курьера (ТЗ §3) — переход вне таблицы даёт `409 INVALID_TRANSITION`.
- Сценарий «корзина → заказ → холд → резерв FEFO»: `PUT /cart`, `POST /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`, SSE `/orders/{id}/stream`.
  Проверены `PRICE_CHANGED`, `OUT_OF_STOCK` на последней единице, отказ банка, отмена клиентом, идемпотентность по ключу.
- Адаптер кошелька DC за интерфейсом; пока работает заглушка с теми же методами (ТЗ §5).
- Диспетчер курьеров как чистая функция с тестами на все четыре шага алгоритма ТЗ §6 и снимком входа для разбора.
- Раскладка заказа по станциям кухни (ТЗ §8), правила размещения товара по ячейкам и резерв FEFO (ТЗ §7), промо с атомарным бюджетом (ТЗ §11).
- Вход персонала по телефону и PIN, матрица прав ТЗ §9, параметры по точке (ТЗ §12), неизменяемый журнал действий.
- Outbox-события и фоновые задачи на pg-boss (ТЗ §10).

## Что дальше

1. Маршруты `/wms/*` (сборка, приёмка, размещение), `/kds/*`, `/courier/*` поверх уже готовой логики.
2. Воркеры: `dispatch.tick` (применение плана диспетчера), `payments.reconcile` (опрос `status`, повтор `capture`).
3. Макеты и первые экраны фронтов (этап 0 по ТЗ).
4. Реальный адаптер DC после получения контракта банка.

## Деплой

VPS с Docker: `deploy/docker-compose.yml` поднимает Postgres, миграции, API и Caddy с автоматическим TLS.
CI (GitHub Actions) на каждый пуш в `main` прогоняет проверки и публикует образ `ghcr.io/relix2294/dark-api`.
