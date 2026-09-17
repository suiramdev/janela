import { cn } from "cn";

import { Dotm3x3_20 } from "./dotm-3x3-20.tsx";

const DEFAULT_SIZE = 16;

function Spinner({
  className,
  size = DEFAULT_SIZE,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & { readonly size?: number }) {
  return (
    <span
      data-slot="spinner"
      className={cn("inline-flex shrink-0 items-center justify-center", className)}
      {...props}
    >
      <Dotm3x3_20 size={size} />
    </span>
  );
}

export { Spinner };
