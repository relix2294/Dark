import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DeviceApp, StaffPrincipal } from '@dark/contracts';
import { ApiError, createApi, type Api } from './api.js';
import { Button, Field, Screen } from './components.js';

type Session = { token: string; principal: StaffPrincipal; expiresAt: string };

const Ctx = createContext<{ api: Api; session: Session; logout: () => void } | null>(null);

function decode(token: string): StaffPrincipal | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { p: StaffPrincipal; exp: number };
    if (payload.exp * 1000 < Date.now()) return null;
    return payload.p;
  } catch {
    return null;
  }
}

/** Постоянный id устройства (браузера терминала) — для контроля связи на пульте. */
function deviceId() {
  const k = 'dark.device.id';
  try {
    let id = localStorage.getItem(k);
    if (!id) localStorage.setItem(k, (id = crypto.randomUUID()));
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const HEARTBEAT_MS = 30_000;

/**
 * Провайдер API и сессии персонала: вход по телефону и PIN, токен в localStorage, выход по 401.
 * heartbeat — устройство точки (терминал, экран кухни): пульс раз в 30 с, при выходе — «прощание» (ТЗ §10).
 */
export function StaffAuthProvider({ app, children, roles, heartbeat }: { app: string; children: ReactNode; roles?: string[]; heartbeat?: DeviceApp }) {
  const [session, setSession] = useState<Session | null>(null);
  const api = useMemo<Api>(
    () =>
      createApi({
        tokenKey: `dark.${app}.token`,
        onUnauthorized: () => {
          setSession(null);
        },
      }),
    [app],
  );
  useEffect(() => {
    const t = api.token.get();
    const p = t ? decode(t) : null;
    if (t && p) setSession({ token: t, principal: p, expiresAt: '' });
    else api.token.set(null);
  }, [api]);
  const loggedIn = !!session;
  useEffect(() => {
    if (!heartbeat || !loggedIn) return;
    const send = () => void api.post('/staff/heartbeat', { device_id: deviceId(), app: heartbeat }).catch(() => undefined);
    send();
    const t = setInterval(send, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [api, heartbeat, loggedIn]);
  const logout = useCallback(() => {
    // штатный выход: пульт не поднимет тревогу «не на связи»
    if (heartbeat) void api.post('/staff/heartbeat', { device_id: deviceId(), app: heartbeat, bye: true }).catch(() => undefined);
    api.token.set(null);
    setSession(null);
  }, [api, heartbeat]);

  if (!session) return <StaffLogin api={api} roles={roles} onDone={(s) => setSession(s)} />;
  return <Ctx.Provider value={{ api, session, logout }}>{children}</Ctx.Provider>;
}

export function useStaff() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStaff вне StaffAuthProvider');
  return v;
}

function StaffLogin({ api, roles, onDone }: { api: Api; roles?: string[] | undefined; onDone: (s: Session) => void }) {
  const [phone, setPhone] = useState(localStorage.getItem('dark.lastPhone') ?? '+992');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ token: string; expires_at: string }>('/auth/staff', { phone, pin });
      const p = decode(r.token);
      if (!p) throw new Error('Токен не разобран');
      if (roles && !roles.includes(p.role)) {
        setError(`Это приложение для ролей: ${roles.join(', ')}. Ваша роль — ${p.role}.`);
        return;
      }
      api.token.set(r.token);
      localStorage.setItem('dark.lastPhone', phone);
      onDone({ token: r.token, principal: p, expiresAt: r.expires_at });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setPin('');
    }
  };

  return (
    <Screen title="Вход" narrow>
      <Field label="Телефон">
        <input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="username" />
      </Field>
      <Field label="PIN">
        <input className="input input-pin" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} autoComplete="current-password" onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
      {error && <div className="banner banner-error">{error}</div>}
      <Button big primary disabled={busy || pin.length < 4} onClick={() => void submit()}>
        Войти
      </Button>
    </Screen>
  );
}
