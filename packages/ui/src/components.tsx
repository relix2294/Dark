import type { ReactNode } from 'react';
import { ApiError } from './api.js';

export function Screen({ title, actions, children, narrow }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; narrow?: boolean }) {
  return (
    <div className={`screen${narrow ? ' screen-narrow' : ''}`}>
      {(title || actions) && (
        <header className="screen-header">
          <h1>{title}</h1>
          <div className="screen-actions">{actions}</div>
        </header>
      )}
      <main className="screen-body">{children}</main>
    </div>
  );
}

export function Button({
  children,
  onClick,
  primary,
  danger,
  big,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean | undefined;
  danger?: boolean | undefined;
  big?: boolean | undefined;
  disabled?: boolean | undefined;
  type?: 'button' | 'submit';
}) {
  const cls = ['btn', primary && 'btn-primary', danger && 'btn-danger', big && 'btn-big'].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Card({ children, tone, onClick }: { children: ReactNode; tone?: 'grey' | 'yellow' | 'red' | 'green' | 'done' | undefined; onClick?: (() => void) | undefined }) {
  return (
    <div className={`card${tone ? ` tone-${tone}` : ''}${onClick ? ' card-click' : ''}`} onClick={onClick}>
      {children}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: 'grey' | 'yellow' | 'red' | 'green' | 'blue' | undefined }) {
  return <span className={`badge badge-${tone ?? 'grey'}`}>{children}</span>;
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof ApiError ? `${error.message}${error.code ? ` (${error.code})` : ''}` : String((error as Error)?.message ?? error);
  return <div className="banner banner-error">{msg}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <div className="spinner" aria-label="загрузка" />;
}

/** Цифровая клавиатура для количества / веса / PIN — работа одной рукой (ТЗ §9). */
export function NumPad({ value, onChange, onEnter, allowDot }: { value: string; onChange: (v: string) => void; onEnter?: () => void; allowDot?: boolean }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDot ? '.' : '', '0', '⌫'];
  return (
    <div className="numpad">
      {keys.map((k, i) => (
        <button
          key={i}
          type="button"
          className="numpad-key"
          disabled={k === ''}
          onClick={() => {
            if (k === '⌫') onChange(value.slice(0, -1));
            else onChange(value + k);
          }}
        >
          {k}
        </button>
      ))}
      {onEnter && (
        <button type="button" className="numpad-key numpad-enter" onClick={onEnter}>
          OK
        </button>
      )}
    </div>
  );
}

/** Статус заказа цветом. */
export function statusTone(status: string): 'grey' | 'yellow' | 'red' | 'green' | 'blue' {
  switch (status) {
    case 'ready':
      return 'green';
    case 'on_the_way':
      return 'blue';
    case 'picking':
    case 'cooking':
      return 'yellow';
    case 'returning':
    case 'payment_failed':
    case 'cancelled':
      return 'red';
    default:
      return 'grey';
  }
}
