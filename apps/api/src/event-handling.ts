import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

export type OutboxEvent = {
  id: string; aggregate_id: string; event_type: string;
  payload: { customerId?: string; driverId?: string; deliveryId?: string; to?: string };
};

function notificationText(eventType: string) {
  const titles: Record<string, string> = {
    DeliveryCreated: 'Delivery created', DriverAssigned: 'Driver assigned',
    DeliveryAccepted: 'Driver accepted', DriverRejected: 'Driver declined',
    DeliveryPickedUp: 'Package picked up', DeliveryStarted: 'Out for delivery',
    DriverArrived: 'Driver arrived', DeliveryCompleted: 'Delivery completed',
    DeliveryFailed: 'Delivery failed', DeliveryCancelled: 'Delivery cancelled',
  };
  return titles[eventType] ?? eventType;
}

export async function storeNotifications(client: PoolClient, item: OutboxEvent) {
  const recipients = [...new Set([item.payload.customerId, item.payload.driverId].filter((value): value is string => !!value))];
  for (const userId of recipients) {
    await client.query(
      `INSERT INTO notifications (id, event_id, user_id, delivery_id, title, body)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id, user_id) DO NOTHING`,
      [randomUUID(), item.id, userId, item.aggregate_id, notificationText(item.event_type), `Delivery ${item.aggregate_id}`],
    );
  }
}

export function liveEvent(item: OutboxEvent) {
  return { type: 'delivery.event', eventType: item.event_type, ...item.payload };
}
