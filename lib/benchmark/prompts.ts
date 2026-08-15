// The fixed prompt cohort used to publish model-level benchmark metrics.
// This is the single source for the benchmark cohort: batch generation, seed,
// and cohort identity all derive from it.
export const BENCHMARK_PROMPT_MAP: Record<string, string> = {
  arcade:
    "A classic arcade cabinet with a joystick and three buttons on the control panel, a screen showing simple graphics, coin slot on the front, and artwork on the sides",
  astronaut: "An astronaut",
  steampunk:
    "A steampunk airship with a wooden hull, large brass propellers on each side, a balloon made of patchwork fabric above the deck, hanging ropes and ladders, and a glass-enclosed bridge at the front",
  carrier:
    "A flying aircraft carrier with a flat deck on top, control tower, planes parked on deck, massive jet engines underneath keeping it aloft, and radar dishes",
  locomotive: "A steam locomotive",
  skyscraper: "A skyscraper",
  treehouse:
    "A treehouse village: three large treehouses in adjacent trees connected by rope bridges, each house with different architecture (one rustic, one elvish with curved lines, one modern with clean angles), rope ladders down, and lanterns hanging from branches",
  cottage: "A cozy cottage",
  worldtree:
    "A massive world tree: an enormous trunk with roots visible above ground forming archways, multiple levels of thick branches like platforms, glowing fruit hanging from smaller branches, and vines draping down",
  "fighter-jet": "A fighter jet",
  floating:
    "A floating island ecosystem: a chunk of earth suspended in air with waterfalls pouring off multiple edges, a small forest on top, exposed roots and rocks hanging underneath, and smaller floating rocks nearby connected by ancient chain bridges",
  shipwreck:
    "An underwater shipwreck: a wooden galleon on its side on the ocean floor, holes in the hull, coral and seaweed growing on it, treasure chests spilling gold, and fish swimming around",
  phoenix:
    "A phoenix rising from flames: wings fully spread upward, tail feathers flowing down like fire, head raised to the sky, made of red, orange, and gold blocks with glowstone accents",
  knight: "A knight in armor",
  castle:
    "A medieval stone castle with curtain walls forming a square, four tall corner towers with battlements, a central keep, a gatehouse with an archway and portcullis, and a surrounding moat with a small drawbridge.",
};

// Unit coverage keeps this identity aligned with the prompt map
export const BENCHMARK_PROMPT_COHORT_ID = "prompts-v1:bd8c28367f8a97f2";
