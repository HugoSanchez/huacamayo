import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// Lightweight app-wide toast system. Mount <ToastProvider> once near the
// app root and call useToast() anywhere underneath to push a toast. Each
// toast can carry a single action button — clicking it both fires the
// callback and dismisses the toast.

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}

interface ToastInstance extends Required<Omit<ToastOptions, 'description' | 'action'>> {
  id: number;
  description?: string;
  action?: { label: string; onClick: () => void };
}

interface ToastContextValue {
  show: (options: ToastOptions) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION_MS = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastInstance[]>([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((options: ToastOptions) => {
    const id = ++idRef.current;
    const toast: ToastInstance = {
      id,
      title: options.title,
      description: options.description,
      tone: options.tone ?? 'info',
      durationMs: options.durationMs ?? DEFAULT_DURATION_MS,
      action: options.action,
    };
    setToasts((prev) => [...prev, toast]);
    return id;
  }, []);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div className="toaster" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Soft fallback so test renders / non-toast contexts don't blow up.
    return {
      show: () => -1,
      dismiss: () => undefined,
    };
  }
  return ctx;
}

function ToastItem({ toast, onDismiss }: { toast: ToastInstance; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (toast.durationMs <= 0) return;
    const handle = window.setTimeout(() => onDismiss(toast.id), toast.durationMs);
    return () => window.clearTimeout(handle);
  }, [toast.id, toast.durationMs, onDismiss]);

  const handleAction = () => {
    toast.action?.onClick();
    onDismiss(toast.id);
  };

  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.description && <div className="toast-description">{toast.description}</div>}
      </div>
      {toast.action && (
        <button type="button" className="toast-action" onClick={handleAction}>
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <line x1="2" y1="2" x2="8" y2="8" />
          <line x1="8" y1="2" x2="2" y2="8" />
        </svg>
      </button>
    </div>
  );
}
