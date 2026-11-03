import { cn } from "../../lib/utils";

interface MulticaWordmarkProps extends React.ComponentProps<"svg"> {
  writeDelayMs?: number;
  hop?: boolean;
  title?: string;
}

export function MulticaWordmark({
  writeDelayMs: _writeDelayMs,
  hop: _hop,
  title = "Agent团队协作",
  className,
  ...props
}: MulticaWordmarkProps) {
  return (
    <svg
      viewBox="0 0 340 48"
      role="img"
      aria-label={title}
      fill="currentColor"
      className={cn("inline-block h-[1em] w-auto shrink-0 overflow-visible", className)}
      {...props}
    >
      <text x="0" y="39" fontSize="40" fontWeight="700" textLength="340" lengthAdjust="spacingAndGlyphs">
        Agent团队协作
      </text>
    </svg>
  );
}
