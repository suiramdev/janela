/**
 * Dither Kit ships its own `clsx` + `tailwind-merge` copy so the pack is
 * portable as a registry. Here it is not portable, it is vendored — and two
 * class mergers in one package is one too many, because they resolve conflicting
 * Tailwind utilities by different rules and nothing would tell us which one a
 * component used. This file exists only to keep the pack's own imports intact.
 */
export { cn } from "cn";
