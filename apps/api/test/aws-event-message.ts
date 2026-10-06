import assert from 'node:assert/strict';
import { eventMessage } from '../src/aws-event-message.js';

const detail = {
  eventId: '12',
  aggregateId: '03e8f488-eeca-4b60-9b63-cfd2dd2dc609',
  eventType: 'DeliveryFailed',
};

const withNull = eventMessage.parse({ detail: { ...detail, payload: { customerId: 'customer-1', driverId: null } } });
assert.equal(withNull.detail.payload.customerId, 'customer-1');
assert.equal(withNull.detail.payload.driverId, undefined);

const withoutDriver = eventMessage.parse({ detail: { ...detail, payload: {} } });
assert.equal(withoutDriver.detail.payload.driverId, undefined);

assert.throws(() => eventMessage.parse({ detail: { ...detail, payload: { driverId: 42 } } }));
console.log('AWS event message validation passed');
