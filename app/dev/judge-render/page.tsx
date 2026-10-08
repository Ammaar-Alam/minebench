import { notFound } from "next/navigation";
import { JudgeRenderHarness } from "./JudgeRenderHarness";

// offline render target for scripts/render-judge-views.ts
export default function JudgeRenderPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <JudgeRenderHarness />;
}
