import { useState } from 'react';
import { Button, Screen, useStaff } from '@dark/ui';
import { Picking } from './Picking.js';
import { Receiving } from './Receiving.js';

type Tab = 'pick' | 'receive';

/** Терминал сборщика (ТЗ §7, §9): крупные элементы, одна рука, сканер вместо ввода текста. */
export function App() {
  const { logout } = useStaff();
  const [tab, setTab] = useState<Tab>('pick');
  return (
    <Screen
      title={tab === 'pick' ? 'Сборка' : 'Приёмка и размещение'}
      actions={<Button onClick={logout}>Выйти</Button>}
    >
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>{tab === 'pick' ? <Picking /> : <Receiving />}</div>
      <nav className="bottom-nav">
        <button className={tab === 'pick' ? 'active' : ''} onClick={() => setTab('pick')}>
          Сборка
        </button>
        <button className={tab === 'receive' ? 'active' : ''} onClick={() => setTab('receive')}>
          Приёмка
        </button>
      </nav>
    </Screen>
  );
}
