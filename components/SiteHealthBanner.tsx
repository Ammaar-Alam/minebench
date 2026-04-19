"use client";

import { useEffect, useState } from "react";
import { useSiteHealth } from "@/lib/apiHealth";

export function SiteHealthBanner() {
  const { degraded } = useSiteHealth();
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

  // when the user is offline the OfflineBanner already covers it — suppress
  // the site-health banner to avoid stacked duplicate messaging
  if (!degraded || offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex justify-center px-3 pt-3"
    >
      <div className="mb-subpanel flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium text-warn ring-1 ring-warn/40 shadow-soft backdrop-blur-md">
        <span
          className="h-1.5 w-1.5 rounded-full bg-warn shadow-[0_0_0_3px_hsl(var(--warn)_/_0.22)]"
          aria-hidden="true"
        />
        <span>MineBench is having trouble right now — some things may load slowly.</span>
      </div>
    </div>
  );
}
