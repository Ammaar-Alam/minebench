"use client";

import { useEffect } from "react";

export function LeaderboardPageShell({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    document.body.classList.add("mb-page-fixed");
    return () => {
      document.body.classList.remove("mb-page-fixed");
    };
  }, []);

  return children;
}

