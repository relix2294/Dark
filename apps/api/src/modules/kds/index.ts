/**
 * Кухня Sor Box: очередь станций, раскладка блюд, стоп-лист (ТЗ §8). Публичный интерфейс: schedule.ts. Маршруты /kds/* — следующая итерация.
 * Другие модули импортируют только из этого index.ts.
 */
export { scheduleOrder, dishColor, sorPromise, type DishToCook, type StationLoad } from './schedule.js';
