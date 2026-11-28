import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import type { StaffRole, StoreListView } from '@dark/contracts';
import { Badge, Button, Screen, liveTitle, useLive, useStaff } from '@dark/ui';
import { Console } from './Console.js';
import { Params } from './Params.js';
import { Audit } from './Audit.js';
import { Catalog } from './Catalog.js';
import { Zones } from './Zones.js';
import { Promos } from './Promos.js';
import { Staff } from './Staff.js';
import { Warehouse } from './Warehouse.js';
import { Plan } from './Plan.js';
import { Reports } from './Reports.js';
import { Import } from './Import.js';
import { Payouts } from './Payouts.js';

type Tab = 'console' | 'catalog' | 'import' | 'warehouse' | 'zones' | 'promo' | 'staff' | 'plan' | 'payouts' | 'reports' | 'params' | 'audit';

/** Вкладки по ролям — по матрице прав ТЗ §9 (сервер всё равно проверяет каждый запрос). */
const TABS: { id: Tab; title: string; roles: StaffRole[] }[] = [
  { id: 'console', title: 'Пульт', roles: ['shift_lead', 'manager'] },
  { id: 'catalog', title: 'Каталог', roles: ['manager', 'admin'] },
  { id: 'import', title: 'Импорт', roles: ['manager', 'admin'] },
  { id: 'warehouse', title: 'Склад', roles: ['shift_lead', 'manager', 'admin'] },
  { id: 'zones', title: 'Зоны', roles: ['manager', 'admin'] },
  { id: 'promo', title: 'Промо', roles: ['manager', 'admin'] },
  { id: 'staff', title: 'Персонал', roles: ['manager', 'admin'] },
  { id: 'plan', title: 'Курьеры', roles: ['shift_lead', 'manager', 'admin'] },
  { id: 'payouts', title: 'Выплаты', roles: ['manager', 'finance'] },
  { id: 'reports', title: 'Отчёты', roles: ['shift_lead', 'manager', 'finance'] },
  { id: 'params', title: 'Параметры', roles: ['shift_lead', 'manager', 'admin'] },
  { id: 'audit', title: 'Журнал', roles: ['shift_lead', 'manager', 'admin', 'finance'] },
];

export function App() {
  const { api, session, logout } = useStaff();
  const role = session.principal.role;
  const tabs = TABS.filter((t) => t.roles.includes(role));
  const [tab, setTab] = useState<Tab>(tabs[0]?.id ?? 'audit');
  const own = session.principal.store_id;
  const stores = useQuery({ queryKey: ['stores'], queryFn: () => api.get<z.infer<typeof StoreListView>>('/admin/stores'), refetchInterval: false });
  const [store, setStore] = useState<string>(own ?? localStorage.getItem('dark.backoffice.store') ?? '');
  useEffect(() => {
    if (!store && stores.data?.stores[0]) setStore(stores.data.stores[0].id);
  }, [store, stores.data]);
  const live = useLive(api, { storeId: store || null });

  return (
    <Screen
      title={
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={`tab${tab === t.id ? ' tab-active' : ''}`} onClick={() => setTab(t.id)}>
              {t.title}
            </button>
          ))}
        </div>
      }
      actions={
        <>
          {!own && (
            <select
              className="input"
              style={{ width: 220 }}
              value={store}
              onChange={(e) => {
                setStore(e.target.value);
                localStorage.setItem('dark.backoffice.store', e.target.value);
              }}
            >
              {(stores.data?.stores ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} · {s.name}
                </option>
              ))}
            </select>
          )}
          <Badge tone={live ? 'green' : 'red'}>{liveTitle(live)}</Badge>
          <span className="muted">{role}</span>
          <Button onClick={logout}>Выйти</Button>
        </>
      }
    >
      {!store ? (
        <div className="empty">Нет точки</div>
      ) : (
        {
          console: <Console storeId={store} storeGeo={stores.data?.stores.find((x) => x.id === store)?.geo ?? null} />,
          catalog: <Catalog storeId={store} />,
          import: <Import storeId={store} />,
          warehouse: <Warehouse storeId={store} />,
          zones: <Zones storeId={store} storeGeo={stores.data?.stores.find((x) => x.id === store)?.geo ?? null} />,
          promo: <Promos />,
          staff: <Staff storeId={store} />,
          plan: <Plan storeId={store} />,
          payouts: <Payouts storeId={store} />,
          reports: <Reports storeId={store} />,
          params: <Params storeId={store} />,
          audit: <Audit />,
        }[tab]
      )}
    </Screen>
  );
}
