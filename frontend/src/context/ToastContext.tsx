import {
  createContext,
  useCallback,
  useContext,
  useState,
} from "react";

interface ToastItem {
  id: number;
  message: string;
}

interface ToastContextValue {
  showToast: (message: string) => void;
}

const Ctx = createContext<ToastContextValue | null>(null);

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const showToast = useCallback((message: string) => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <Ctx.Provider value={{ showToast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto rounded-lg bg-ink-800 px-4 py-3 text-sm text-gray-100 shadow-xl ring-1 ring-ink-600"
          >
            {t.message}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
