/**
 * Диспетчер курьеров: смены, геопозиция, назначение (ТЗ §6). Публичный интерфейс: planner.ts, state-machine.ts. Маршруты /courier/* и воркер dispatch.tick — следующая итерация.
 * Другие модули импортируют только из этого index.ts.
 */
export { planDispatch, type DispatchInput, type DispatchResult } from './planner.js';
export { taskMachine, courierMachine } from './state-machine.js';
