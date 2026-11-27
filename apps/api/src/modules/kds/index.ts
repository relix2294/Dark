/**
 * Кухня Sor Box: очередь станций, раскладка блюд, упаковка, стоп-лист (ТЗ §8).
 * Другие модули импортируют только из этого index.ts.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { KdsItemIdParams, KdsItemView, KdsOrderIdParams, KdsPackListView, KdsQueueQuery, KdsQueueView, PackedView, StopListRequest, StopListView } from '@dark/contracts';
import type { AppDeps } from '../../app.js';
import { requireStaff } from '../../shared/auth/index.js';
import * as svc from './service.js';

export { scheduleOrder, dishColor, sorPromise, type DishToCook, type StationLoad } from './schedule.js';
export { enqueueOrder, estimateReady, writeOffStartedDishes } from './service.js';

export async function registerKds(app: FastifyInstance, deps: AppDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['kds'];
  const sec = [{ bearer: [] }];

  r.get('/kds/queue', { schema: { tags, security: sec, querystring: KdsQueueQuery, response: { 200: KdsQueueView } } }, async (req) =>
    svc.queue(deps, requireStaff(req.principal, 'kds.queue'), req.query.station),
  );
  r.get('/kds/pack', { schema: { tags, security: sec, response: { 200: KdsPackListView } } }, async (req) => svc.packList(deps, requireStaff(req.principal, 'kds.queue')));
  r.post('/kds/items/:id/start', { schema: { tags, security: sec, params: KdsItemIdParams, response: { 200: KdsItemView } } }, async (req) =>
    svc.start(deps, requireStaff(req.principal, 'kds.queue'), req.params.id),
  );
  r.post('/kds/items/:id/done', { schema: { tags, security: sec, params: KdsItemIdParams, response: { 200: KdsItemView } } }, async (req) =>
    svc.done(deps, requireStaff(req.principal, 'kds.queue'), req.params.id),
  );
  r.post('/kds/orders/:id/packed', { schema: { tags, security: sec, params: KdsOrderIdParams, response: { 200: PackedView } } }, async (req) =>
    svc.packed(deps, requireStaff(req.principal, 'kds.queue'), req.params.id),
  );
  /** Сборщик забирает готовое блюдо кухни для заказа Lablabu (ТЗ §8, этап 2). */
  r.post('/kds/handoff/:id', { schema: { tags, security: sec, params: KdsItemIdParams } }, async (req) =>
    svc.handOffToPicker(deps, requireStaff(req.principal, 'wms.pick'), req.params.id),
  );
  r.get('/kds/stop-list', { schema: { tags, security: sec, response: { 200: StopListView } } }, async (req) => svc.getStopList(deps, requireStaff(req.principal, 'kds.stop_list')));
  r.put('/kds/stop-list', { schema: { tags, security: sec, body: StopListRequest, response: { 200: StopListView } } }, async (req) =>
    svc.setStopList(deps, requireStaff(req.principal, 'kds.stop_list'), req.body),
  );
}
