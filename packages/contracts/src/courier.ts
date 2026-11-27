import { z } from 'zod';
import { Geo } from './common.js';

export const PositionBatch = z.object({
  points: z
    .array(Geo.extend({ at: z.iso.datetime(), accuracy_m: z.number().min(0) }))
    .min(1)
    .max(500),
});
export const DeliveredRequest = z.object({ geo: Geo, photo_url: z.string().optional() });
export const PickupRequest = z.object({ package_barcodes: z.array(z.string()).min(1) });
