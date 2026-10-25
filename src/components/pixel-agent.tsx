import { cn } from "@/lib/utils";

/*
 * Pixel art employees. Each is a 16x16 grid drawn as SVG rects, so it stays crisp at any size.
 * Letters map to colours in the palette; "." is empty.
 */

const SHARED: Record<string, string> = {
  k: "#2a2420",
  s: "#f6d2ae",
  c: "#f2a08f",
  w: "#fbfbf8",
  M: "#c65a50",
};

const FACE = ["...kssssssssk...", "...kskssssksk...", "...kskssssksk...", "...kcssssssck...", "...ksssMMsssk...", "....kkkkkkkk...."];

type Sprite = { rows: string[]; palette: Record<string, string>; face: string; tint: string };

function body(r11: string, fill = "a", prop?: string, propRim = "k") {
  const a = fill;
  const r12 = prop ? "..k" + a.repeat(8) + propRim.repeat(3) + ".." : "..k" + a.repeat(10) + "k..";
  const r13 = prop ? "..ks" + a.repeat(7) + propRim + prop + propRim + ".." : "..ks" + a.repeat(8) + "sk..";
  const r14 = prop ? "...k" + a.repeat(6) + "s" + propRim.repeat(3) + ".." : "...k" + a.repeat(8) + "k...";
  return [r11, r12, r13, r14, "...kkkkkkkkkk..."];
}

export const SPRITES: Record<string, Sprite> = {
  // Detective: deerstalker hat and a magnifying glass.
  "agent.compute": {
    rows: [
      "................",
      ".....kkkkkk.....",
      "....khhHhhhk....",
      "...khhhHhhhhk...",
      ".khhhhhhhhhhhhk.",
      ...FACE,
      ...body("...kAaaaaaaAk...", "a", "g"),
    ],
    palette: { h: "#9a6a44", H: "#6e4528", a: "#d0a463", A: "#a87d42", g: "#bfe6f5" },
    face: "#f6d2ae",
    tint: "#f3eadb",
  },
  // Accountant: green eyeshade, glasses, bow tie, calculator.
  "agent.finance": {
    rows: [
      "................",
      "................",
      "....kkkkkkkk....",
      "...krrrrrrrrk...",
      ".kvvvvvvvvvvvvk.",
      ...FACE,
      ...body("...kaaaRRaaak...", "a", "y"),
    ],
    palette: { r: "#6b4430", v: "#4fae6a", a: "#eef0f3", R: "#e2574c", y: "#9fd8a4" },
    face: "#f6d2ae",
    tint: "#e4f2e6",
  },
  // Vendor liaison: headset with mic, suit and tie.
  "agent.vendor": {
    rows: [
      "................",
      ".....mmmmmm.....",
      "...mmkkkkkkmm...",
      "..mkrrrrrrrrkm..",
      "..mkrrrrrrrrkm..",
      "..mk" + "ssssssss" + "km..",
      "...kskssssksk" + "m..",
      "...kskssssksk" + "m..",
      "...kcssssssck" + "m..",
      "...ksssMMsmmmm..",
      "....kkkkkkkk....",
      "...kaawRRwaak...",
      "..kaaaaRRaaaak..",
      "..ksaaaRRaaask..",
      "...kaaaaaaaak...",
      "...kkkkkkkkkk...",
    ],
    palette: { r: "#2f2a28", m: "#55555e", a: "#3f4f86", R: "#c6d600" },
    face: "#f6d2ae",
    tint: "#e3e7f4",
  },
  // Budget analyst: a pig (piggy bank) holding a coin.
  "agent.budget": {
    rows: [
      "................",
      "................",
      "...kk......kk...",
      "...kPkkkkkkPk...",
      "...kppppppppk...",
      "...kppppppppk...",
      "...kpkppppkpk...",
      "...kpkppppkpk...",
      "...kpPkPPkPpk...",
      "...kpPPPPPPpk...",
      "....kkkkkkkk....",
      ...body("...kaaaaaaaak...", "a", "o"),
    ],
    palette: { p: "#f7b3c2", P: "#e47d97", a: "#5fae6e", o: "#f3c443" },
    face: "#f7b3c2",
    tint: "#fbe6ec",
  },
  // Controls lead: graduation cap and a scroll of rules.
  "agent.policy": {
    rows: [
      "................",
      "....kkkkkkkk....",
      ".kkmmmmmmmmmmkk.",
      "...kmmmmmmmmk.o.",
      "...krrrrrrrrk.o.",
      "...kssssssssk.o.",
      ...FACE.slice(1),
      ...body("...kawwaawwak...", "a", "w"),
    ],
    palette: { m: "#2f2b4d", o: "#f3c443", r: "#3a2a22", a: "#8a6bc0" },
    face: "#f6d2ae",
    tint: "#ece6f6",
  },
  // Capacity planner: hard hat, hi-vis vest, clipboard.
  "agent.capacity": {
    rows: [
      "................",
      "......kkkk......",
      "....kkyyyykk....",
      "...kyyyYyyyyk...",
      ".kyyyyyyyyyyyyk.",
      ...FACE,
      "...kaaaaaaaak...",
      "..kaaaaaaaabbb..",
      "..kswwwwwwwbwb..",
      "...kaaaaaasbbb..",
      "...kkkkkkkkkk...",
    ],
    palette: { y: "#f5c518", Y: "#fff1a6", a: "#f08a24", b: "#8a5a34" },
    face: "#f6d2ae",
    tint: "#fdf0dc",
  },
  // You, the controller: a small crown and a coffee mug. Not an actor id, so avatars elsewhere are unchanged.
  you: {
    rows: [
      "................",
      "....o..oo..o....",
      "....oooooooo....",
      "...krrrrrrrrk...",
      "...krrrrrrrrk...",
      ...FACE,
      ...body("...kaaawwaaak...", "a", "w"),
    ],
    palette: { o: "#f3c443", r: "#4a3428", a: "#3d4250" },
    face: "#f6d2ae",
    tint: "#eef3c8",
  },
};

/** Merge horizontal runs of one colour into single rects. */
function rects(rows: string[], palette: Record<string, string>) {
  const out: { x: number; y: number; w: number; fill: string }[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let w = 1;
      while (row[x + w] === ch) w++;
      const fill = palette[ch] ?? SHARED[ch];
      if (ch !== "." && fill) out.push({ x, y, w, fill });
      x += w;
    }
  });
  return out;
}

const BLINK_DELAY: Record<string, string> = {
  "agent.compute": "0s",
  "agent.finance": "1.3s",
  "agent.vendor": "2.6s",
  "agent.budget": "0.7s",
  "agent.policy": "3.1s",
  "agent.capacity": "1.9s",
};

export function hasSprite(actorId: string) {
  return actorId in SPRITES;
}

export function spriteTint(actorId: string) {
  return SPRITES[actorId]?.tint;
}

/** A one-off or held animation: reactions, sleeping while paused, slumping after a rejection. */
export type SpriteMood = "hop" | "party" | "nod" | "shake" | "tilt" | "slump" | "sleep";

/** A pixel employee. Idles with a slow bob and blink; bounces faster while working. */
export function PixelAgent({
  actorId,
  size = 48,
  working = false,
  still = false,
  mood,
  className,
}: {
  actorId: string;
  size?: number;
  working?: boolean;
  still?: boolean;
  mood?: SpriteMood;
  className?: string;
}) {
  const sprite = SPRITES[actorId];
  if (!sprite) return null;
  const blinkDelay = BLINK_DELAY[actorId] ?? "0s";
  const asleep = mood === "sleep";
  return (
    <svg
      viewBox="0 -1 16 17"
      width={size}
      height={(size * 17) / 16}
      shapeRendering="crispEdges"
      aria-hidden
      className={cn("shrink-0 overflow-visible", className)}
    >
      <g className={mood && !asleep ? "px-mood-" + mood : undefined}>
      <g className={still || asleep ? undefined : working ? "px-bob-fast" : "px-bob"} style={{ animationDelay: blinkDelay }}>
        {rects(sprite.rows, sprite.palette).map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
        ))}
        {still && !asleep ? null : (
          <g className={asleep ? undefined : "px-blink"} style={{ animationDelay: blinkDelay }}>
            <rect x={5} y={6} width={1} height={1} fill={sprite.face} />
            <rect x={10} y={6} width={1} height={1} fill={sprite.face} />
          </g>
        )}
      </g>
      </g>
    </svg>
  );
}
