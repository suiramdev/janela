import type { ReactElement } from "react";

/**
 * The hand: Janela's mark, as the app icon draws it.
 *
 * The artwork is a 101×88 grid of 1-bit cells — the dither *is* the image, so
 * these are the icon's own runs (`apps/desktop/src-tauri/icons/janela.svg`),
 * one horizontal run per `M…z`, not a smoothed tracing. At the icon's native
 * sizes (128/256/512px on the 128-cell canvas) every cell lands on a device
 * pixel; in a 14–16px header it cannot, so the runs average into tone — which is
 * what a dither is for, and why rendering stays `auto` rather than `crispEdges`.
 *
 * ## Two appearances, three tones
 *
 * The source is ink on paper: black is shadow, the paper is the lit surface.
 * Painting the ink in `currentColor` is right on a light surface and wrong on a
 * dark one — the cuff and the undersides of the fingers turn into the brightest
 * thing in the drawing. Dark mode instead paints the cells *inside* the outline
 * that the ink left white (`LIT_PATH`, the paper the hand covers), full strength,
 * over the whole silhouette at a third — so shadow sits between the background
 * and the lit palm, the same ordering as the print, and the solid-ink parts keep
 * their shape instead of dissolving into the background. Light mode is the source
 * unchanged.
 *
 * `currentColor` throughout, so it takes the text colour beside it. `aria-hidden`:
 * it always sits next to the word "Janela".
 */
export function JanelaMark(props: {
  /** Height in px; the width follows the artwork's 101:88 aspect. */
  readonly size: number;
  readonly className?: string | undefined;
}): ReactElement {
  const { size, className } = props;
  return (
    <svg
      viewBox={`0 0 ${HAND_WIDTH} ${HAND_HEIGHT}`}
      height={size}
      width={(size * HAND_WIDTH) / HAND_HEIGHT}
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path className="dark:hidden" d={INK_PATH} />
      <g className="hidden dark:block">
        <path fillOpacity={SHADOW_OPACITY} d={SILHOUETTE_PATH} />
        <path d={LIT_PATH} />
      </g>
    </svg>
  );
}

const HAND_WIDTH = 101;
const HAND_HEIGHT = 88;

/** Shadow over a dark background: visible against it, clearly under the lit palm. */
const SHADOW_OPACITY = 0.35;

/** The black cells of the print. */
const INK_PATH =
  "M38 0h25v1h-25zM36 1h27v1h-27zM36 2h28v1h-28zM36 3h28v1h-28zM35 4h29v1h-29zM35 5h30v1h-30z" +
  "M35 6h30v1h-30zM35 7h30v1h-30zM35 8h30v1h-30zM35 9h30v1h-30zM35 10h30v1h-30zM35 11h30v1h-30z" +
  "M36 12h29v1h-29zM35 13h24v1h-24zM60 13h1v1h-1zM62 13h3v1h-3zM35 14h21v1h-21zM57 14h1v1h-1z" +
  "M59 14h1v1h-1zM61 14h1v1h-1zM63 14h4v1h-4zM34 15h25v1h-25zM60 15h1v1h-1zM62 15h1v1h-1z" +
  "M64 15h3v1h-3zM34 16h19v1h-19zM54 16h1v1h-1zM56 16h1v1h-1zM58 16h2v1h-2zM61 16h1v1h-1z" +
  "M63 16h1v1h-1zM65 16h2v1h-2zM33 17h17v1h-17zM51 17h1v1h-1zM53 17h1v1h-1zM55 17h1v1h-1z" +
  "M57 17h1v1h-1zM62 17h1v1h-1zM64 17h1v1h-1zM66 17h2v1h-2zM33 18h16v1h-16zM50 18h1v1h-1z" +
  "M52 18h1v1h-1zM54 18h1v1h-1zM58 18h1v1h-1zM60 18h1v1h-1zM65 18h3v1h-3zM33 19h15v1h-15z" +
  "M49 19h1v1h-1zM51 19h1v1h-1zM53 19h1v1h-1zM56 19h1v1h-1zM63 19h1v1h-1zM66 19h2v1h-2z" +
  "M32 20h15v1h-15zM48 20h1v1h-1zM50 20h1v1h-1zM52 20h1v1h-1zM54 20h1v1h-1zM59 20h1v1h-1z" +
  "M61 20h1v1h-1zM65 20h1v1h-1zM67 20h2v1h-2zM32 21h12v1h-12zM45 21h1v1h-1zM47 21h1v1h-1z" +
  "M49 21h1v1h-1zM51 21h1v1h-1zM57 21h1v1h-1zM66 21h1v1h-1zM68 21h1v1h-1zM31 22h9v1h-9z" +
  "M41 22h2v1h-2zM44 22h1v1h-1zM46 22h1v1h-1zM48 22h1v1h-1zM50 22h1v1h-1zM52 22h1v1h-1z" +
  "M55 22h1v1h-1zM60 22h1v1h-1zM63 22h1v1h-1zM68 22h2v1h-2zM31 23h6v1h-6zM38 23h1v1h-1z" +
  "M40 23h1v1h-1zM45 23h1v1h-1zM47 23h1v1h-1zM49 23h1v1h-1zM51 23h1v1h-1zM53 23h1v1h-1z" +
  "M57 23h1v1h-1zM66 23h1v1h-1zM69 23h1v1h-1zM30 24h4v1h-4zM35 24h1v1h-1zM37 24h1v1h-1z" +
  "M39 24h1v1h-1zM42 24h1v1h-1zM44 24h1v1h-1zM47 24h1v1h-1zM60 24h1v1h-1zM67 24h1v1h-1z" +
  "M69 24h2v1h-2zM29 25h2v1h-2zM32 25h1v1h-1zM34 25h1v1h-1zM36 25h1v1h-1zM41 25h1v1h-1z" +
  "M46 25h1v1h-1zM51 25h1v1h-1zM53 25h1v1h-1zM56 25h1v1h-1zM70 25h2v1h-2zM28 26h2v1h-2z" +
  "M31 26h1v1h-1zM33 26h1v1h-1zM35 26h1v1h-1zM38 26h1v1h-1zM43 26h1v1h-1zM45 26h1v1h-1z" +
  "M48 26h1v1h-1zM66 26h1v1h-1zM68 26h1v1h-1zM71 26h2v1h-2zM26 27h3v1h-3zM30 27h1v1h-1z" +
  "M32 27h1v1h-1zM34 27h1v1h-1zM40 27h1v1h-1zM47 27h1v1h-1zM50 27h1v1h-1zM54 27h1v1h-1z" +
  "M70 27h1v1h-1zM72 27h2v1h-2zM25 28h3v1h-3zM29 28h1v1h-1zM31 28h1v1h-1zM45 28h1v1h-1z" +
  "M52 28h1v1h-1zM71 28h1v1h-1zM73 28h2v1h-2zM24 29h3v1h-3zM28 29h1v1h-1zM30 29h1v1h-1z" +
  "M32 29h1v1h-1zM34 29h1v1h-1zM68 29h1v1h-1zM72 29h1v1h-1zM74 29h1v1h-1zM24 30h2v1h-2z" +
  "M27 30h1v1h-1zM29 30h1v1h-1zM70 30h1v1h-1zM73 30h1v1h-1zM75 30h1v1h-1zM23 31h2v1h-2z" +
  "M28 31h1v1h-1zM31 31h1v1h-1zM43 31h1v1h-1zM73 31h1v1h-1zM75 31h2v1h-2zM22 32h2v1h-2z" +
  "M26 32h1v1h-1zM42 32h1v1h-1zM71 32h1v1h-1zM76 32h2v1h-2zM21 33h2v1h-2zM41 33h1v1h-1z" +
  "M43 33h1v1h-1zM70 33h1v1h-1zM72 33h1v1h-1zM74 33h1v1h-1zM77 33h3v1h-3zM19 34h3v1h-3z" +
  "M24 34h1v1h-1zM27 34h1v1h-1zM40 34h1v1h-1zM42 34h1v1h-1zM59 34h1v1h-1zM71 34h1v1h-1z" +
  "M73 34h1v1h-1zM76 34h1v1h-1zM79 34h2v1h-2zM17 35h2v1h-2zM26 35h1v1h-1zM28 35h1v1h-1z" +
  "M39 35h1v1h-1zM41 35h1v1h-1zM43 35h1v1h-1zM60 35h1v1h-1zM70 35h1v1h-1zM72 35h1v1h-1z" +
  "M74 35h1v1h-1zM80 35h2v1h-2zM16 36h3v1h-3zM22 36h1v1h-1zM25 36h1v1h-1zM27 36h1v1h-1z" +
  "M33 36h1v1h-1zM38 36h1v1h-1zM40 36h1v1h-1zM42 36h1v1h-1zM54 36h1v1h-1zM57 36h1v1h-1z" +
  "M59 36h1v1h-1zM71 36h3v1h-3zM75 36h1v1h-1zM77 36h1v1h-1zM81 36h2v1h-2zM16 37h1v1h-1z" +
  "M20 37h1v1h-1zM24 37h1v1h-1zM26 37h2v1h-2zM31 37h2v1h-2zM35 37h1v1h-1zM37 37h1v1h-1z" +
  "M39 37h5v1h-5zM56 37h1v1h-1zM58 37h1v1h-1zM60 37h1v1h-1zM62 37h1v1h-1zM66 37h1v1h-1z" +
  "M70 37h1v1h-1zM72 37h1v1h-1zM74 37h1v1h-1zM76 37h1v1h-1zM79 37h1v1h-1zM82 37h2v1h-2z" +
  "M14 38h2v1h-2zM18 38h1v1h-1zM22 38h2v1h-2zM25 38h2v1h-2zM33 38h1v1h-1zM36 38h1v1h-1z" +
  "M38 38h5v1h-5zM55 38h1v1h-1zM57 38h3v1h-3zM61 38h1v1h-1zM63 38h1v1h-1zM71 38h3v1h-3z" +
  "M75 38h1v1h-1zM77 38h1v1h-1zM83 38h2v1h-2zM12 39h3v1h-3zM19 39h1v1h-1zM21 39h1v1h-1z" +
  "M24 39h2v1h-2zM32 39h1v1h-1zM35 39h1v1h-1zM37 39h5v1h-5zM54 39h1v1h-1zM56 39h3v1h-3z" +
  "M60 39h1v1h-1zM62 39h1v1h-1zM71 39h6v1h-6zM78 39h1v1h-1zM80 39h1v1h-1zM84 39h2v1h-2z" +
  "M10 40h3v1h-3zM18 40h1v1h-1zM20 40h1v1h-1zM22 40h4v1h-4zM30 40h3v1h-3zM34 40h1v1h-1z" +
  "M36 40h6v1h-6zM52 40h1v1h-1zM55 40h6v1h-6zM65 40h1v1h-1zM72 40h6v1h-6zM79 40h1v1h-1z" +
  "M81 40h1v1h-1zM85 40h2v1h-2zM9 41h2v1h-2zM17 41h1v1h-1zM19 41h1v1h-1zM21 41h4v1h-4z" +
  "M31 41h1v1h-1zM33 41h1v1h-1zM35 41h7v1h-7zM54 41h6v1h-6zM61 41h1v1h-1zM63 41h1v1h-1z" +
  "M72 41h7v1h-7zM80 41h1v1h-1zM86 41h1v1h-1zM9 42h1v1h-1zM16 42h1v1h-1zM18 42h1v1h-1z" +
  "M20 42h4v1h-4zM30 42h1v1h-1zM32 42h1v1h-1zM34 42h7v1h-7zM52 42h1v1h-1zM54 42h8v1h-8z" +
  "M64 42h1v1h-1zM72 42h6v1h-6zM79 42h1v1h-1zM81 42h1v1h-1zM86 42h2v1h-2zM7 43h2v1h-2z" +
  "M17 43h1v1h-1zM19 43h4v1h-4zM29 43h1v1h-1zM31 43h1v1h-1zM33 43h7v1h-7zM51 43h1v1h-1z" +
  "M53 43h9v1h-9zM63 43h1v1h-1zM66 43h1v1h-1zM73 43h6v1h-6zM80 43h1v1h-1zM82 43h1v1h-1z" +
  "M87 43h1v1h-1zM6 44h2v1h-2zM14 44h3v1h-3zM18 44h5v1h-5zM30 44h2v1h-2zM33 44h6v1h-6z" +
  "M53 44h10v1h-10zM64 44h1v1h-1zM74 44h6v1h-6zM81 44h1v1h-1zM87 44h1v1h-1zM6 45h1v1h-1z" +
  "M12 45h1v1h-1zM15 45h1v1h-1zM17 45h5v1h-5zM28 45h2v1h-2zM31 45h7v1h-7zM52 45h12v1h-12z" +
  "M65 45h1v1h-1zM74 45h8v1h-8zM83 45h1v1h-1zM88 45h1v1h-1zM5 46h2v1h-2zM11 46h1v1h-1z" +
  "M13 46h1v1h-1zM15 46h7v1h-7zM30 46h1v1h-1zM32 46h6v1h-6zM47 46h1v1h-1zM51 46h12v1h-12z" +
  "M64 46h1v1h-1zM66 46h1v1h-1zM75 46h9v1h-9zM88 46h2v1h-2zM5 47h1v1h-1zM12 47h9v1h-9z" +
  "M27 47h1v1h-1zM29 47h1v1h-1zM31 47h6v1h-6zM40 47h1v1h-1zM42 47h1v1h-1zM51 47h13v1h-13z" +
  "M65 47h1v1h-1zM75 47h9v1h-9zM85 47h1v1h-1zM89 47h2v1h-2zM4 48h2v1h-2zM11 48h9v1h-9z" +
  "M28 48h1v1h-1zM30 48h7v1h-7zM44 48h1v1h-1zM51 48h14v1h-14zM66 48h1v1h-1zM75 48h11v1h-11z" +
  "M87 48h1v1h-1zM90 48h2v1h-2zM3 49h2v1h-2zM9 49h1v1h-1zM11 49h9v1h-9zM26 49h1v1h-1zM29 49h1v1h-1z" +
  "M31 49h6v1h-6zM39 49h1v1h-1zM41 49h1v1h-1zM43 49h1v1h-1zM45 49h1v1h-1zM47 49h1v1h-1z" +
  "M51 49h14v1h-14zM76 49h9v1h-9zM86 49h1v1h-1zM91 49h2v1h-2zM2 50h2v1h-2zM8 50h1v1h-1z" +
  "M10 50h9v1h-9zM23 50h1v1h-1zM25 50h1v1h-1zM28 50h1v1h-1zM30 50h5v1h-5zM36 50h1v1h-1z" +
  "M38 50h1v1h-1zM40 50h1v1h-1zM42 50h1v1h-1zM44 50h1v1h-1zM46 50h1v1h-1zM49 50h1v1h-1z" +
  "M51 50h2v1h-2zM59 50h6v1h-6zM66 50h1v1h-1zM69 50h1v1h-1zM71 50h1v1h-1zM73 50h1v1h-1z" +
  "M76 50h10v1h-10zM87 50h1v1h-1zM92 50h2v1h-2zM1 51h2v1h-2zM9 51h6v1h-6zM18 51h1v1h-1z" +
  "M22 51h1v1h-1zM24 51h1v1h-1zM26 51h1v1h-1zM28 51h6v1h-6zM36 51h2v1h-2zM39 51h1v1h-1z" +
  "M41 51h1v1h-1zM43 51h3v1h-3zM47 51h1v1h-1zM51 51h1v1h-1zM60 51h6v1h-6zM68 51h1v1h-1z" +
  "M70 51h1v1h-1zM72 51h1v1h-1zM74 51h1v1h-1zM77 51h10v1h-10zM93 51h2v1h-2zM1 52h1v1h-1z" +
  "M8 52h5v1h-5zM18 52h1v1h-1zM21 52h1v1h-1zM23 52h1v1h-1zM25 52h1v1h-1zM27 52h1v1h-1z" +
  "M29 52h3v1h-3zM37 52h2v1h-2zM40 52h7v1h-7zM48 52h1v1h-1zM51 52h1v1h-1zM61 52h5v1h-5z" +
  "M67 52h1v1h-1zM69 52h1v1h-1zM71 52h1v1h-1zM73 52h1v1h-1zM75 52h1v1h-1zM78 52h1v1h-1z" +
  "M81 52h6v1h-6zM95 52h1v1h-1zM0 53h1v1h-1zM3 53h1v1h-1zM5 53h1v1h-1zM7 53h1v1h-1zM9 53h4v1h-4z" +
  "M18 53h1v1h-1zM20 53h1v1h-1zM22 53h1v1h-1zM24 53h1v1h-1zM26 53h1v1h-1zM28 53h4v1h-4z" +
  "M37 53h4v1h-4zM42 53h6v1h-6zM51 53h1v1h-1zM62 53h5v1h-5zM68 53h1v1h-1zM70 53h1v1h-1z" +
  "M72 53h1v1h-1zM74 53h1v1h-1zM76 53h1v1h-1zM78 53h1v1h-1zM82 53h5v1h-5zM88 53h1v1h-1z" +
  "M90 53h2v1h-2zM96 53h1v1h-1zM0 54h1v1h-1zM2 54h1v1h-1zM4 54h1v1h-1zM6 54h1v1h-1zM8 54h4v1h-4z" +
  "M18 54h2v1h-2zM21 54h1v1h-1zM23 54h1v1h-1zM25 54h3v1h-3zM29 54h3v1h-3zM37 54h12v1h-12z" +
  "M51 54h1v1h-1zM63 54h9v1h-9zM73 54h1v1h-1zM75 54h1v1h-1zM78 54h1v1h-1zM83 54h7v1h-7z" +
  "M92 54h1v1h-1zM96 54h1v1h-1zM0 55h2v1h-2zM3 55h1v1h-1zM5 55h1v1h-1zM7 55h4v1h-4zM18 55h4v1h-4z" +
  "M23 55h1v1h-1zM25 55h7v1h-7zM38 55h11v1h-11zM51 55h1v1h-1zM63 55h6v1h-6zM70 55h1v1h-1z" +
  "M72 55h1v1h-1zM74 55h1v1h-1zM76 55h1v1h-1zM78 55h1v1h-1zM84 55h8v1h-8zM96 55h2v1h-2z" +
  "M0 56h1v1h-1zM2 56h3v1h-3zM6 56h1v1h-1zM8 56h3v1h-3zM18 56h3v1h-3zM22 56h10v1h-10z" +
  "M38 56h11v1h-11zM50 56h1v1h-1zM65 56h9v1h-9zM75 56h1v1h-1zM78 56h1v1h-1zM84 56h9v1h-9z" +
  "M94 56h1v1h-1zM97 56h1v1h-1zM0 57h6v1h-6zM7 57h4v1h-4zM19 57h12v1h-12zM38 57h10v1h-10z" +
  "M50 57h1v1h-1zM65 57h12v1h-12zM78 57h1v1h-1zM85 57h7v1h-7zM93 57h1v1h-1zM96 57h2v1h-2z" +
  "M0 58h7v1h-7zM8 58h3v1h-3zM19 58h12v1h-12zM38 58h11v1h-11zM50 58h1v1h-1zM65 58h11v1h-11z" +
  "M77 58h2v1h-2zM85 58h8v1h-8zM94 58h1v1h-1zM97 58h1v1h-1zM1 59h11v1h-11zM20 59h11v1h-11z" +
  "M38 59h10v1h-10zM49 59h2v1h-2zM66 59h11v1h-11zM78 59h1v1h-1zM85 59h9v1h-9zM95 59h1v1h-1z" +
  "M97 59h2v1h-2zM1 60h11v1h-11zM20 60h11v1h-11zM39 60h10v1h-10zM50 60h1v1h-1zM66 60h10v1h-10z" +
  "M78 60h1v1h-1zM86 60h7v1h-7zM94 60h1v1h-1zM98 60h1v1h-1zM1 61h11v1h-11zM20 61h11v1h-11z" +
  "M39 61h9v1h-9zM49 61h2v1h-2zM66 61h11v1h-11zM78 61h1v1h-1zM86 61h8v1h-8zM95 61h1v1h-1z" +
  "M98 61h1v1h-1zM2 62h11v1h-11zM20 62h11v1h-11zM39 62h10v1h-10zM50 62h1v1h-1zM66 62h10v1h-10z" +
  "M77 62h2v1h-2zM87 62h6v1h-6zM94 62h1v1h-1zM96 62h1v1h-1zM99 62h1v1h-1zM2 63h11v1h-11z" +
  "M20 63h12v1h-12zM39 63h9v1h-9zM49 63h2v1h-2zM66 63h9v1h-9zM76 63h1v1h-1zM78 63h1v1h-1z" +
  "M87 63h9v1h-9zM97 63h1v1h-1zM99 63h2v1h-2zM4 64h10v1h-10zM20 64h9v1h-9zM30 64h2v1h-2z" +
  "M39 64h10v1h-10zM50 64h1v1h-1zM66 64h10v1h-10zM77 64h2v1h-2zM88 64h9v1h-9zM98 64h1v1h-1z" +
  "M100 64h1v1h-1zM4 65h10v1h-10zM21 65h9v1h-9zM31 65h1v1h-1zM39 65h9v1h-9zM49 65h2v1h-2z" +
  "M66 65h9v1h-9zM76 65h2v1h-2zM88 65h10v1h-10zM99 65h2v1h-2zM5 66h3v1h-3zM9 66h5v1h-5z" +
  "M21 66h8v1h-8zM30 66h2v1h-2zM40 66h9v1h-9zM51 66h1v1h-1zM66 66h10v1h-10zM77 66h1v1h-1z" +
  "M89 66h10v1h-10zM100 66h1v1h-1zM5 67h2v1h-2zM8 67h1v1h-1zM10 67h4v1h-4zM21 67h9v1h-9z" +
  "M31 67h2v1h-2zM40 67h10v1h-10zM51 67h1v1h-1zM66 67h9v1h-9zM76 67h2v1h-2zM90 67h11v1h-11z" +
  "M6 68h2v1h-2zM9 68h5v1h-5zM21 68h8v1h-8zM30 68h1v1h-1zM32 68h1v1h-1zM40 68h12v1h-12z" +
  "M67 68h9v1h-9zM77 68h1v1h-1zM92 68h8v1h-8zM6 69h1v1h-1zM8 69h1v1h-1zM10 69h3v1h-3zM22 69h8v1h-8z" +
  "M31 69h2v1h-2zM40 69h10v1h-10zM51 69h1v1h-1zM67 69h8v1h-8zM76 69h1v1h-1zM94 69h5v1h-5z" +
  "M7 70h1v1h-1zM9 70h3v1h-3zM22 70h9v1h-9zM32 70h2v1h-2zM41 70h11v1h-11zM67 70h7v1h-7z" +
  "M75 70h2v1h-2zM8 71h3v1h-3zM23 71h9v1h-9zM33 71h1v1h-1zM41 71h9v1h-9zM51 71h2v1h-2z" +
  "M67 71h8v1h-8zM76 71h1v1h-1zM23 72h12v1h-12zM41 72h8v1h-8zM50 72h1v1h-1zM52 72h1v1h-1z" +
  "M67 72h7v1h-7zM75 72h2v1h-2zM24 73h9v1h-9zM34 73h1v1h-1zM41 73h9v1h-9zM51 73h2v1h-2z" +
  "M66 73h7v1h-7zM74 73h1v1h-1zM76 73h1v1h-1zM25 74h10v1h-10zM41 74h10v1h-10zM52 74h1v1h-1z" +
  "M66 74h6v1h-6zM73 74h1v1h-1zM75 74h2v1h-2zM25 75h9v1h-9zM35 75h1v1h-1zM42 75h8v1h-8z" +
  "M51 75h2v1h-2zM66 75h7v1h-7zM74 75h2v1h-2zM26 76h4v1h-4zM31 76h5v1h-5zM42 76h9v1h-9z" +
  "M52 76h2v1h-2zM66 76h8v1h-8zM75 76h1v1h-1zM26 77h3v1h-3zM30 77h1v1h-1zM32 77h4v1h-4z" +
  "M43 77h4v1h-4zM48 77h4v1h-4zM53 77h1v1h-1zM65 77h8v1h-8zM74 77h2v1h-2zM27 78h1v1h-1z" +
  "M29 78h1v1h-1zM31 78h1v1h-1zM33 78h3v1h-3zM43 78h3v1h-3zM47 78h1v1h-1zM49 78h5v1h-5z" +
  "M65 78h11v1h-11zM27 79h2v1h-2zM30 79h1v1h-1zM32 79h4v1h-4zM44 79h1v1h-1zM46 79h1v1h-1z" +
  "M48 79h1v1h-1zM50 79h4v1h-4zM65 79h10v1h-10zM28 80h2v1h-2zM31 80h4v1h-4zM44 80h2v1h-2z" +
  "M47 80h1v1h-1zM49 80h1v1h-1zM51 80h3v1h-3zM65 80h10v1h-10zM30 81h4v1h-4zM45 81h2v1h-2z" +
  "M48 81h1v1h-1zM50 81h4v1h-4zM65 81h5v1h-5zM71 81h3v1h-3zM45 82h1v1h-1zM47 82h1v1h-1z" +
  "M49 82h4v1h-4zM65 82h4v1h-4zM70 82h1v1h-1zM72 82h2v1h-2zM46 83h6v1h-6zM65 83h3v1h-3z" +
  "M69 83h1v1h-1zM71 83h1v1h-1zM73 83h1v1h-1zM47 84h4v1h-4zM66 84h1v1h-1zM68 84h1v1h-1z" +
  "M70 84h1v1h-1zM72 84h1v1h-1zM66 85h2v1h-2zM69 85h1v1h-1zM71 85h2v1h-2zM67 86h2v1h-2z" +
  "M70 86h2v1h-2zM68 87h3v1h-3z";

/** Every cell inside the outline — ink and lit together. */
const SILHOUETTE_PATH =
  "M38 0h25v1h-25zM36 1h27v1h-27zM36 2h28v1h-28zM36 3h28v1h-28zM35 4h29v1h-29zM35 5h30v1h-30z" +
  "M35 6h30v1h-30zM35 7h30v1h-30zM35 8h30v1h-30zM35 9h30v1h-30zM35 10h30v1h-30zM35 11h30v1h-30z" +
  "M36 12h29v1h-29zM35 13h30v1h-30zM35 14h32v1h-32zM34 15h33v1h-33zM34 16h33v1h-33zM33 17h35v1h-35z" +
  "M33 18h35v1h-35zM33 19h35v1h-35zM32 20h37v1h-37zM32 21h37v1h-37zM31 22h39v1h-39zM31 23h39v1h-39z" +
  "M30 24h41v1h-41zM29 25h43v1h-43zM28 26h45v1h-45zM26 27h48v1h-48zM25 28h50v1h-50zM24 29h51v1h-51z" +
  "M24 30h52v1h-52zM23 31h54v1h-54zM22 32h56v1h-56zM21 33h59v1h-59zM19 34h62v1h-62zM17 35h65v1h-65z" +
  "M16 36h67v1h-67zM16 37h68v1h-68zM14 38h71v1h-71zM12 39h74v1h-74zM10 40h77v1h-77zM9 41h78v1h-78z" +
  "M9 42h79v1h-79zM7 43h81v1h-81zM6 44h82v1h-82zM6 45h83v1h-83zM5 46h85v1h-85zM5 47h86v1h-86z" +
  "M4 48h88v1h-88zM3 49h90v1h-90zM2 50h33v1h-33zM36 50h17v1h-17zM59 50h35v1h-35zM1 51h14v1h-14z" +
  "M18 51h16v1h-16zM36 51h16v1h-16zM60 51h35v1h-35zM1 52h12v1h-12zM18 52h14v1h-14zM37 52h15v1h-15z" +
  "M61 52h18v1h-18zM81 52h15v1h-15zM0 53h13v1h-13zM18 53h14v1h-14zM37 53h15v1h-15zM62 53h17v1h-17z" +
  "M82 53h15v1h-15zM0 54h12v1h-12zM18 54h14v1h-14zM37 54h15v1h-15zM63 54h16v1h-16zM83 54h14v1h-14z" +
  "M0 55h11v1h-11zM18 55h14v1h-14zM38 55h14v1h-14zM63 55h16v1h-16zM84 55h14v1h-14zM0 56h11v1h-11z" +
  "M18 56h14v1h-14zM38 56h13v1h-13zM65 56h14v1h-14zM84 56h14v1h-14zM0 57h11v1h-11zM19 57h12v1h-12z" +
  "M38 57h13v1h-13zM65 57h14v1h-14zM85 57h13v1h-13zM0 58h11v1h-11zM19 58h12v1h-12zM38 58h13v1h-13z" +
  "M65 58h14v1h-14zM85 58h13v1h-13zM1 59h11v1h-11zM20 59h11v1h-11zM38 59h13v1h-13zM66 59h13v1h-13z" +
  "M85 59h14v1h-14zM1 60h11v1h-11zM20 60h11v1h-11zM39 60h12v1h-12zM66 60h13v1h-13zM86 60h13v1h-13z" +
  "M1 61h11v1h-11zM20 61h11v1h-11zM39 61h12v1h-12zM66 61h13v1h-13zM86 61h13v1h-13zM2 62h11v1h-11z" +
  "M20 62h11v1h-11zM39 62h12v1h-12zM66 62h13v1h-13zM87 62h13v1h-13zM2 63h11v1h-11zM20 63h12v1h-12z" +
  "M39 63h12v1h-12zM66 63h13v1h-13zM87 63h14v1h-14zM4 64h10v1h-10zM20 64h12v1h-12zM39 64h12v1h-12z" +
  "M66 64h13v1h-13zM88 64h13v1h-13zM4 65h10v1h-10zM21 65h11v1h-11zM39 65h12v1h-12zM66 65h12v1h-12z" +
  "M88 65h13v1h-13zM5 66h9v1h-9zM21 66h11v1h-11zM40 66h12v1h-12zM66 66h12v1h-12zM89 66h12v1h-12z" +
  "M5 67h9v1h-9zM21 67h12v1h-12zM40 67h12v1h-12zM66 67h12v1h-12zM90 67h11v1h-11zM6 68h8v1h-8z" +
  "M21 68h12v1h-12zM40 68h12v1h-12zM67 68h11v1h-11zM92 68h8v1h-8zM6 69h7v1h-7zM22 69h11v1h-11z" +
  "M40 69h12v1h-12zM67 69h10v1h-10zM94 69h5v1h-5zM7 70h5v1h-5zM22 70h12v1h-12zM41 70h11v1h-11z" +
  "M67 70h10v1h-10zM8 71h3v1h-3zM23 71h11v1h-11zM41 71h12v1h-12zM67 71h10v1h-10zM23 72h12v1h-12z" +
  "M41 72h12v1h-12zM67 72h10v1h-10zM24 73h11v1h-11zM41 73h12v1h-12zM66 73h11v1h-11zM25 74h10v1h-10z" +
  "M41 74h12v1h-12zM66 74h11v1h-11zM25 75h11v1h-11zM42 75h11v1h-11zM66 75h10v1h-10zM26 76h10v1h-10z" +
  "M42 76h12v1h-12zM66 76h10v1h-10zM26 77h10v1h-10zM43 77h11v1h-11zM65 77h11v1h-11zM27 78h9v1h-9z" +
  "M43 78h11v1h-11zM65 78h11v1h-11zM27 79h9v1h-9zM44 79h10v1h-10zM65 79h10v1h-10zM28 80h7v1h-7z" +
  "M44 80h10v1h-10zM65 80h10v1h-10zM30 81h4v1h-4zM45 81h9v1h-9zM65 81h9v1h-9zM45 82h8v1h-8z" +
  "M65 82h9v1h-9zM46 83h6v1h-6zM65 83h9v1h-9zM47 84h4v1h-4zM66 84h7v1h-7zM66 85h7v1h-7z" +
  "M67 86h5v1h-5zM68 87h3v1h-3z";

/** The white cells the outline encloses: the paper the hand covers. */
const LIT_PATH =
  "M59 13h1v1h-1zM61 13h1v1h-1zM56 14h1v1h-1zM58 14h1v1h-1zM60 14h1v1h-1zM62 14h1v1h-1z" +
  "M59 15h1v1h-1zM61 15h1v1h-1zM63 15h1v1h-1zM53 16h1v1h-1zM55 16h1v1h-1zM57 16h1v1h-1z" +
  "M60 16h1v1h-1zM62 16h1v1h-1zM64 16h1v1h-1zM50 17h1v1h-1zM52 17h1v1h-1zM54 17h1v1h-1z" +
  "M56 17h1v1h-1zM58 17h4v1h-4zM63 17h1v1h-1zM65 17h1v1h-1zM49 18h1v1h-1zM51 18h1v1h-1z" +
  "M53 18h1v1h-1zM55 18h3v1h-3zM59 18h1v1h-1zM61 18h4v1h-4zM48 19h1v1h-1zM50 19h1v1h-1z" +
  "M52 19h1v1h-1zM54 19h2v1h-2zM57 19h6v1h-6zM64 19h2v1h-2zM47 20h1v1h-1zM49 20h1v1h-1z" +
  "M51 20h1v1h-1zM53 20h1v1h-1zM55 20h4v1h-4zM60 20h1v1h-1zM62 20h3v1h-3zM66 20h1v1h-1z" +
  "M44 21h1v1h-1zM46 21h1v1h-1zM48 21h1v1h-1zM50 21h1v1h-1zM52 21h5v1h-5zM58 21h8v1h-8z" +
  "M67 21h1v1h-1zM40 22h1v1h-1zM43 22h1v1h-1zM45 22h1v1h-1zM47 22h1v1h-1zM49 22h1v1h-1z" +
  "M51 22h1v1h-1zM53 22h2v1h-2zM56 22h4v1h-4zM61 22h2v1h-2zM64 22h4v1h-4zM37 23h1v1h-1z" +
  "M39 23h1v1h-1zM41 23h4v1h-4zM46 23h1v1h-1zM48 23h1v1h-1zM50 23h1v1h-1zM52 23h1v1h-1z" +
  "M54 23h3v1h-3zM58 23h8v1h-8zM67 23h2v1h-2zM34 24h1v1h-1zM36 24h1v1h-1zM38 24h1v1h-1z" +
  "M40 24h2v1h-2zM43 24h1v1h-1zM45 24h2v1h-2zM48 24h12v1h-12zM61 24h6v1h-6zM68 24h1v1h-1z" +
  "M31 25h1v1h-1zM33 25h1v1h-1zM35 25h1v1h-1zM37 25h4v1h-4zM42 25h4v1h-4zM47 25h4v1h-4z" +
  "M52 25h1v1h-1zM54 25h2v1h-2zM57 25h13v1h-13zM30 26h1v1h-1zM32 26h1v1h-1zM34 26h1v1h-1z" +
  "M36 26h2v1h-2zM39 26h4v1h-4zM44 26h1v1h-1zM46 26h2v1h-2zM49 26h17v1h-17zM67 26h1v1h-1z" +
  "M69 26h2v1h-2zM29 27h1v1h-1zM31 27h1v1h-1zM33 27h1v1h-1zM35 27h5v1h-5zM41 27h6v1h-6z" +
  "M48 27h2v1h-2zM51 27h3v1h-3zM55 27h15v1h-15zM71 27h1v1h-1zM28 28h1v1h-1zM30 28h1v1h-1z" +
  "M32 28h13v1h-13zM46 28h6v1h-6zM53 28h18v1h-18zM72 28h1v1h-1zM27 29h1v1h-1zM29 29h1v1h-1z" +
  "M31 29h1v1h-1zM33 29h1v1h-1zM35 29h33v1h-33zM69 29h3v1h-3zM73 29h1v1h-1zM26 30h1v1h-1z" +
  "M28 30h1v1h-1zM30 30h40v1h-40zM71 30h2v1h-2zM74 30h1v1h-1zM25 31h3v1h-3zM29 31h2v1h-2z" +
  "M32 31h11v1h-11zM44 31h29v1h-29zM74 31h1v1h-1zM24 32h2v1h-2zM27 32h15v1h-15zM43 32h28v1h-28z" +
  "M72 32h4v1h-4zM23 33h18v1h-18zM42 33h1v1h-1zM44 33h26v1h-26zM71 33h1v1h-1zM73 33h1v1h-1z" +
  "M75 33h2v1h-2zM22 34h2v1h-2zM25 34h2v1h-2zM28 34h12v1h-12zM41 34h1v1h-1zM43 34h16v1h-16z" +
  "M60 34h11v1h-11zM72 34h1v1h-1zM74 34h2v1h-2zM77 34h2v1h-2zM19 35h7v1h-7zM27 35h1v1h-1z" +
  "M29 35h10v1h-10zM40 35h1v1h-1zM42 35h1v1h-1zM44 35h16v1h-16zM61 35h9v1h-9zM71 35h1v1h-1z" +
  "M73 35h1v1h-1zM75 35h5v1h-5zM19 36h3v1h-3zM23 36h2v1h-2zM26 36h1v1h-1zM28 36h5v1h-5z" +
  "M34 36h4v1h-4zM39 36h1v1h-1zM41 36h1v1h-1zM43 36h11v1h-11zM55 36h2v1h-2zM58 36h1v1h-1z" +
  "M60 36h11v1h-11zM74 36h1v1h-1zM76 36h1v1h-1zM78 36h3v1h-3zM17 37h3v1h-3zM21 37h3v1h-3z" +
  "M25 37h1v1h-1zM28 37h3v1h-3zM33 37h2v1h-2zM36 37h1v1h-1zM38 37h1v1h-1zM44 37h12v1h-12z" +
  "M57 37h1v1h-1zM59 37h1v1h-1zM61 37h1v1h-1zM63 37h3v1h-3zM67 37h3v1h-3zM71 37h1v1h-1z" +
  "M73 37h1v1h-1zM75 37h1v1h-1zM77 37h2v1h-2zM80 37h2v1h-2zM16 38h2v1h-2zM19 38h3v1h-3z" +
  "M24 38h1v1h-1zM27 38h6v1h-6zM34 38h2v1h-2zM37 38h1v1h-1zM43 38h12v1h-12zM56 38h1v1h-1z" +
  "M60 38h1v1h-1zM62 38h1v1h-1zM64 38h7v1h-7zM74 38h1v1h-1zM76 38h1v1h-1zM78 38h5v1h-5z" +
  "M15 39h4v1h-4zM20 39h1v1h-1zM22 39h2v1h-2zM26 39h6v1h-6zM33 39h2v1h-2zM36 39h1v1h-1z" +
  "M42 39h12v1h-12zM55 39h1v1h-1zM59 39h1v1h-1zM61 39h1v1h-1zM63 39h8v1h-8zM77 39h1v1h-1z" +
  "M79 39h1v1h-1zM81 39h3v1h-3zM13 40h5v1h-5zM19 40h1v1h-1zM21 40h1v1h-1zM26 40h4v1h-4z" +
  "M33 40h1v1h-1zM35 40h1v1h-1zM42 40h10v1h-10zM53 40h2v1h-2zM61 40h4v1h-4zM66 40h6v1h-6z" +
  "M78 40h1v1h-1zM80 40h1v1h-1zM82 40h3v1h-3zM11 41h6v1h-6zM18 41h1v1h-1zM20 41h1v1h-1z" +
  "M25 41h6v1h-6zM32 41h1v1h-1zM34 41h1v1h-1zM42 41h12v1h-12zM60 41h1v1h-1zM62 41h1v1h-1z" +
  "M64 41h8v1h-8zM79 41h1v1h-1zM81 41h5v1h-5zM10 42h6v1h-6zM17 42h1v1h-1zM19 42h1v1h-1z" +
  "M24 42h6v1h-6zM31 42h1v1h-1zM33 42h1v1h-1zM41 42h11v1h-11zM53 42h1v1h-1zM62 42h2v1h-2z" +
  "M65 42h7v1h-7zM78 42h1v1h-1zM80 42h1v1h-1zM82 42h4v1h-4zM9 43h8v1h-8zM18 43h1v1h-1z" +
  "M23 43h6v1h-6zM30 43h1v1h-1zM32 43h1v1h-1zM40 43h11v1h-11zM52 43h1v1h-1zM62 43h1v1h-1z" +
  "M64 43h2v1h-2zM67 43h6v1h-6zM79 43h1v1h-1zM81 43h1v1h-1zM83 43h4v1h-4zM8 44h6v1h-6z" +
  "M17 44h1v1h-1zM23 44h7v1h-7zM32 44h1v1h-1zM39 44h14v1h-14zM63 44h1v1h-1zM65 44h9v1h-9z" +
  "M80 44h1v1h-1zM82 44h5v1h-5zM7 45h5v1h-5zM13 45h2v1h-2zM16 45h1v1h-1zM22 45h6v1h-6z" +
  "M30 45h1v1h-1zM38 45h14v1h-14zM64 45h1v1h-1zM66 45h8v1h-8zM82 45h1v1h-1zM84 45h4v1h-4z" +
  "M7 46h4v1h-4zM12 46h1v1h-1zM14 46h1v1h-1zM22 46h8v1h-8zM31 46h1v1h-1zM38 46h9v1h-9z" +
  "M48 46h3v1h-3zM63 46h1v1h-1zM65 46h1v1h-1zM67 46h8v1h-8zM84 46h4v1h-4zM6 47h6v1h-6z" +
  "M21 47h6v1h-6zM28 47h1v1h-1zM30 47h1v1h-1zM37 47h3v1h-3zM41 47h1v1h-1zM43 47h8v1h-8z" +
  "M64 47h1v1h-1zM66 47h9v1h-9zM84 47h1v1h-1zM86 47h3v1h-3zM6 48h5v1h-5zM20 48h8v1h-8z" +
  "M29 48h1v1h-1zM37 48h7v1h-7zM45 48h6v1h-6zM65 48h1v1h-1zM67 48h8v1h-8zM86 48h1v1h-1z" +
  "M88 48h2v1h-2zM5 49h4v1h-4zM10 49h1v1h-1zM20 49h6v1h-6zM27 49h2v1h-2zM30 49h1v1h-1z" +
  "M37 49h2v1h-2zM40 49h1v1h-1zM42 49h1v1h-1zM44 49h1v1h-1zM46 49h1v1h-1zM48 49h3v1h-3z" +
  "M65 49h11v1h-11zM85 49h1v1h-1zM87 49h4v1h-4zM4 50h4v1h-4zM9 50h1v1h-1zM19 50h4v1h-4z" +
  "M24 50h1v1h-1zM26 50h2v1h-2zM29 50h1v1h-1zM37 50h1v1h-1zM39 50h1v1h-1zM41 50h1v1h-1z" +
  "M43 50h1v1h-1zM45 50h1v1h-1zM47 50h2v1h-2zM50 50h1v1h-1zM65 50h1v1h-1zM67 50h2v1h-2z" +
  "M70 50h1v1h-1zM72 50h1v1h-1zM74 50h2v1h-2zM86 50h1v1h-1zM88 50h4v1h-4zM3 51h6v1h-6z" +
  "M19 51h3v1h-3zM23 51h1v1h-1zM25 51h1v1h-1zM27 51h1v1h-1zM38 51h1v1h-1zM40 51h1v1h-1z" +
  "M42 51h1v1h-1zM46 51h1v1h-1zM48 51h3v1h-3zM66 51h2v1h-2zM69 51h1v1h-1zM71 51h1v1h-1z" +
  "M73 51h1v1h-1zM75 51h2v1h-2zM87 51h6v1h-6zM2 52h6v1h-6zM19 52h2v1h-2zM22 52h1v1h-1z" +
  "M24 52h1v1h-1zM26 52h1v1h-1zM28 52h1v1h-1zM39 52h1v1h-1zM47 52h1v1h-1zM49 52h2v1h-2z" +
  "M66 52h1v1h-1zM68 52h1v1h-1zM70 52h1v1h-1zM72 52h1v1h-1zM74 52h1v1h-1zM76 52h2v1h-2z" +
  "M87 52h8v1h-8zM1 53h2v1h-2zM4 53h1v1h-1zM6 53h1v1h-1zM8 53h1v1h-1zM19 53h1v1h-1zM21 53h1v1h-1z" +
  "M23 53h1v1h-1zM25 53h1v1h-1zM27 53h1v1h-1zM41 53h1v1h-1zM48 53h3v1h-3zM67 53h1v1h-1z" +
  "M69 53h1v1h-1zM71 53h1v1h-1zM73 53h1v1h-1zM75 53h1v1h-1zM77 53h1v1h-1zM87 53h1v1h-1z" +
  "M89 53h1v1h-1zM92 53h4v1h-4zM1 54h1v1h-1zM3 54h1v1h-1zM5 54h1v1h-1zM7 54h1v1h-1zM20 54h1v1h-1z" +
  "M22 54h1v1h-1zM24 54h1v1h-1zM28 54h1v1h-1zM49 54h2v1h-2zM72 54h1v1h-1zM74 54h1v1h-1z" +
  "M76 54h2v1h-2zM90 54h2v1h-2zM93 54h3v1h-3zM2 55h1v1h-1zM4 55h1v1h-1zM6 55h1v1h-1zM22 55h1v1h-1z" +
  "M24 55h1v1h-1zM49 55h2v1h-2zM69 55h1v1h-1zM71 55h1v1h-1zM73 55h1v1h-1zM75 55h1v1h-1z" +
  "M77 55h1v1h-1zM92 55h4v1h-4zM1 56h1v1h-1zM5 56h1v1h-1zM7 56h1v1h-1zM21 56h1v1h-1zM49 56h1v1h-1z" +
  "M74 56h1v1h-1zM76 56h2v1h-2zM93 56h1v1h-1zM95 56h2v1h-2zM6 57h1v1h-1zM48 57h2v1h-2z" +
  "M77 57h1v1h-1zM92 57h1v1h-1zM94 57h2v1h-2zM7 58h1v1h-1zM49 58h1v1h-1zM76 58h1v1h-1z" +
  "M93 58h1v1h-1zM95 58h2v1h-2zM48 59h1v1h-1zM77 59h1v1h-1zM94 59h1v1h-1zM96 59h1v1h-1z" +
  "M49 60h1v1h-1zM76 60h2v1h-2zM93 60h1v1h-1zM95 60h3v1h-3zM48 61h1v1h-1zM77 61h1v1h-1z" +
  "M94 61h1v1h-1zM96 61h2v1h-2zM49 62h1v1h-1zM76 62h1v1h-1zM93 62h1v1h-1zM95 62h1v1h-1z" +
  "M97 62h2v1h-2zM48 63h1v1h-1zM75 63h1v1h-1zM77 63h1v1h-1zM96 63h1v1h-1zM98 63h1v1h-1z" +
  "M29 64h1v1h-1zM49 64h1v1h-1zM76 64h1v1h-1zM97 64h1v1h-1zM99 64h1v1h-1zM30 65h1v1h-1z" +
  "M48 65h1v1h-1zM75 65h1v1h-1zM98 65h1v1h-1zM8 66h1v1h-1zM29 66h1v1h-1zM49 66h2v1h-2z" +
  "M76 66h1v1h-1zM99 66h1v1h-1zM7 67h1v1h-1zM9 67h1v1h-1zM30 67h1v1h-1zM50 67h1v1h-1zM75 67h1v1h-1z" +
  "M8 68h1v1h-1zM29 68h1v1h-1zM31 68h1v1h-1zM76 68h1v1h-1zM7 69h1v1h-1zM9 69h1v1h-1zM30 69h1v1h-1z" +
  "M50 69h1v1h-1zM75 69h1v1h-1zM8 70h1v1h-1zM31 70h1v1h-1zM74 70h1v1h-1zM32 71h1v1h-1z" +
  "M50 71h1v1h-1zM75 71h1v1h-1zM49 72h1v1h-1zM51 72h1v1h-1zM74 72h1v1h-1zM33 73h1v1h-1z" +
  "M50 73h1v1h-1zM73 73h1v1h-1zM75 73h1v1h-1zM51 74h1v1h-1zM72 74h1v1h-1zM74 74h1v1h-1z" +
  "M34 75h1v1h-1zM50 75h1v1h-1zM73 75h1v1h-1zM30 76h1v1h-1zM51 76h1v1h-1zM74 76h1v1h-1z" +
  "M29 77h1v1h-1zM31 77h1v1h-1zM47 77h1v1h-1zM52 77h1v1h-1zM73 77h1v1h-1zM28 78h1v1h-1z" +
  "M30 78h1v1h-1zM32 78h1v1h-1zM46 78h1v1h-1zM48 78h1v1h-1zM29 79h1v1h-1zM31 79h1v1h-1z" +
  "M45 79h1v1h-1zM47 79h1v1h-1zM49 79h1v1h-1zM30 80h1v1h-1zM46 80h1v1h-1zM48 80h1v1h-1z" +
  "M50 80h1v1h-1zM47 81h1v1h-1zM49 81h1v1h-1zM70 81h1v1h-1zM46 82h1v1h-1zM48 82h1v1h-1z" +
  "M69 82h1v1h-1zM71 82h1v1h-1zM68 83h1v1h-1zM70 83h1v1h-1zM72 83h1v1h-1zM67 84h1v1h-1z" +
  "M69 84h1v1h-1zM71 84h1v1h-1zM68 85h1v1h-1zM70 85h1v1h-1zM69 86h1v1h-1z";
