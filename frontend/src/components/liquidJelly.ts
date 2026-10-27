export interface PillRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const JELLY_MS = 520;

/**
 * Keyframes for the liquid nav pill moving `from` → `to`: the edge nearest
 * the destination shoots ahead and the pill thins as it stretches, then the
 * trailing edge flows in after it and settles, like liquid poured across.
 */
export function jellyKeyframes(from: PillRect, to: PillRect): Keyframe[] {
  const horizontal =
    Math.abs(to.left - from.left) >= Math.abs(to.top - from.top);
  const pos = horizontal ? "left" : "top";
  const size = horizontal ? "width" : "height";
  const crossPos = horizontal ? "top" : "left";
  const crossSize = horizontal ? "height" : "width";
  const squash = horizontal ? "scaleY" : "scaleX";

  const a0 = from[pos];
  const a1 = a0 + from[size];
  const b0 = to[pos];
  const b1 = b0 + to[size];
  const forward = b0 >= a0;
  const dist = Math.abs(b0 - a0);
  const over = Math.min(6, dist * 0.04);

  // [start edge, end edge] along the travel axis at each stage.
  const edges: [number, number][] = forward
    ? [
        [a0, a1],
        [a0 + dist * 0.15, b1 + over],
        [b0 + over * 0.4, b1],
        [b0, b1],
      ]
    : [
        [a0, a1],
        [b0 - over, a1 - dist * 0.15],
        [b0, b1 - over * 0.4],
        [b0, b1],
      ];
  const squashes = [1, 0.86, 1.02, 1];
  const radii = ["0.5rem", "1rem", "0.55rem", "0.5rem"];
  const offsets = [0, 0.42, 0.75, 1];
  // One smooth pour: the lead flows ahead, the tail follows and settles.
  const easings = [
    "cubic-bezier(0.4, 0, 0.6, 1)",
    "cubic-bezier(0.5, 0, 0.3, 1)",
    "cubic-bezier(0.25, 0, 0.35, 1)",
    "linear",
  ];

  return edges.map(([start, end], i) => {
    const cross = i === 0 ? from : to;
    return {
      offset: offsets[i],
      easing: easings[i],
      [pos]: `${start}px`,
      [size]: `${Math.max(4, end - start)}px`,
      [crossPos]: `${cross[crossPos]}px`,
      [crossSize]: `${cross[crossSize]}px`,
      transform: `${squash}(${squashes[i]})`,
      borderRadius: radii[i],
    };
  });
}
