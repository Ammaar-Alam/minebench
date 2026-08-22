function statusMessage(status: number): string | null {
  if (status === 429) {
    return "Slow down — you're going a bit fast. Try again in a few seconds.";
  }
  if (status === 503 || status === 504) {
    return "The server is overloaded right now. Please try again shortly.";
  }
  if (status >= 500) {
    return "The server had a problem. Please try again.";
  }
  if (status === 404) return "Not found.";
  if (status === 401 || status === 403) return "You don't have access to this.";
  return null;
}

export async function readClientErrorResponse(
  response: Response,
  fallback: string,
): Promise<string> {
  // Never expose server failure details to the browser
  const safeStatusMessage = statusMessage(response.status);
  if (safeStatusMessage) return safeStatusMessage;

  let detail: string | null = null;
  try {
    const body = await response.clone().json();
    if (body && typeof body === "object") {
      const candidate =
        (body as Record<string, unknown>).error ??
        (body as Record<string, unknown>).message;
      if (typeof candidate === "string" && candidate.trim()) {
        detail = candidate.trim();
      }
    }
  } catch {
    // fall through to text
  }

  if (!detail) {
    try {
      const text = (await response.text()).trim();
      if (text && !text.startsWith("<") && text.length <= 500) {
        detail = text;
      }
    } catch {
      // ignore unreadable response bodies
    }
  }

  return detail ?? fallback;
}
