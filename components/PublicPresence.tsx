"use client";

import { useEffect } from "react";

const HEARTBEAT_MS = 4 * 60 * 1000;

export function PublicPresence() {
  useEffect(() => {
    let lastSentAt = 0;
    function send() {
      if (document.visibilityState !== "visible" || Date.now() - lastSentAt < HEARTBEAT_MS / 2) return;
      lastSentAt = Date.now();
      void fetch("/api/presence", { method: "POST", keepalive: true }).catch(() => {});
    }

    const initial = window.setTimeout(send, 2_000);
    const interval = window.setInterval(send, HEARTBEAT_MS);
    const onVisibilityChange = () => send();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  return null;
}
