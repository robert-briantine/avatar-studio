export const WAN_TRANSITION_STYLES = ["interpolated", "reconstructed"] as const;
export type WanTransitionStyle = typeof WAN_TRANSITION_STYLES[number];

export function parseWanTransitionStyle(value: unknown = "interpolated"): WanTransitionStyle {
  if (value === "interpolated" || value === "reconstructed") return value;
  throw new RangeError("Choisis la transition 3 « Mouvement interpolé » ou 4 « Reprise reconstruite ».");
}

export type WanTransitionBoundary = { frame: number; pauseStartFrame: number };
