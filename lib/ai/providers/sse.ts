export type SseEvent = {
  event?: string;
  data: string;
};

export async function consumeSseStream(
  res: Response,
  onEvent: (evt: SseEvent) => void
): Promise<void> {
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const emitFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    let event: string | undefined;
    const dataLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line) continue;
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    const data = dataLines.join("\n");
    if (!data) return;
    onEvent({ event, data });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      emitFrame(frame);
    }
  }

  // Flush any final decoder state and emit a trailing frame even if the
  // stream ended without a blank-line separator.
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const tailFrames = buffer.split(/\r?\n\r?\n/);
    for (const frame of tailFrames) {
      if (!frame.trim()) continue;
      emitFrame(frame);
    }
  }
}
