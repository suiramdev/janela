import { FaultyTerminal } from "@janela/design";
import type { ReactElement } from "react";

const BACKDROP =
  "absolute inset-0 [mask-image:radial-gradient(75%_75%_at_50%_48%,transparent_12%,black_78%)] opacity-[0.07] mix-blend-exclusion contrast-more:hidden dark:opacity-[0.28]";

export function WindowBackdrop(): ReactElement {
  return <FaultyTerminal className={BACKDROP} digitSize={1.5} timeScale={0.25} brightness={0.9} />;
}
