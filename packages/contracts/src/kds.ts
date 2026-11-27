import { z } from 'zod';
import { Station } from './enums.js';
import { Uuid } from './common.js';

export const KdsQueueQuery = z.object({ station: Station });
export const StopListRequest = z.object({
  product_ids: z.array(Uuid).default([]),
  ingredient_ids: z.array(Uuid).default([]),
});
