import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../../shared/params/index.js';
import { planDispatch, type FreeCourier, type PendingOrder } from './planner.js';

const now = new Date('2026-11-27T12:00:00Z');
const store = { lat: 38.56, lon: 68.78 };
const near = { lat: 38.565, lon: 68.78 }; // ~0.55 км
const min = (n: number) => new Date(now.getTime() + n * 60_000);

const courier = (id: string, eta = 0): FreeCourier => ({ id, transport: 'bike', position: store, etaToStoreMin: eta });
const lab = (id: string, createdMinAgo: number): PendingOrder => ({
  id,
  brand: 'LAB',
  createdAt: min(-createdMinAgo),
  readyEta: min(1),
  promisedAt: min(15 - createdMinAgo),
  address: near,
  readyAt: null,
});
const sor = (id: string, promiseInMin: number, readyInMin = 1): PendingOrder => ({
  id,
  brand: 'SOR',
  createdAt: min(-10),
  readyEta: min(readyInMin),
  promisedAt: min(promiseInMin),
  address: near,
  readyAt: null,
});

const params = DEFAULT_PARAMS;

describe('диспетчер (ТЗ §6)', () => {
  it('срочный SOR получает курьера раньше нового LAB', () => {
    const r = planDispatch({ now, store, orders: [lab('L1', 0), sor('S1', 8)], couriers: [courier('c1')], labDemandRecent: true, params });
    expect(r.assignments).toHaveLength(1);
    expect(r.assignments[0]).toMatchObject({ orderId: 'S1', rule: 'sor_urgent' });
    expect(r.deferred).toContainEqual({ orderId: 'L1', reason: 'no_courier' });
  });

  it('LAB назначаются по очереди created_at', () => {
    const r = planDispatch({ now, store, orders: [lab('L2', 1), lab('L1', 3)], couriers: [courier('c1')], labDemandRecent: true, params });
    expect(r.assignments[0]?.orderId).toBe('L1');
  });

  it('обычный SOR ждёт, если без него не остаётся резерва под LAB', () => {
    const r = planDispatch({ now, store, orders: [sor('S1', 40)], couriers: [courier('c1')], labDemandRecent: true, params });
    expect(r.assignments).toHaveLength(0);
    expect(r.deferred).toContainEqual({ orderId: 'S1', reason: 'lab_reserve' });
  });

  it('обычный SOR назначается, если корзин LAB нет 5 минут', () => {
    const r = planDispatch({ now, store, orders: [sor('S1', 40)], couriers: [courier('c1')], labDemandRecent: false, params });
    expect(r.assignments[0]).toMatchObject({ orderId: 'S1', rule: 'sor_regular' });
  });

  it('SOR до готовности больше SOR_PREASSIGN не рассматривается', () => {
    const r = planDispatch({ now, store, orders: [sor('S1', 40, 20)], couriers: [courier('c1'), courier('c2')], labDemandRecent: false, params });
    expect(r.assignments).toHaveLength(0);
    expect(r.deferred).toContainEqual({ orderId: 'S1', reason: 'not_due' });
  });

  it('возвращающийся курьер считается свободным в пределах RETURN_LOOKAHEAD', () => {
    const r = planDispatch({ now, store, orders: [lab('L1', 0)], couriers: [courier('c1', 1.5)], labDemandRecent: true, params });
    expect(r.assignments[0]?.courierId).toBe('c1');
    const r2 = planDispatch({ now, store, orders: [lab('L1', 0)], couriers: [courier('c1', 5)], labDemandRecent: true, params });
    expect(r2.assignments).toHaveLength(0);
  });

  it('тревоги по ожиданию готового заказа без курьера', () => {
    const o = { ...lab('L1', 10), readyAt: min(-8) };
    const r = planDispatch({ now, store, orders: [o], couriers: [], labDemandRecent: true, params });
    expect(r.alerts).toEqual([{ orderId: 'L1', level: 'alert', waitingMin: 8 }]);
  });

  it('снимок входа содержит свободных курьеров и очередь', () => {
    const r = planDispatch({ now, store, orders: [lab('L1', 0)], couriers: [courier('c1')], labDemandRecent: true, params });
    expect(r.snapshot).toMatchObject({ lab: ['L1'], free: [{ id: 'c1' }] });
  });
});
