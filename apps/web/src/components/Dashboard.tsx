'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { Delivery, Driver, Job, Location, Metrics, Notification, Session } from '../lib/types';
import { MapView } from './MapView';

type DriverProfile = { user_id: string; is_online: boolean; last_lat: number | null; last_lng: number | null };
type SocketMessage = { type: string; deliveryId?: string; driverId?: string; lat?: number; lng?: number; timestamp?: string; location?: Location | null };

function shortId(id: string) { return id.slice(0, 8).toUpperCase(); }
function date(value: string) { return new Date(value).toLocaleString(); }

export function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const { token, user } = session;
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [driverProfile, setDriverProfile] = useState<DriverProfile | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [location, setLocation] = useState<Location | null>(null);
  const [history, setHistory] = useState<{ from_status: string | null; to_status: string; created_at: string }[]>([]);
  const [notice, setNotice] = useState('');
  const [socketState, setSocketState] = useState('Connecting');
  const [busy, setBusy] = useState(false);
  const socket = useRef<WebSocket | null>(null);
  const gpsWatch = useRef<number | null>(null);

  const selected = useMemo(() => deliveries.find((item) => item.id === selectedId) ?? null, [deliveries, selectedId]);

  const refresh = useCallback(async () => {
    try {
      const [deliveryData, notificationData] = await Promise.all([
        api<{ deliveries: Delivery[] }>('/deliveries', token),
        api<{ notifications: Notification[] }>('/notifications', token),
      ]);
      setDeliveries(deliveryData.deliveries);
      setSelectedId((current) => current ?? deliveryData.deliveries[0]?.id ?? null);
      setNotifications(notificationData.notifications);
      if (user.role === 'driver') {
        const profile = await api<{ driver: DriverProfile }>('/drivers/me', token);
        setDriverProfile(profile.driver);
      }
      if (user.role === 'admin') {
        const [driverData, metricData, deadData] = await Promise.all([
          api<{ drivers: Driver[] }>('/admin/drivers', token),
          api<Metrics>('/admin/metrics', token),
          api<{ jobs: Job[] }>('/admin/jobs/dead', token),
        ]);
        setDrivers(driverData.drivers);
        setMetrics(metricData);
        setJobs(deadData.jobs);
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onSignOut(); return; }
      setNotice(error instanceof Error ? error.message : 'Could not refresh data');
    }
  }, [token, user.role, onSignOut]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!selectedId) { setHistory([]); return; }
    void api<{ history: { from_status: string | null; to_status: string; created_at: string }[] }>(`/deliveries/${selectedId}`, token)
      .then((detail) => setHistory(detail.history))
      .catch(() => setHistory([]));
  }, [selectedId, selected?.version, token]);

  useEffect(() => {
    let active = true;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!active) return;
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const url = process.env.NEXT_PUBLIC_WS_URL ?? `${scheme}://${window.location.hostname}:3001/ws`;
      const ws = new WebSocket(url);
      socket.current = ws;
      setSocketState('Connecting');
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
      ws.onmessage = (event) => {
        let message: SocketMessage;
        try { message = JSON.parse(event.data) as SocketMessage; } catch { return; }
        if (message.type === 'auth.ok') {
          setSocketState('Live');
          if (selectedId) ws.send(JSON.stringify({ type: 'subscribe', deliveryId: selectedId }));
        } else if (message.type === 'delivery.snapshot' && message.deliveryId === selectedId) {
          setLocation(message.location ?? null);
        } else if (message.type === 'location.update' && message.driverId === selected?.driver_id && typeof message.lat === 'number' && typeof message.lng === 'number') {
          setLocation({ lat: message.lat, lng: message.lng, timestamp: message.timestamp ?? new Date().toISOString() });
        } else if (message.type === 'delivery.event') {
          void refresh();
        }
      };
      ws.onclose = () => {
        if (!active) return;
        setSocketState('Reconnecting');
        retry = setTimeout(connect, 3_000);
      };
      ws.onerror = () => setSocketState('Connection issue');
    };
    connect();
    return () => {
      active = false;
      if (retry) clearTimeout(retry);
      socket.current?.close();
    };
  }, [token, selectedId, selected?.driver_id, refresh]);

  useEffect(() => () => {
    if (gpsWatch.current !== null) navigator.geolocation.clearWatch(gpsWatch.current);
  }, []);

  async function action(work: () => Promise<unknown>, success: string) {
    setBusy(true);
    setNotice('');
    try {
      await work();
      setNotice(success);
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) { onSignOut(); return; }
      setNotice(error instanceof Error ? error.message : 'Request failed');
    } finally {
      setBusy(false);
    }
  }

  function sendGps(lat: number, lng: number) {
    if (socket.current?.readyState === WebSocket.OPEN && socketState === 'Live') {
      socket.current.send(JSON.stringify({ type: 'location.update', lat, lng }));
    } else {
      void api('/drivers/me/location', token, { method: 'PUT', body: JSON.stringify({ lat, lng }) }).catch(() => setNotice('Location update failed'));
    }
  }

  function toggleGps() {
    if (gpsWatch.current !== null) {
      navigator.geolocation.clearWatch(gpsWatch.current);
      gpsWatch.current = null;
      setNotice('GPS sharing stopped');
      return;
    }
    if (!navigator.geolocation) { setNotice('Geolocation is unavailable in this browser'); return; }
    gpsWatch.current = navigator.geolocation.watchPosition(
      (position) => sendGps(position.coords.latitude, position.coords.longitude),
      (error) => setNotice(`GPS: ${error.message}`),
      { enableHighAccuracy: true, maximumAge: 2_000 },
    );
    setNotice('Sharing live GPS while this page stays open');
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div><span className="brand-mark">↗</span><strong>FleetFlow</strong><span className="topbar-subtitle">Operations workspace</span></div>
        <div className="topbar-right"><span className="live-dot" />{socketState}<span className="identity">{user.full_name} · {user.role}</span><button className="ghost" onClick={onSignOut}>Sign out</button></div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="section-label">OVERVIEW</div>
          <div className="sidebar-stat"><span>Deliveries</span><strong>{deliveries.length}</strong></div>
          <div className="sidebar-stat"><span>Unread alerts</span><strong>{notifications.filter((item) => !item.read_at).length}</strong></div>
          {user.role === 'admin' && <div className="sidebar-stat"><span>Online drivers</span><strong>{metrics?.drivers.online ?? 0}</strong></div>}
          <div className="section-label list-heading">RECENT DELIVERIES</div>
          <div className="delivery-list">
            {deliveries.length === 0 && <p className="muted">No deliveries yet.</p>}
            {deliveries.map((delivery) => (
              <button key={delivery.id} className={`delivery-item ${selectedId === delivery.id ? 'selected' : ''}`} onClick={() => { setSelectedId(delivery.id); setLocation(null); }}>
                <span><strong>#{shortId(delivery.id)}</strong><small>{delivery.pickup_address}</small></span>
                <span className={`status-dot ${delivery.status.toLowerCase()}`} />
              </button>
            ))}
          </div>
        </aside>
        <div className="content">
          <div className="page-heading"><div><p className="eyebrow">{user.role === 'customer' ? 'CUSTOMER PORTAL' : user.role === 'driver' ? 'DRIVER CONSOLE' : 'FLEET COMMAND'}</p><h1>{user.role === 'customer' ? 'Your deliveries' : user.role === 'driver' ? 'Your route' : 'Fleet overview'}</h1></div><button className="secondary" onClick={() => void refresh()}>Refresh data</button></div>
          {notice && <div className="notice" role="status">{notice}</div>}
          {user.role === 'customer' && <CustomerPanel token={token} selected={selected} busy={busy} action={action} />}
          {user.role === 'driver' && <DriverPanel token={token} profile={driverProfile} selected={selected} busy={busy} action={action} toggleGps={toggleGps} gpsActive={gpsWatch.current !== null} sendGps={sendGps} />}
          {user.role === 'admin' && <AdminPanel token={token} drivers={drivers} jobs={jobs} metrics={metrics} selected={selected} busy={busy} action={action} />}
          <div className="grid-main">
            <section className="card delivery-detail">
              <div className="card-heading"><h2>Delivery detail</h2>{selected && <span className="badge">{selected.status.replaceAll('_', ' ')}</span>}</div>
              {selected ? <>
                <p className="delivery-id">#{shortId(selected.id)} · Created {date(selected.created_at)}</p>
                <div className="route"><div><span className="route-marker pickup" /><small>PICKUP</small><strong>{selected.pickup_address}</strong></div><div><span className="route-marker dropoff" /><small>DROP-OFF</small><strong>{selected.dropoff_address}</strong></div></div>
                <p className="muted">Driver: {selected.driver_name ?? (selected.driver_id ? `#${shortId(selected.driver_id)}` : 'Waiting for assignment')}</p>
                {selected.failure_reason && <p className="form-error">Failure reason: {selected.failure_reason}</p>}
                {location && <p className="coordinates">Latest position: {location.lat.toFixed(5)}, {location.lng.toFixed(5)} · {date(location.timestamp)}</p>}
                <MapView key={selected.id} delivery={selected} location={location} />
                <div className="history"><h3>Status history</h3>{history.map((item, index) => <div key={`${item.created_at}-${index}`}><span className="history-dot" /><strong>{item.to_status.replaceAll('_', ' ')}</strong><small>{date(item.created_at)}</small></div>)}</div>
              </> : <p className="muted">Select a delivery to see its route and driver.</p>}
            </section>
            <section className="card notification-card"><div className="card-heading"><h2>Activity</h2><span className="count">{notifications.length}</span></div>
              <div className="notification-list">{notifications.length === 0 && <p className="muted">Updates will appear here.</p>}{notifications.map((item) => <button key={item.id} className={`notification ${item.read_at ? '' : 'unread'}`} onClick={() => void action(() => api(`/notifications/${item.id}/read`, token, { method: 'PATCH' }), 'Marked as read')}><strong>{item.title}</strong><small>{date(item.created_at)}</small></button>)}</div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function CustomerPanel({ token, selected, busy, action }: { token: string; selected: Delivery | null; busy: boolean; action: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [pickupAddress, setPickupAddress] = useState('MG Road, Bengaluru');
  const [pickupLat, setPickupLat] = useState('12.9750');
  const [pickupLng, setPickupLng] = useState('77.6060');
  const [dropoffAddress, setDropoffAddress] = useState('Indiranagar, Bengaluru');
  const [dropoffLat, setDropoffLat] = useState('12.9719');
  const [dropoffLng, setDropoffLng] = useState('77.6412');
  function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void action(() => api('/deliveries', token, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ pickup: { address: pickupAddress, lat: Number(pickupLat), lng: Number(pickupLng) }, dropoff: { address: dropoffAddress, lat: Number(dropoffLat), lng: Number(dropoffLng) } }),
    }), 'Delivery created. Searching for an available driver.');
  }
  return <section className="card create-card"><div className="card-heading"><h2>Create a delivery</h2><span className="muted">Enter real coordinates for a local demo</span></div><form className="delivery-form" onSubmit={submit}>
    <label>Pickup address<input value={pickupAddress} onChange={(event) => setPickupAddress(event.target.value)} required /></label>
    <label>Latitude<input type="number" step="any" value={pickupLat} onChange={(event) => setPickupLat(event.target.value)} required /></label>
    <label>Longitude<input type="number" step="any" value={pickupLng} onChange={(event) => setPickupLng(event.target.value)} required /></label>
    <label>Drop-off address<input value={dropoffAddress} onChange={(event) => setDropoffAddress(event.target.value)} required /></label>
    <label>Latitude<input type="number" step="any" value={dropoffLat} onChange={(event) => setDropoffLat(event.target.value)} required /></label>
    <label>Longitude<input type="number" step="any" value={dropoffLng} onChange={(event) => setDropoffLng(event.target.value)} required /></label>
    <button className="primary" disabled={busy}>Create delivery <span>→</span></button>
  </form>{selected && ['ASSIGNMENT_PENDING', 'DRIVER_ASSIGNED'].includes(selected.status) && <button className="secondary cancel-button" disabled={busy} onClick={() => void action(() => api(`/deliveries/${selected.id}/cancel`, token, { method: 'POST' }), 'Delivery cancelled')}>Cancel selected delivery</button>}</section>;
}

function DriverPanel({ token, profile, selected, busy, action, toggleGps, gpsActive, sendGps }: { token: string; profile: DriverProfile | null; selected: Delivery | null; busy: boolean; action: (work: () => Promise<unknown>, success: string) => Promise<void>; toggleGps: () => void; gpsActive: boolean; sendGps: (lat: number, lng: number) => void }) {
  const [lat, setLat] = useState('12.9750');
  const [lng, setLng] = useState('77.6060');
  const next: Record<string, string> = { ACCEPTED: 'PICKED_UP', PICKED_UP: 'OUT_FOR_DELIVERY', OUT_FOR_DELIVERY: 'ARRIVED', ARRIVED: 'DELIVERED' };
  const nextAction = selected ? next[selected.status] : undefined;
  return <section className="card driver-controls"><div className="card-heading"><h2>Driver controls</h2><span className={`badge ${profile?.is_online ? 'online' : ''}`}>{profile?.is_online ? 'Online' : 'Offline'}</span></div>
    <div className="button-row"><button className="primary" disabled={busy} onClick={() => void action(() => api(`/drivers/me/${profile?.is_online ? 'offline' : 'online'}`, token, { method: 'POST' }), profile?.is_online ? 'You are offline' : 'You are online')}>{profile?.is_online ? 'Go offline' : 'Go online'}</button><button className="secondary" disabled={!profile?.is_online} onClick={toggleGps}>{gpsActive ? 'Stop GPS' : 'Share live GPS'}</button></div>
    <div className="manual-location"><span className="muted">GPS simulator</span><input aria-label="Latitude" type="number" step="any" value={lat} onChange={(event) => setLat(event.target.value)} /><input aria-label="Longitude" type="number" step="any" value={lng} onChange={(event) => setLng(event.target.value)} /><button className="secondary" disabled={!profile?.is_online} onClick={() => sendGps(Number(lat), Number(lng))}>Send location</button></div>
    {selected && <div className="assignment-actions"><strong>Selected job: #{shortId(selected.id)}</strong><div className="button-row">
      {selected.status === 'DRIVER_ASSIGNED' && <><button className="primary" disabled={busy} onClick={() => void action(() => api(`/deliveries/${selected.id}/accept`, token, { method: 'POST' }), 'Assignment accepted')}>Accept</button><button className="secondary" disabled={busy} onClick={() => void action(() => api(`/deliveries/${selected.id}/reject`, token, { method: 'POST' }), 'Assignment declined')}>Decline</button></>}
      {nextAction && <button className="primary" disabled={busy} onClick={() => void action(() => api(`/deliveries/${selected.id}/status`, token, { method: 'POST', body: JSON.stringify({ status: nextAction }) }), `Updated to ${nextAction.replaceAll('_', ' ')}`)}>Mark {nextAction.replaceAll('_', ' ')}</button>}
    </div></div>}
  </section>;
}

function AdminPanel({ token, drivers, jobs, metrics, selected, busy, action }: { token: string; drivers: Driver[]; jobs: Job[]; metrics: Metrics | null; selected: Delivery | null; busy: boolean; action: (work: () => Promise<unknown>, success: string) => Promise<void> }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [driverId, setDriverId] = useState('');
  const [failureReason, setFailureReason] = useState('');
  function createDriver(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    void action(async () => {
      await api('/admin/drivers', token, { method: 'POST', body: JSON.stringify({ fullName, email, password }) });
      setFullName(''); setEmail(''); setPassword('');
    }, 'Driver account created');
  }
  return <div className="admin-stack">
    <div className="metric-grid"><div className="metric"><small>ONLINE DRIVERS</small><strong>{metrics?.drivers.online ?? 0}<span> / {metrics?.drivers.total ?? 0}</span></strong></div><div className="metric"><small>ACTIVE DELIVERIES</small><strong>{metrics?.deliveryStatuses.filter((row) => !['DELIVERED', 'FAILED', 'CANCELLED'].includes(row.status)).reduce((sum, row) => sum + row.count, 0) ?? 0}</strong></div><div className="metric"><small>DEAD JOBS</small><strong>{jobs.length}</strong></div><div className="metric"><small>NOTIFICATIONS</small><strong>{metrics?.notifications.total ?? 0}</strong></div></div>
    <div className="admin-grid"><section className="card"><h2>Create driver</h2><form className="stack-form" onSubmit={createDriver}><label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} required /></label><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Temporary password<input type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button className="primary" disabled={busy}>Create driver</button></form></section>
      <section className="card"><h2>Assign a driver</h2><p className="muted">Selected delivery: {selected ? `#${shortId(selected.id)}` : 'none'}</p><select value={driverId} onChange={(event) => setDriverId(event.target.value)}><option value="">Choose an online driver</option>{drivers.filter((driver) => driver.is_online && !driver.active_delivery_id).map((driver) => <option key={driver.id} value={driver.id}>{driver.full_name}</option>)}</select><button className="primary" disabled={!selected || !driverId || busy} onClick={() => void action(() => api(`/admin/deliveries/${selected!.id}/assign`, token, { method: 'POST', body: JSON.stringify({ driverId }) }), 'Driver assigned')}>Assign / reassign</button><label>Failure reason<input value={failureReason} onChange={(event) => setFailureReason(event.target.value)} placeholder="Only for a failed delivery" /></label><button className="secondary" disabled={!selected || failureReason.trim().length < 3 || busy} onClick={() => void action(() => api(`/admin/deliveries/${selected!.id}/fail`, token, { method: 'POST', body: JSON.stringify({ reason: failureReason }) }), 'Delivery marked failed')}>Mark selected delivery failed</button></section></div>
    <section className="card"><div className="card-heading"><h2>Fleet</h2><span className="count">{drivers.length}</span></div><div className="table-wrap"><table><thead><tr><th>Driver</th><th>Status</th><th>Last seen</th><th>Assignment</th></tr></thead><tbody>{drivers.map((driver) => <tr key={driver.id}><td>{driver.full_name}<small>{driver.email}</small></td><td>{driver.is_online ? 'Online' : 'Offline'}</td><td>{driver.last_seen_at ? date(driver.last_seen_at) : '—'}</td><td>{driver.active_delivery_id ? `#${shortId(driver.active_delivery_id)}` : 'Available'}</td></tr>)}</tbody></table></div></section>
    {jobs.length > 0 && <section className="card"><h2>Failed assignment jobs</h2>{jobs.map((job) => <div className="failed-job" key={job.id}><div><strong>#{shortId(job.payload.deliveryId)}</strong><p>{job.last_error}</p></div><button className="secondary" onClick={() => void action(() => api(`/admin/jobs/${job.id}/retry`, token, { method: 'POST' }), 'Job queued for retry')}>Retry</button></div>)}</section>}
  </div>;
}
