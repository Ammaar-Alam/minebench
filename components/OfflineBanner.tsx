"use client";

import { useEffect, useState } from "react";

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3"
    >
      <div className="mb-subpanel flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium text-warn ring-1 ring-warn/40 shadow-soft">
        <span className="h-1.5 w-1.5 rounded-full bg-warn shadow-[0_0_0_3px_hsl(var(--warn)_/_0.22)]" aria-hidden="true" />
        <span>You&apos;re offline. Changes may not save.</span>
      </div>
    </div>
  );
}
