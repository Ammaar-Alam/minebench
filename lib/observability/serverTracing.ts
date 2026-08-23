import {
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
} from "@opentelemetry/api";

const tracer = trace.getTracer("minebench.arena");

export function setActiveServerSpanAttributes(attributes: Attributes) {
  trace.getActiveSpan()?.setAttributes(attributes);
}

function recordSpanError(span: Span, error: unknown) {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({ code: SpanStatusCode.ERROR });
}

export function withServerSpan<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await operation(span);
    } catch (error) {
      recordSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function withServerSpanSync<T>(
  name: string,
  attributes: Attributes,
  operation: (span: Span) => T,
): T {
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    try {
      return operation(span);
    } catch (error) {
      recordSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
