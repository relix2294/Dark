import type { CourierStatus, DeliveryTaskStatus } from '@dark/contracts';
import { StateMachine } from '../../shared/state-machine.js';

type Actor = 'courier' | 'system' | 'shift_lead';

/** offered → accepted → at_store → picked_up → delivering → done; ответвления по ТЗ §3. */
export const taskMachine = new StateMachine<DeliveryTaskStatus, Actor>('delivery_task', [
  { from: 'offered', to: 'accepted', by: ['courier', 'system'] },
  { from: 'offered', to: 'expired', by: ['system'] },
  { from: 'accepted', to: 'at_store', by: ['courier', 'system'] },
  { from: 'accepted', to: 'reassigned', by: ['shift_lead'] },
  { from: 'at_store', to: 'picked_up', by: ['courier'] },
  { from: 'at_store', to: 'reassigned', by: ['shift_lead'] },
  { from: 'picked_up', to: 'delivering', by: ['courier', 'system'] },
  { from: 'delivering', to: 'done', by: ['courier', 'system'] },
  { from: 'delivering', to: 'failed', by: ['courier', 'shift_lead'] },
]);

export const courierMachine = new StateMachine<CourierStatus, Actor>('courier', [
  { from: 'offline', to: 'free', by: ['courier'] },
  { from: 'free', to: 'offline', by: ['courier', 'shift_lead'] },
  { from: 'free', to: 'break', by: ['courier'] },
  { from: 'break', to: 'free', by: ['courier'] },
  { from: 'free', to: 'assigned', by: ['system', 'shift_lead'] },
  { from: 'assigned', to: 'free', by: ['system', 'shift_lead'] }, // задание истекло / снято
  { from: 'assigned', to: 'delivering', by: ['courier', 'system'] },
  { from: 'delivering', to: 'returning', by: ['system'] },
  { from: 'returning', to: 'free', by: ['courier', 'system'] },
  { from: 'returning', to: 'assigned', by: ['system', 'shift_lead'] }, // RETURN_LOOKAHEAD
]);
