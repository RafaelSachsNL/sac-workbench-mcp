/**
 * Signal colours: red and green carry meaning in reports (variance, thresholds, highlights). Used as series colours
 * they make every bar look "bad" or "good", the real signals lose their effect, and red/green is the most common colour
 * blindness. Series colours must be neutral; red/green stay reserved for highlights and variances.
 */

export type Signal = "red" | "green";

function hsl(hex: string): { h: number; s: number; l: number } | undefined {
  const m = hex.trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return undefined;
  const v = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

/** "red" / "green" for saturated reds and greens, otherwise undefined (greys, blues, petrol, … are fine). */
export function signalOf(color: string): Signal | undefined {
  const c = hsl(color);
  if (!c || c.s < 0.35 || c.l < 0.15 || c.l > 0.8) return undefined;
  if (c.h <= 15 || c.h >= 340) return "red";
  if (c.h >= 85 && c.h <= 160) return "green";
  return undefined;
}

export const SIGNAL_COLOR_NOTE =
  "Red and green are signal colours (variance, thresholds, highlights). As series colours every bar looks " +
  "'bad' or 'good', real variances and highlights get lost, and red-green is the most common colour vision " +
  "deficiency. Recommendation: neutral series colours (e.g. dark blue/petrol/grey), red/green only for variances " +
  "and deliberate highlights.";

/** Palette entries that are signal colours, with their position. */
export function signalColorsIn(palette: string[] | undefined): { index: number; color: string; signal: Signal }[] {
  return (palette ?? []).flatMap((color, index) => {
    const signal = signalOf(color);
    return signal ? [{ index, color, signal }] : [];
  });
}
