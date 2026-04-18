type ServerTimingEntry = {
  name: string;
  duration: number;
  description?: string;
};

export class ServerTiming {
  private readonly entries: ServerTimingEntry[] = [];

  start() {
    return performance.now();
  }

  end(name: string, startedAt: number, description?: string) {
    this.add(name, performance.now() - startedAt, description);
  }

  add(name: string, duration: number, description?: string) {
    if (!Number.isFinite(duration) || duration < 0) return;
    this.entries.push({
      name,
      duration: Math.round(duration * 100) / 100,
      description,
    });
  }

  headerValue(): string | null {
    if (this.entries.length === 0) return null;
    return this.entries
      .map((entry) => {
        const encodedDescription = entry.description
          ? `;desc="${entry.description.replace(/"/g, "'")}"`
          : "";
        return `${entry.name};dur=${entry.duration}${encodedDescription}`;
      })
      .join(", ");
  }

  apply(headers: Headers) {
    const value = this.headerValue();
    if (!value) return;
    headers.set("Server-Timing", value);
  }
}
