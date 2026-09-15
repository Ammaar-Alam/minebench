import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Regression guard for GalleryDetail removeExample: removing the currently-selected
// build must promote a remaining build into selectedIds instead of emptying it, so the
// sidebar selection, the main viewer, the viewer-fetch effect, and the footer "Remove
// build" target all stay consistent. See components/gallery/GalleryDetail.tsx.

const detail = readFileSync("components/gallery/GalleryDetail.tsx", "utf8");

assert.ok(
  detail.includes("const fallbackId = examples.find((example) => example.id !== exampleId)?.id"),
  "removeExample should promote a remaining example when the selection would otherwise be emptied",
);
assert.ok(
  detail.includes("if (next.length > 0) return next"),
  "removeExample should preserve the remaining selection when other builds stay selected",
);
assert.ok(
  detail.includes("return fallbackId ? [fallbackId] : [];"),
  "removeExample should fall back to an empty selection only when no example remains",
);
assert.equal(
  detail.includes("setSelectedIds((current) => current.filter((id) => id !== exampleId))"),
  false,
  "removeExample should not simply filter selectedIds without promoting a fallback",
);
assert.ok(
  detail.includes("selected?.canRemove") && detail.includes("void removeExample(selected.id)"),
  "the footer Remove build button should remain bound to the derived selected example",
);

type Example = { id: string; viewerUrl: string | null; canRemove: boolean };

// Mirrors the selection / removeExample / viewer-fetch / card-loading logic of GalleryDetail
// closely enough to exercise the promotion behavior the source guards describe.
class GalleryDetailSim {
  examples: Example[];
  selectedIds: string[];
  viewerStates: Record<string, { loading: boolean }> = {};

  constructor(initial: Example[]) {
    this.examples = initial;
    this.selectedIds = initial[0] ? [initial[0].id] : [];
  }

  get selected(): Example | null {
    const selectedExamples = this.selectedIds
      .map((id) => this.examples.find((e) => e.id === id))
      .filter((e): e is Example => Boolean(e));
    return selectedExamples[0] ?? this.examples[0] ?? null;
  }

  removeExample(exampleId: string) {
    const fallbackId = this.examples.find((e) => e.id !== exampleId)?.id;
    this.examples = this.examples.filter((e) => e.id !== exampleId);
    const next = this.selectedIds.filter((id) => id !== exampleId);
    this.selectedIds = next.length > 0 ? next : fallbackId ? [fallbackId] : [];
  }

  runViewerEffect() {
    const selectedSet = new Set(this.selectedIds);
    this.viewerStates = Object.fromEntries(
      Object.entries(this.viewerStates).filter(([id]) => selectedSet.has(id)),
    );
    for (const exampleId of this.selectedIds) {
      const example = this.examples.find((e) => e.id === exampleId);
      if (!example || this.viewerStates[exampleId]) continue;
      this.viewerStates[exampleId] = { loading: Boolean(example.viewerUrl) };
    }
  }

  cardLoadingFor(example: Example): boolean {
    return this.viewerStates[example.id]?.loading ?? Boolean(example.viewerUrl);
  }
}

const own = (id: string, viewerUrl: string | null): Example => ({ id, viewerUrl, canRemove: true });
const other = (id: string, viewerUrl: string | null): Example => ({ id, viewerUrl, canRemove: false });

// Removing the sole selected build promotes a remaining build and fetches its viewer.
{
  const sim = new GalleryDetailSim([own("A", "/api/gallery/examples/A/viewer"), other("B", "/api/gallery/examples/B/viewer")]);
  sim.runViewerEffect();
  sim.removeExample(sim.selected!.id);
  sim.runViewerEffect();
  assert.deepEqual(sim.selectedIds, ["B"]);
  assert.equal(sim.selected!.id, "B");
  assert.equal(sim.selectedIds.indexOf(sim.selected!.id) >= 0, true, "the promoted build must be in selectedIds");
  assert.notEqual(sim.viewerStates["B"], undefined, "the viewer effect must create state for the promoted build");
  assert.equal(sim.cardLoadingFor(sim.selected!), true, "loading must be backed by viewer state, not the fallback heuristic");
}

// Removing one of several selected builds preserves the remaining selection.
{
  const sim = new GalleryDetailSim([own("A", "/api/gallery/examples/A/viewer"), other("B", "/api/gallery/examples/B/viewer")]);
  sim.selectedIds = ["A", "B"];
  sim.runViewerEffect();
  sim.removeExample("A");
  sim.runViewerEffect();
  assert.deepEqual(sim.selectedIds, ["B"]);
  assert.equal(sim.viewerStates["A"], undefined);
}

// Removing the final build empties the selection and renders the empty state.
{
  const sim = new GalleryDetailSim([own("A", "/api/gallery/examples/A/viewer")]);
  sim.runViewerEffect();
  sim.removeExample("A");
  sim.runViewerEffect();
  assert.deepEqual(sim.selectedIds, []);
  assert.equal(sim.examples.length, 0);
  assert.equal(sim.selected, null);
}

// Contrast: the unfixed handler (filter selectedIds with no promotion) reproduces the defect,
// proving the scenarios above are sensitive to the fix.
class BuggyGalleryDetailSim extends GalleryDetailSim {
  override removeExample(exampleId: string) {
    this.examples = this.examples.filter((e) => e.id !== exampleId);
    this.selectedIds = this.selectedIds.filter((id) => id !== exampleId);
  }
}
{
  const sim = new BuggyGalleryDetailSim([own("A", "/api/gallery/examples/A/viewer"), other("B", "/api/gallery/examples/B/viewer")]);
  sim.runViewerEffect();
  sim.removeExample(sim.selected!.id);
  sim.runViewerEffect();
  assert.equal(sim.selectedIds.length, 0, "the unfixed handler empties the selection");
  assert.equal(sim.selected!.id, "B", "the unfixed handler silently re-promotes an unselected build");
  assert.equal(sim.viewerStates["B"], undefined, "the unfixed handler never fetches the promoted build");
  assert.equal(sim.cardLoadingFor(sim.selected!), true, "the unfixed handler leaves the viewer perpetually loading");
}

console.log("GalleryDetail removeExample selection checks passed");
