import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QUEUE_KEY, SERVER_URL, TASK, TOKEN_KEY } from './config.ts';
import { enqueue, fromLocations, takeBatch, type Point } from './queue.ts';

/**
 * Фоновая геопозиция: система будит задачу с новыми точками и при свёрнутом приложении.
 * Точки сначала ложатся в очередь на устройстве, затем уходят пакетами; без связи — копятся.
 */
TaskManager.defineTask<{ locations: Parameters<typeof fromLocations>[0] }>(TASK, async ({ data, error }) => {
  if (error || !data) return;
  const queue = enqueue(await readQueue(), fromLocations(data.locations));
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  await flush();
});

async function readQueue(): Promise<Point[]> {
  try {
    return JSON.parse((await AsyncStorage.getItem(QUEUE_KEY)) ?? '[]') as Point[];
  } catch {
    return [];
  }
}

/** Отправить очередь пакетами. Ошибка сети — оставить на следующий раз; 401 — токен устарел, очередь не трогаем. */
export async function flush(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!token) return;
  let queue = await readQueue();
  while (queue.length) {
    const { batch, rest } = takeBatch(queue);
    try {
      const res = await fetch(`${SERVER_URL}/api/v1/courier/position`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ points: batch }),
      });
      if (!res.ok) return;
    } catch {
      return;
    }
    queue = rest;
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }
}
