import { track } from "@vercel/analytics/server";

type AnalyticsValue = string | number | boolean | null | undefined;

export async function trackServerEvent(
  name: string,
  properties?: Record<string, AnalyticsValue>,
) {
  try {
    await track(name, properties);
  } catch {
    // best effort only
  }
}

export function trackServerEventInBackground(
  name: string,
  properties?: Record<string, AnalyticsValue>,
) {
  void trackServerEvent(name, properties);
}
