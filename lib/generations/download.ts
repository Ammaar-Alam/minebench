const LARGE_JSON_BYTES = 64 * 1024 * 1024;

type WritableFile = WritableStream<Uint8Array> & {
  abort?: (reason?: unknown) => Promise<void>;
};

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable: () => Promise<WritableFile> }>;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function expandSavedGenerationResponse(
  response: Response,
): Promise<ReadableStream<Uint8Array>> {
  if (!response.body) throw new Error("JSON download was empty");

  const reader = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let prefixBytes = 0;
  let complete = false;
  while (prefixBytes < 2 && !complete) {
    const next = await reader.read();
    complete = next.done;
    if (next.value?.length) {
      prefix.push(next.value);
      prefixBytes += next.value.length;
    }
  }

  let first = -1;
  let second = -1;
  for (const chunk of prefix) {
    for (const byte of chunk) {
      if (first < 0) first = byte;
      else if (second < 0) second = byte;
      if (second >= 0) break;
    }
    if (second >= 0) break;
  }

  let prefixIndex = 0;
  const replay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (prefixIndex < prefix.length) {
        controller.enqueue(prefix[prefixIndex++]);
        return;
      }
      if (complete) {
        controller.close();
        return;
      }
      const next = await reader.read();
      complete = next.done;
      if (next.value?.length) controller.enqueue(next.value);
      if (complete) controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  if (first !== 0x1f || second !== 0x8b) return replay;
  return replay.pipeThrough(
    new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>,
  );
}

function triggerJsonDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_500);
}

export async function downloadSavedGenerationJson(args: {
  url: string;
  fileName: string;
  expandedBytes?: number | null;
}): Promise<"saved" | "cancelled"> {
  let writable: WritableFile | null = null;
  const picker = (window as FilePickerWindow).showSaveFilePicker;

  if ((args.expandedBytes ?? 0) >= LARGE_JSON_BYTES && picker) {
    try {
      const handle = await picker({
        suggestedName: args.fileName,
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      writable = await handle.createWritable();
    } catch (error) {
      if (isAbortError(error)) return "cancelled";
      throw error;
    }
  }

  try {
    const response = await fetch(args.url, { cache: "no-store" });
    if (!response.ok) throw new Error("JSON download failed");
    const stream = await expandSavedGenerationResponse(response);
    if (writable) {
      await stream.pipeTo(writable);
    } else {
      const blob = await new Response(stream, {
        headers: { "Content-Type": "application/json" },
      }).blob();
      triggerJsonDownload(blob, args.fileName);
    }
    return "saved";
  } catch (error) {
    await writable?.abort?.(error).catch(() => undefined);
    throw error;
  }
}
