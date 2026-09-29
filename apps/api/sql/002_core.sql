CREATE TABLE drivers (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  is_online BOOLEAN NOT NULL DEFAULT FALSE,
  last_seen_at TIMESTAMPTZ,
  last_lat DOUBLE PRECISION CHECK (last_lat BETWEEN -90 AND 90),
  last_lng DOUBLE PRECISION CHECK (last_lng BETWEEN -180 AND 180),
  CHECK ((last_lat IS NULL) = (last_lng IS NULL))
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY,
  driver_id UUID NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  plate_number TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE addresses (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  address_text TEXT NOT NULL,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE deliveries (
  id UUID PRIMARY KEY,
  customer_id UUID NOT NULL REFERENCES users(id),
  driver_id UUID REFERENCES drivers(user_id),
  pickup_address TEXT NOT NULL,
  pickup_lat DOUBLE PRECISION NOT NULL CHECK (pickup_lat BETWEEN -90 AND 90),
  pickup_lng DOUBLE PRECISION NOT NULL CHECK (pickup_lng BETWEEN -180 AND 180),
  dropoff_address TEXT NOT NULL,
  dropoff_lat DOUBLE PRECISION NOT NULL CHECK (dropoff_lat BETWEEN -90 AND 90),
  dropoff_lng DOUBLE PRECISION NOT NULL CHECK (dropoff_lng BETWEEN -180 AND 180),
  status TEXT NOT NULL CHECK (status IN (
    'ASSIGNMENT_PENDING', 'DRIVER_ASSIGNED', 'ACCEPTED', 'PICKED_UP',
    'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED', 'FAILED', 'CANCELLED'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX deliveries_customer_created_idx ON deliveries(customer_id, created_at DESC);
CREATE INDEX deliveries_driver_status_idx ON deliveries(driver_id, status);
CREATE INDEX deliveries_active_idx ON deliveries(status, created_at) WHERE status NOT IN ('DELIVERED', 'FAILED', 'CANCELLED');

CREATE TABLE driver_assignments (
  id UUID PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES deliveries(id),
  driver_id UUID NOT NULL REFERENCES drivers(user_id),
  status TEXT NOT NULL CHECK (status IN ('OFFERED', 'ACCEPTED', 'REJECTED', 'REASSIGNED', 'COMPLETED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX driver_one_active_assignment_idx ON driver_assignments(driver_id) WHERE status IN ('OFFERED', 'ACCEPTED');
CREATE UNIQUE INDEX delivery_one_active_assignment_idx ON driver_assignments(delivery_id) WHERE status IN ('OFFERED', 'ACCEPTED');
CREATE INDEX assignments_driver_created_idx ON driver_assignments(driver_id, created_at DESC);

CREATE TABLE delivery_status_history (
  id BIGSERIAL PRIMARY KEY,
  delivery_id UUID NOT NULL REFERENCES deliveries(id),
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX status_history_delivery_idx ON delivery_status_history(delivery_id, created_at);

CREATE TABLE notifications (
  id UUID PRIMARY KEY,
  event_id BIGINT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  delivery_id UUID REFERENCES deliveries(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(event_id, user_id)
);
CREATE INDEX notifications_user_created_idx ON notifications(user_id, created_at DESC);

CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PROCESSING', 'DONE', 'DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX jobs_ready_idx ON jobs(status, run_at) WHERE status IN ('PENDING', 'PROCESSING');

CREATE TABLE outbox_events (
  id BIGSERIAL PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX outbox_pending_idx ON outbox_events(id) WHERE published_at IS NULL;

CREATE TABLE idempotency_keys (
  user_id UUID NOT NULL REFERENCES users(id),
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(user_id, scope, key)
);
