'use client';

import { useEffect, useState } from 'react';
import { Dashboard } from '../components/Dashboard';
import type { Session } from '../lib/types';

export default function HomePage() {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);

  useEffect(() => {
    fetch('/api/health').then((response) => setApiOnline(response.ok)).catch(() => setApiOnline(false));
  }, []);

  async function submit(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'register' ? { fullName, email, password } : { email, password }),
      });
      const body = await response.json() as Session | { error: string };
      if (!response.ok || !('token' in body)) throw new Error('error' in body ? body.error : 'Authentication failed');
      setSession(body);
      setPassword('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  }

  if (session) return <Dashboard session={session} onSignOut={() => setSession(null)} />;

  return <main className="auth-page">
    <div className="auth-visual">
      <div className="auth-brand"><span className="brand-mark">↗</span> FleetFlow</div>
      <div className="auth-story"><p className="eyebrow">REAL-TIME FLEET OPERATIONS</p><h1>Every delivery.<br /><span>In motion.</span></h1><p>Coordinate drivers, follow live routes, and keep every handoff visible from pickup to doorstep.</p></div>
      <div className="auth-lines"><span /><span /><span /></div>
      <div className="auth-caption">BUILT FOR THE MOMENTS BETWEEN DISPATCH AND DELIVERY</div>
    </div>
    <div className="auth-form-side"><div className="auth-card"><p className="eyebrow">WELCOME TO FLEETFLOW</p><h2>{mode === 'login' ? 'Sign in to your workspace' : 'Create a customer account'}</h2><p className="muted">{mode === 'login' ? 'Your deliveries and fleet activity, all in one place.' : 'Start tracking your deliveries in real time.'}</p>
      <div className="auth-tabs"><button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>Sign in</button><button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>Register</button></div>
      <form className="stack-form" onSubmit={submit}>
        {mode === 'register' && <label>Full name<input value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" required /></label>}
        <label>Email address<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
        <label>Password<input type="password" minLength={mode === 'register' ? 12 : undefined} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary auth-submit" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in →' : 'Create account →'}</button>
      </form>
      <p className="api-indicator"><span className={apiOnline ? 'live-dot' : 'offline-dot'} />{apiOnline === null ? 'Checking API' : apiOnline ? 'API connected' : 'API unavailable — start the backend'}</p>
    </div></div>
  </main>;
}
