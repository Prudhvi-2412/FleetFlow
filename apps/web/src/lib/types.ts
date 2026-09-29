export type User = { id: string; email: string; full_name: string; role: 'customer' | 'driver' | 'admin' };
export type Session = { user: User; token: string };
export type DeliveryStatus =
  | 'ASSIGNMENT_PENDING' | 'DRIVER_ASSIGNED' | 'ACCEPTED' | 'PICKED_UP'
  | 'OUT_FOR_DELIVERY' | 'ARRIVED' | 'DELIVERED' | 'FAILED' | 'CANCELLED';
export type Delivery = {
  id: string; customer_id: string; driver_id: string | null; driver_name?: string | null;
  pickup_address: string; pickup_lat: number; pickup_lng: number;
  dropoff_address: string; dropoff_lat: number; dropoff_lng: number;
  status: DeliveryStatus; version: number; failure_reason?: string | null; created_at: string; updated_at: string;
};
export type Notification = {
  id: string; delivery_id: string | null; title: string; body: string;
  read_at: string | null; created_at: string;
};
export type Driver = {
  id: string; full_name: string; email: string; is_online: boolean;
  last_seen_at: string | null; last_lat: number | null; last_lng: number | null;
  vehicle_label: string | null; plate_number: string | null; active_delivery_id: string | null;
};
export type Job = { id: string; kind: string; payload: { deliveryId: string }; attempts: number; last_error: string; created_at: string };
export type Metrics = {
  deliveryStatuses: { status: string; count: number }[];
  drivers: { online: number; total: number };
  jobStatuses: { status: string; count: number }[];
  notifications: { total: number };
};
export type Location = { lat: number; lng: number; timestamp: string };
