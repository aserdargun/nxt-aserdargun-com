export type RgbaColor = readonly [red: number, green: number, blue: number, alpha: number];
export type RgbColor = readonly [red: number, green: number, blue: number];

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const parseComponent = (component: string, maximum: number): number => {
  const value = Number.parseFloat(component);
  if (!Number.isFinite(value)) throw new Error(`Invalid RGB component: ${component}`);
  return component.endsWith("%")
    ? clamp((value / 100) * maximum, 0, maximum)
    : clamp(value, 0, maximum);
};

export const parseRgbColor = (value: string): RgbaColor => {
  const match = /^rgba?\((.*)\)$/iu.exec(value.trim());
  if (match === null) throw new Error(`Unsupported computed color: ${value}`);

  const body = match[1]?.trim() ?? "";
  const slashParts = body.split("/").map((part) => part.trim());
  if (slashParts.length > 2) throw new Error(`Invalid computed color: ${value}`);

  const commaSeparated = slashParts[0]?.includes(",") ?? false;
  const components = (slashParts[0] ?? "").split(commaSeparated ? /\s*,\s*/u : /\s+/u);
  let alphaComponent = slashParts[1];
  if (commaSeparated && components.length === 4 && alphaComponent === undefined) {
    alphaComponent = components.pop();
  }
  if (components.length !== 3) throw new Error(`Invalid computed color: ${value}`);

  return [
    parseComponent(components[0] ?? "", 255),
    parseComponent(components[1] ?? "", 255),
    parseComponent(components[2] ?? "", 255),
    alphaComponent === undefined ? 1 : parseComponent(alphaComponent, 1)
  ];
};

export const compositeColor = (foreground: RgbaColor, background: RgbaColor): RgbaColor => {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0, 0];

  return [
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
    alpha
  ];
};

// Contrast is evaluated against the rendered 8-bit sRGB pixel channels.
const renderedRgb = (color: RgbaColor): RgbColor => [
  Math.round(color[0]),
  Math.round(color[1]),
  Math.round(color[2])
];

export const effectiveColorPair = (
  foreground: string,
  backgroundLayers: readonly string[]
): { readonly foreground: RgbColor; readonly background: RgbColor } => {
  if (backgroundLayers.length === 0) throw new Error("A rendered background layer is required.");

  const effectiveBackground = backgroundLayers
    .map(parseRgbColor)
    .reduce((composited, layer) => compositeColor(composited, layer));
  if (effectiveBackground[3] < 1) {
    throw new Error("The rendered background remains translucent after traversing its ancestors.");
  }

  const opaqueBackground: RgbaColor = [
    effectiveBackground[0],
    effectiveBackground[1],
    effectiveBackground[2],
    1
  ];
  const effectiveForeground = compositeColor(parseRgbColor(foreground), opaqueBackground);
  return {
    foreground: renderedRgb(effectiveForeground),
    background: renderedRgb(opaqueBackground)
  };
};
