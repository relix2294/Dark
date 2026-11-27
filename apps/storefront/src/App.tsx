import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type { AddressListView, AddressView, Brand, CartResponse, CatalogResponse, DishModifiers, ModifierSelection, OrderListView, OrderView, ResolveStoreResponse } from '@dark/contracts';
import { ApiError, BRAND_RU, Badge, Button, Card, ErrorBanner, Field, MapView, ORDER_STATUS_RU, Screen, Spinner, createApi, somoni, statusTone, time } from '@dark/ui';

type Address = z.infer<typeof AddressView>;
type Catalog = z.infer<typeof CatalogResponse>;
type Cart = z.infer<typeof CartResponse>;
type Order = z.infer<typeof OrderView>;
type Resolve = z.infer<typeof ResolveStoreResponse>;

const api = createApi({ tokenKey: 'dark.store.token' });
type Line = { product_id: string; qty: number; modifiers?: ModifierSelection };
type CatalogItem = Catalog['items'][number];
type Tab = 'shop' | 'orders';

/**
 * Витрина клиента внутри DC Next (ТЗ §9): бренд → адрес → каталог → корзина → оформление → статус с картой → история.
 * Вход — обменом токена DC Next; в разработке принимается токен вида dc:<id>.
 */
export function App() {
  const [token, setToken] = useState<string | null>(api.token.get());
  if (!token) return <DcLogin onDone={(t) => setToken(t)} />;
  return <Shop onLogout={() => { api.token.set(null); setToken(null); }} />;
}

function DcLogin({ onDone }: { onDone: (t: string) => void }) {
  const [dc, setDc] = useState('dc:demo-user');
  const [error, setError] = useState<unknown>(null);
  const login = async () => {
    try {
      const r = await api.post<{ token: string }>('/auth/dc', { dc_token: dc });
      api.token.set(r.token);
      onDone(r.token);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Screen title="Lablabu · Sor Box" narrow>
      <p className="muted">В приложении банка вход происходит автоматически. Для разработки введите тестовый токен DC Next.</p>
      <Field label="Токен DC Next">
        <input className="input" value={dc} onChange={(e) => setDc(e.target.value)} />
      </Field>
      <ErrorBanner error={error} />
      <Button big primary onClick={() => void login()}>
        Войти
      </Button>
    </Screen>
  );
}

function Shop({ onLogout }: { onLogout: () => void }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('shop');
  const [brand, setBrand] = useState<Brand>((localStorage.getItem('dark.store.brand') as Brand) ?? 'LAB');
  const [address, setAddress] = useState<Address | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [promo, setPromo] = useState('');
  const [tracking, setTracking] = useState<string | null>(null);

  const addresses = useQuery({ queryKey: ['addresses'], queryFn: () => api.get<z.infer<typeof AddressListView>>('/addresses') });
  useEffect(() => {
    if (!address && addresses.data?.addresses[0]) setAddress(addresses.data.addresses[0]);
  }, [addresses.data, address]);

  const resolve = useQuery({
    queryKey: ['resolve', brand, address?.id],
    enabled: !!address,
    queryFn: () => api.get<Resolve>(`/stores/resolve?lat=${address!.lat}&lon=${address!.lon}&brand=${brand}`),
    retry: false,
  });
  const storeId = resolve.data?.store_id;
  const catalog = useQuery({ queryKey: ['catalog', storeId, brand], enabled: !!storeId, queryFn: () => api.get<Catalog>(`/catalog?store_id=${storeId}&brand=${brand}`), refetchInterval: 10_000 });

  const cartBody = useMemo(() => (storeId && address ? { brand, store_id: storeId, address_id: address.id, items: lines, ...(promo ? { promo_code: promo } : {}) } : null), [brand, storeId, address, lines, promo]);
  const cart = useQuery({ queryKey: ['cart', cartBody], enabled: !!cartBody && lines.length > 0, queryFn: () => api.put<Cart>('/cart', cartBody) });

  const place = useMutation({
    mutationFn: async () => {
      const c = cart.data!;
      return api.post<Order>('/orders', { ...cartBody, expected_total_dirams: c.total_dirams, comment: '' }, crypto.randomUUID());
    },
    onSuccess: (o) => {
      setLines([]);
      setTracking(o.id);
      void qc.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: () => void qc.invalidateQueries({ queryKey: ['cart'] }), // PRICE_CHANGED → корзина пересчитана, клиент подтверждает заново
  });

  const setQty = (id: string, qty: number) => setLines((ls) => (qty <= 0 ? ls.filter((l) => l.product_id !== id) : ls.some((l) => l.product_id === id) ? ls.map((l) => (l.product_id === id ? { ...l, qty } : l)) : [...ls, { product_id: id, qty }]));
  const qtyOf = (id: string) => lines.filter((l) => l.product_id === id).reduce((a, l) => a + l.qty, 0);
  // блюдо с модификаторами: каждое «+» — отдельная строка со своим выбором; «−» убирает последнюю
  const [picking, setPicking] = useState<CatalogItem | null>(null);
  const plus = (p: CatalogItem) => (p.modifiers ? setPicking(p) : setQty(p.product_id, qtyOf(p.product_id) + (p.is_weighted ? 100 : 1)));
  const minus = (p: CatalogItem) => {
    if (!p.modifiers) return setQty(p.product_id, qtyOf(p.product_id) - (p.is_weighted ? 100 : 1));
    setLines((ls) => {
      const i = ls.map((l) => l.product_id).lastIndexOf(p.product_id);
      return i < 0 ? ls : ls.filter((_, j) => j !== i);
    });
  };

  if (tracking) return <Tracking orderId={tracking} onBack={() => setTracking(null)} />;

  return (
    <Screen
      title={
        <div className="tabs">
          {(['LAB', 'SOR'] as Brand[]).map((b) => (
            <button key={b} className={`tab${brand === b ? ' tab-active' : ''}`} onClick={() => { setBrand(b); setLines([]); localStorage.setItem('dark.store.brand', b); }}>
              {BRAND_RU[b]}
            </button>
          ))}
        </div>
      }
      actions={<Button onClick={onLogout}>Выйти</Button>}
    >
      {tab === 'orders' ? (
        <History onOpen={setTracking} />
      ) : (
        <>
          <AddressPicker brand={brand} addresses={addresses.data?.addresses ?? []} value={address} onChange={setAddress} />
          {address && resolve.error && <ErrorBanner error={resolve.error} />}
          {resolve.data && (
            <div className="muted">
              Доставка {somoni(resolve.data.fee_dirams)} · {resolve.data.eta_min}–{resolve.data.eta_max} мин · минимум {somoni(resolve.data.min_order_dirams)}
              {!resolve.data.is_open && <Badge tone="red"> точка закрыта</Badge>}
            </div>
          )}
          {catalog.isLoading && <Spinner />}
          <div className="grid">
            {(catalog.data?.items ?? []).map((p) => (
              <Card key={p.product_id} tone={p.in_stock ? undefined : 'grey'}>
                <div className="row">
                  <b>{p.name_ru}</b>
                  <span>{somoni(p.price_dirams)}{p.is_weighted ? '/кг' : ''}</span>
                </div>
                {!p.in_stock ? (
                  <span className="muted">нет в наличии</span>
                ) : (
                  <div className="row">
                    <Button onClick={() => minus(p)} disabled={qtyOf(p.product_id) === 0}>−</Button>
                    <b>{qtyOf(p.product_id) ? (p.is_weighted ? `${qtyOf(p.product_id)} г` : qtyOf(p.product_id)) : ''}</b>
                    <Button primary onClick={() => plus(p)}>{p.modifiers ? 'Выбрать' : '+'}</Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
          {picking?.modifiers && (
            <ModifierPicker
              item={picking}
              def={picking.modifiers}
              onCancel={() => setPicking(null)}
              onDone={(modifiers) => {
                setLines((ls) => [...ls, { product_id: picking.product_id, qty: 1, modifiers }]);
                setPicking(null);
              }}
            />
          )}
          {cart.error && <ErrorBanner error={cart.error} />}
          {lines.length > 0 && (
            <Card tone="yellow">
              <h2>Корзина</h2>
              {cart.data?.lines.map((l, i) => (
                <div key={i} className="row">
                  <span>
                    {l.name} ×{l.qty} {!l.available && <Badge tone="red">недоступно</Badge>}
                    {l.modifiers.length > 0 && <div className="muted">{l.modifiers.map((g) => g.options.map((o) => o.name).join(', ')).join(' · ')}</div>}
                  </span>
                  <span>{somoni(l.line_total_dirams)}</span>
                </div>
              ))}
              <Field label="Промокод">
                <input className="input" value={promo} onChange={(e) => setPromo(e.target.value.toUpperCase())} />
              </Field>
              {cart.data?.promo_error && <div className="banner banner-error">{cart.data.promo_error}</div>}
              {cart.data && (
                <>
                  <div className="row muted">
                    <span>Товары</span>
                    <span>{somoni(cart.data.items_total_dirams)}</span>
                  </div>
                  <div className="row muted">
                    <span>Доставка</span>
                    <span>{somoni(cart.data.delivery_fee_dirams)}</span>
                  </div>
                  {cart.data.discount_dirams > 0 && (
                    <div className="row muted">
                      <span>Скидка {cart.data.promo_applied}</span>
                      <span>−{somoni(cart.data.discount_dirams)}</span>
                    </div>
                  )}
                  <div className="row big">
                    <span>Итого</span>
                    <span>{somoni(cart.data.total_dirams)}</span>
                  </div>
                  <div className="muted">Доставим примерно через {cart.data.eta_minutes} мин</div>
                  {cart.data.eta_warning && (
                    <div className="banner banner-error">Кухня сейчас загружена: ожидание около {cart.data.eta_minutes} минут. Оформить всё равно?</div>
                  )}
                  {!cart.data.accepts_orders && <div className="banner banner-error">Точка скоро закрывается — заказы больше не принимаются</div>}
                </>
              )}
              <ErrorBanner error={place.error instanceof ApiError && place.error.code === 'PRICE_CHANGED' ? new ApiError(409, 'PRICE_CHANGED', 'Сумма изменилась, проверьте корзину и подтвердите заново') : place.error} />
              <Button big primary disabled={!cart.data || cart.data.unavailable_product_ids.length > 0 || place.isPending || !cart.data.accepts_orders} onClick={() => place.mutate()}>
                Оплатить {cart.data ? somoni(cart.data.total_dirams) : ''}
              </Button>
            </Card>
          )}
        </>
      )}
      <nav className="bottom-nav">
        <button className={tab === 'shop' ? 'active' : ''} onClick={() => setTab('shop')}>Каталог</button>
        <button className={tab === 'orders' ? 'active' : ''} onClick={() => setTab('orders')}>Мои заказы</button>
      </nav>
    </Screen>
  );
}

function AddressPicker({ brand, addresses, value, onChange }: { brand: Brand; addresses: Address[]; value: Address | null; onChange: (a: Address) => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(addresses.length === 0);
  const [form, setForm] = useState({ street: '', house: '', flat: '', lat: 38.5598, lon: 68.787 });
  const create = useMutation({
    mutationFn: () => api.post<Address>('/addresses', { lat: form.lat, lon: form.lon, street: form.street, house: form.house, ...(form.flat ? { flat: form.flat } : {}) }),
    onSuccess: (a) => {
      onChange(a);
      setAdding(false);
      void qc.invalidateQueries({ queryKey: ['addresses'] });
    },
  });
  useEffect(() => {
    if (adding && navigator.geolocation) navigator.geolocation.getCurrentPosition((p) => setForm((f) => ({ ...f, lat: p.coords.latitude, lon: p.coords.longitude })), () => undefined, { timeout: 5000 });
  }, [adding]);
  // проверка зоны для выбранной точки — до сохранения адреса, чтобы клиент сразу видел «вне зоны»
  const zone = useQuery({
    queryKey: ['zone-check', brand, form.lat.toFixed(5), form.lon.toFixed(5)],
    enabled: adding,
    retry: false,
    queryFn: () => api.get<Resolve>(`/stores/resolve?lat=${form.lat}&lon=${form.lon}&brand=${brand}`),
  });
  if (!adding && value)
    return (
      <div className="row">
        <span>
          📍 {value.street}, {value.house}
          {value.flat ? `, кв. ${value.flat}` : ''}
        </span>
        <div className="row">
          {addresses.length > 1 && (
            <select className="input" value={value.id} onChange={(e) => onChange(addresses.find((a) => a.id === e.target.value)!)}>
              {addresses.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.street}, {a.house}
                </option>
              ))}
            </select>
          )}
          <Button onClick={() => setAdding(true)}>Новый</Button>
        </div>
      </div>
    );
  return (
    <Card>
      <h2>Адрес доставки</h2>
      <div className="muted">Нажмите на карту, чтобы уточнить точку доставки.</div>
      <MapView center={{ lat: form.lat, lon: form.lon }} zoom={16} height={240} onClick={(p) => setForm({ ...form, lat: p.lat, lon: p.lon })} markers={[{ id: 'pin', lat: form.lat, lon: form.lon, color: '#ff5b5b', radius: 10, title: 'сюда' }]} />
      {zone.data ? (
        <div className="banner banner-ok">
          В зоне доставки {BRAND_RU[brand]}: {somoni(zone.data.fee_dirams)}, {zone.data.eta_min}–{zone.data.eta_max} мин
        </div>
      ) : zone.error ? (
        <div className="banner banner-error">Этот адрес вне зоны доставки {BRAND_RU[brand]}</div>
      ) : null}
      <Field label="Улица">
        <input className="input" value={form.street} onChange={(e) => setForm({ ...form, street: e.target.value })} />
      </Field>
      <div className="row">
        <Field label="Дом">
          <input className="input" value={form.house} onChange={(e) => setForm({ ...form, house: e.target.value })} />
        </Field>
        <Field label="Квартира">
          <input className="input" value={form.flat} onChange={(e) => setForm({ ...form, flat: e.target.value })} />
        </Field>
      </div>
      <ErrorBanner error={create.error} />
      <Button big primary disabled={!form.street || !form.house || create.isPending} onClick={() => create.mutate()}>
        Сохранить адрес
      </Button>
    </Card>
  );
}

/** Статус заказа: SSE со сменой статуса и позицией курьера раз в 5 с (ТЗ §4). */
function Tracking({ orderId, onBack }: { orderId: string; onBack: () => void }) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<Order>(`/orders/${orderId}`).then(setOrder).catch(setError);
    return api.stream(`/orders/${orderId}/stream`, (ev, data) => {
      if (ev === 'order') setOrder(data as Order);
    });
  }, [orderId]);
  const cancel = useMutation({
    mutationFn: () => api.post<Order>(`/orders/${orderId}/cancel`, { reason: 'клиент' }),
    onSuccess: setOrder,
    onError: setError,
  });
  if (!order) return <Spinner />;
  return (
    <Screen title={`Заказ ${order.number}`} actions={<Button onClick={onBack}>← Назад</Button>} narrow>
      <Card tone={statusTone(order.status) === 'red' ? 'red' : statusTone(order.status) === 'green' ? 'green' : undefined}>
        <div className="big">{ORDER_STATUS_RU[order.status]}</div>
        {order.promised_at && !['delivered', 'cancelled', 'returned'].includes(order.status) && <div className="muted">Доставим к {time(order.promised_at)}</div>}
        {order.courier && (
          <div>
            Курьер: <b>{order.courier.name}</b>
            {order.courier.position && (
              <a className="muted" style={{ marginLeft: 8 }} href={`https://www.openstreetmap.org/?mlat=${order.courier.position.lat}&mlon=${order.courier.position.lon}#map=16/${order.courier.position.lat}/${order.courier.position.lon}`} target="_blank" rel="noreferrer">
                на карте ↗
              </a>
            )}
          </div>
        )}
      </Card>
      <Card>
        {order.items.map((i) => (
          <div key={i.id} className="row">
            <span>
              {i.name_snapshot} ×{i.qty_ordered}
              {i.modifiers && i.modifiers.length > 0 && <span className="muted"> ({i.modifiers.map((g) => g.options.map((o) => o.name).join(', ')).join('; ')})</span>}
              {i.status === 'missing' && <Badge tone="red"> нет</Badge>}
              {i.status === 'replaced' && <Badge tone="yellow"> заменён</Badge>}
            </span>
            <span>{somoni(i.price_dirams)}</span>
          </div>
        ))}
        <div className="row big">
          <span>Итого</span>
          <span>{somoni(order.captured_dirams ?? order.total_dirams)}</span>
        </div>
      </Card>
      <ErrorBanner error={error} />
      {['created', 'paid_hold'].includes(order.status) && (
        <Button danger disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          Отменить заказ
        </Button>
      )}
    </Screen>
  );
}

function History({ onOpen }: { onOpen: (id: string) => void }) {
  const q = useQuery({ queryKey: ['orders'], queryFn: () => api.get<z.infer<typeof OrderListView>>('/orders'), refetchInterval: 10_000 });
  if (q.isLoading) return <Spinner />;
  return (
    <>
      <ErrorBanner error={q.error} />
      {(q.data?.orders ?? []).length === 0 && <div className="empty">Заказов пока нет</div>}
      {(q.data?.orders ?? []).map((o) => (
        <Card key={o.id} onClick={() => onOpen(o.id)}>
          <div className="row">
            <b>
              {BRAND_RU[o.brand]} · {o.number}
            </b>
            <Badge tone={statusTone(o.status)}>{ORDER_STATUS_RU[o.status]}</Badge>
          </div>
          <div className="muted">
            {time(o.created_at)} · {o.items.length} позиций · {somoni(o.captured_dirams ?? o.total_dirams)}
          </div>
        </Card>
      ))}
    </>
  );
}

/** Выбор модификаторов блюда: обязательные группы, лимит вариантов, итоговая цена до добавления. */
function ModifierPicker({ item, def, onDone, onCancel }: { item: CatalogItem; def: DishModifiers; onDone: (m: ModifierSelection) => void; onCancel: () => void }) {
  const [sel, setSel] = useState<ModifierSelection>(() => Object.fromEntries(def.groups.filter((g) => g.min === 1 && g.max === 1).map((g) => [g.id, [g.options[0]!.id]])));
  const toggle = (gid: string, oid: string, max: number) =>
    setSel((s) => {
      const cur = s[gid] ?? [];
      if (cur.includes(oid)) return { ...s, [gid]: cur.filter((x) => x !== oid) };
      if (max === 1) return { ...s, [gid]: [oid] };
      return cur.length >= max ? s : { ...s, [gid]: [...cur, oid] };
    });
  const ok = def.groups.every((g) => (sel[g.id]?.length ?? 0) >= g.min);
  const extra = def.groups.reduce((a, g) => a + (sel[g.id] ?? []).reduce((b, id) => b + (g.options.find((o) => o.id === id)?.price_dirams ?? 0), 0), 0);
  return (
    <div className="modal">
      <Card>
        <div className="row">
          <h2>{item.name_ru}</h2>
          <Button onClick={onCancel}>✕</Button>
        </div>
        {def.groups.map((g) => (
          <div key={g.id}>
            <div className="muted">
              {g.name} {g.min > 0 ? '(обязательно)' : ''} {g.max > 1 ? `— до ${g.max}` : ''}
            </div>
            <div className="row" style={{ justifyContent: 'flex-start', flexWrap: 'wrap' }}>
              {g.options.map((o) => (
                <Button key={o.id} primary={(sel[g.id] ?? []).includes(o.id)} onClick={() => toggle(g.id, o.id, g.max)}>
                  {o.name}
                  {o.price_dirams ? ` +${somoni(o.price_dirams)}` : ''}
                </Button>
              ))}
            </div>
          </div>
        ))}
        <Button big primary disabled={!ok} onClick={() => onDone(sel)}>
          В корзину · {somoni(item.price_dirams + extra)}
        </Button>
      </Card>
    </div>
  );
}
