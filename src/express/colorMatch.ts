/**
 * Perceptual garment-color matching.
 *
 * Variant colors used to be matched by token overlap, so "bright green"
 * scored 1 hit on BOTH "Forest Green" and "Irish Green" and catalog order
 * decided (live queue verdict: bright green shirt came back forest/berry).
 * Here both the request and every variant color name resolve to RGB and the
 * NEAREST color wins — with brightness adjectives (bright/light/dark/...)
 * shifting the target the way people mean them.
 */

/** Common Printful/garment color vocabulary -> hex. Multi-word names first-class. */
const GARMENT_COLORS: Record<string, string> = {
  black: "#111111",
  white: "#f5f5f5",
  natural: "#ece5d5",
  cream: "#f2e8c9",
  ivory: "#f4f1e0",
  bone: "#e3dac9",
  sand: "#d6c6a5",
  tan: "#d2b48c",
  khaki: "#c3b091",
  beige: "#d9c7a7",
  brown: "#6b4423",
  chocolate: "#4e2e1e",
  espresso: "#3c2a21",
  charcoal: "#36454f",
  asphalt: "#3f4447",
  graphite: "#53565a",
  grey: "#8e8e8e",
  gray: "#8e8e8e",
  "sport grey": "#9b9b9b",
  "athletic heather": "#a5a9ad",
  "heather grey": "#a2a2a2",
  "dark grey heather": "#5b5e62",
  ash: "#c8c9c7",
  silver: "#c0c0c0",
  red: "#d32f2f",
  cardinal: "#8a1538",
  "cardinal red": "#8a1538",
  cranberry: "#8c2f45",
  maroon: "#6d1a36",
  burgundy: "#722f37",
  brick: "#9c3b2e",
  rust: "#b7410e",
  coral: "#f88379",
  salmon: "#fa8072",
  peach: "#ffcba4",
  orange: "#f4791f",
  "burnt orange": "#cc5500",
  "texas orange": "#bf5700",
  gold: "#eead1a",
  yellow: "#ffd400",
  daisy: "#fed141",
  mustard: "#d4a017",
  butter: "#f7e58b",
  lime: "#a4d65e",
  "safety green": "#c9ff00",
  "kiwi": "#9bc400",
  green: "#2f9e44",
  leaf: "#61a63c",
  emerald: "#00996b",
  "grass green": "#3aaa35",
  "ocean blue": "#3d6e91",
  "columbia blue": "#9ac1e0",
  "dusty blue": "#7d9bb5",
  "ice blue": "#c9e4ee",
  raspberry: "#b3446c",
  clay: "#b66a50",
  autumn: "#b5551d",
  toast: "#a56a3a",
  pebble: "#d8d0c5",
  oxblood: "#4a1e1b",
  dust: "#cfc4b0",
  "team purple": "#4e2a84",
  "forest green": "#1b4d2b",
  "forest": "#1b4d2b",
  "irish green": "#00a651",
  "kelly green": "#00a94f",
  kelly: "#00a94f",
  "military green": "#5a5f43",
  "army": "#4b5320",
  olive: "#6b6b3a",
  sage: "#9caf88",
  mint: "#98e2c6",
  seafoam: "#93e9be",
  teal: "#008080",
  aqua: "#00c5cd",
  turquoise: "#40e0d0",
  cyan: "#00bcd4",
  "carolina blue": "#7bafd4",
  "light blue": "#a4c8e1",
  "sky blue": "#87ceeb",
  "baby blue": "#a3c7e8",
  "steel blue": "#4682b4",
  slate: "#708090",
  denim: "#4a6b8a",
  "indigo blue": "#3f4d8c",
  indigo: "#3f4d8c",
  navy: "#1f2a44",
  "midnight navy": "#1a2238",
  royal: "#2456c4",
  "royal blue": "#2456c4",
  "true royal": "#2456c4",
  blue: "#2456c4",
  purple: "#6a3fa0",
  violet: "#7a4dbf",
  lavender: "#b9a3d9",
  lilac: "#c8a2c8",
  orchid: "#da70d6",
  plum: "#6e3a5a",
  berry: "#8e4585",
  magenta: "#d0348f",
  fuchsia: "#e11584",
  "hot pink": "#ff4fa3",
  pink: "#f4a6c0",
  "light pink": "#f7c8d8",
  blush: "#e8b4b8",
  "dusty rose": "#c4a0a6",
  mauve: "#b39aa5",
  heliconia: "#df4995"
};

const clamp255 = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

const hexToRgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ];
};

const mix = (rgb: [number, number, number], toward: number, amount: number): [number, number, number] =>
  [
    clamp255(rgb[0] + (toward - rgb[0]) * amount),
    clamp255(rgb[1] + (toward - rgb[1]) * amount),
    clamp255(rgb[2] + (toward - rgb[2]) * amount)
  ];

const rgbToHsl = (rgb: [number, number, number]): [number, number, number] => {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h, s, l];
};

const hslToRgb = (hsl: [number, number, number]): [number, number, number] => {
  const [h, s, l] = hsl;
  if (s === 0) return [clamp255(l * 255), clamp255(l * 255), clamp255(l * 255)];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [clamp255(channel(h + 1 / 3) * 255), clamp255(channel(h) * 255), clamp255(channel(h - 1 / 3) * 255)];
};

/**
 * "Bright/neon X" = the pure vivid hue of X (full saturation, mid
 * lightness), keeping the HUE — never a lightened pastel (live defect: an
 * additive brighten pushed "bright green" into mint/turquoise territory).
 */
const vivid = (rgb: [number, number, number]): [number, number, number] => {
  const [h] = rgbToHsl(rgb);
  return hslToRgb([h, 1, 0.5]);
};

/** Resolve a garment color NAME (variant side) to RGB; null when unknown. */
export const garmentColorRgb = (name: string): [number, number, number] | null => {
  const low = ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  // Longest known phrase contained in the name wins ("Dark Grey Heather"
  // before "grey"; "Irish Green" before "green").
  let bestKey: string | null = null;
  for (const key of Object.keys(GARMENT_COLORS)) {
    if (low.includes(` ${key} `) && (!bestKey || key.length > bestKey.length)) bestKey = key;
  }
  if (!bestKey) return null;
  let rgb = hexToRgb(GARMENT_COLORS[bestKey]);
  // The name's own adjectives shade the base hue when the exact phrase is
  // not in the table ("Light Aqua" = aqua mixed toward white).
  if (!low.includes(` light ${bestKey} `) && / light /.test(low) && !bestKey.startsWith("light")) {
    rgb = mix(rgb, 255, 0.4);
  }
  if (/ dark | deep /.test(low) && !bestKey.startsWith("dark")) rgb = mix(rgb, 0, 0.35);
  if (/ heather /.test(low)) rgb = mix(rgb, 160, 0.15);
  return rgb;
};

/** Resolve the CUSTOMER'S stated color phrase to a target RGB; null if none. */
export const statedColorRgb = (phrase: string): [number, number, number] | null => {
  const low = ` ${phrase.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim()} `;
  const hex = low.match(/#([0-9a-f]{3}|[0-9a-f]{6})\b/);
  if (hex) return hexToRgb(hex[0]);
  let rgb = garmentColorRgb(phrase);
  if (!rgb) return null;
  if (/ bright | neon | vivid | electric | vibrant | hot /.test(low)) rgb = vivid(rgb);
  if (/ light | pale | pastel | soft | baby /.test(low)) rgb = mix(rgb, 255, 0.45);
  if (/ dark | deep | midnight /.test(low)) rgb = mix(rgb, 0, 0.4);
  return rgb;
};

/** Redmean-weighted RGB distance — cheap and close enough to perceptual. */
const colorDistance = (a: [number, number, number], b: [number, number, number]): number => {
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
};

/**
 * Pick the variant color name nearest the customer's stated color. Returns
 * null when either side fails to parse (caller falls back to token matching).
 */
export const nearestVariantColor = (
  statedPhrase: string,
  variantColors: string[]
): string | null => {
  const target = statedColorRgb(statedPhrase);
  if (!target) return null;
  let best: { color: string; d: number } | null = null;
  for (const color of variantColors) {
    const rgb = garmentColorRgb(color);
    if (!rgb) continue;
    const d = colorDistance(target, rgb);
    if (!best || d < best.d) best = { color, d };
  }
  return best?.color ?? null;
};
