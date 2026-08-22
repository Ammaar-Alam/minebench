import { titleCase } from "@/components/lab/format";

function tone(status: string): string {
  if (status === "ACTIVE" || status === "READY") return "text-success";
  if (status === "GENERATING" || status === "PAUSED") return "text-warn";
  if (status === "FAILED" || status === "WITHDRAWN") return "text-danger";
  return "text-muted";
}

export function EvaluationStatus({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-medium ${tone(status)}`}>
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {titleCase(status)}
    </span>
  );
}
