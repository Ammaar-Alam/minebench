import type { StealthBreakdown } from "@/lib/stealth/report";
import { formatPercent } from "@/components/lab/format";

export function BreakdownTable({
  title,
  label,
  rows,
}: {
  title: string;
  label: string;
  rows: StealthBreakdown[];
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-lg font-medium tracking-tight text-fg">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] border-y border-border/70 text-left text-sm">
          <thead className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
            <tr className="border-b border-border/45">
              <th className="py-2.5 pr-4 font-medium">{label}</th>
              <th className="px-3 py-2.5 text-right font-medium">Votes</th>
              <th className="px-3 py-2.5 text-right font-medium">Record</th>
              <th className="py-2.5 pl-4 text-right font-medium">Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border/35 last:border-0">
                <td className="max-w-[30rem] py-3 pr-4 text-fg">
                  <span className="line-clamp-2">{row.label}</span>
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                  {row.votes.toLocaleString()}
                </td>
                <td className="px-3 py-3 text-right font-mono text-xs tabular-nums text-muted">
                  {row.wins}–{row.losses}–{row.draws}
                </td>
                <td className="py-3 pl-4 text-right font-mono text-xs tabular-nums text-fg">
                  {formatPercent(row.averageScore)}
                </td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-8 text-center text-sm text-muted">
                  No votes yet
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
