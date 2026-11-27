import { useState } from 'react';
import { Button, Screen, useStaff } from '@dark/ui';
import { Console } from './Console.js';
import { Params } from './Params.js';
import { Audit } from './Audit.js';

type Tab = 'console' | 'params' | 'audit';

/** Админка и пульт старшего смены (ТЗ §9). Этап 1: пульт, параметры, журнал. Каталог, цены, промо — следующие экраны. */
export function App() {
  const { session, logout } = useStaff();
  const [tab, setTab] = useState<Tab>('console');
  const storeId = session.principal.store_id;
  const [store, setStore] = useState<string>(storeId ?? localStorage.getItem('dark.backoffice.store') ?? '');

  return (
    <Screen
      title={
        <div className="tabs">
          {(['console', 'params', 'audit'] as Tab[]).map((t) => (
            <button key={t} className={`tab${tab === t ? ' tab-active' : ''}`} onClick={() => setTab(t)}>
              {{ console: 'Пульт', params: 'Параметры', audit: 'Журнал' }[t]}
            </button>
          ))}
        </div>
      }
      actions={
        <>
          {!storeId && (
            <input
              className="input"
              style={{ width: 320 }}
              placeholder="store_id (admin/finance)"
              value={store}
              onChange={(e) => {
                setStore(e.target.value);
                localStorage.setItem('dark.backoffice.store', e.target.value);
              }}
            />
          )}
          <span className="muted">{session.principal.role}</span>
          <Button onClick={logout}>Выйти</Button>
        </>
      }
    >
      {!store ? (
        <div className="empty">Укажите точку</div>
      ) : tab === 'console' ? (
        <Console storeId={store} />
      ) : tab === 'params' ? (
        <Params storeId={store} />
      ) : (
        <Audit />
      )}
    </Screen>
  );
}
