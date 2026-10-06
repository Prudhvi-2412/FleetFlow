import { z } from 'zod';

const optionalId = z.string().nullish().transform((value) => value ?? undefined);

export const eventMessage = z.object({
  detail: z.object({
    eventId: z.string().regex(/^\d+$/),
    aggregateId: z.uuid(),
    eventType: z.string().min(1),
    payload: z.object({
      customerId: optionalId,
      driverId: optionalId,
      deliveryId: optionalId,
      to: optionalId,
    }).passthrough(),
  }),
});
