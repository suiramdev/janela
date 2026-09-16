export const ACCENTS = [
  "none",
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "graphite",
] as const;

export type Accent = (typeof ACCENTS)[number];
