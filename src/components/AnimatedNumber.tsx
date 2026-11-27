import { useEffect, useRef, useState } from "react";

interface AnimatedNumberProps {
  value: number | null | undefined;
  decimals?: number;
  durationMs?: number;
  prefix?: string;
  suffix?: string;
  fallback?: string;
  className?: string;
}

/**
 * Smoothly interpolates between real numeric sensor updates using requestAnimationFrame
 * and always snaps strictly to the exact current reading at transition completion.
 * Respects `prefers-reduced-motion`.
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  durationMs = 420,
  prefix = "",
  suffix = "",
  fallback = "--",
  className = "",
}: AnimatedNumberProps) {
  const isValid = typeof value === "number" && Number.isFinite(value);
  const [displayValue, setDisplayValue] = useState<number | null>(isValid ? value : null);
  const prevValueRef = useRef<number | null>(isValid ? value : null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isValid) {
      prevValueRef.current = null;
      setDisplayValue(null);
      return;
    }

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const from = prevValueRef.current;
    const to = value as number;

    if (prefersReducedMotion || from === null || from === to) {
      prevValueRef.current = to;
      setDisplayValue(to);
      return;
    }

    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(1, elapsed / durationMs);
      // Cubic ease-out for crisp physiological meter settling
      const eased = 1 - Math.pow(1 - progress, 3);
      const interpolated = from + (to - from) * eased;

      if (progress < 1) {
        setDisplayValue(interpolated);
        rafRef.current = requestAnimationFrame(tick);
      } else {
        prevValueRef.current = to;
        setDisplayValue(to);
        rafRef.current = null;
      }
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      prevValueRef.current = to;
    };
  }, [value, isValid, durationMs]);

  if (!isValid || displayValue === null) {
    return <span className={`tabular-nums ${className}`}>{fallback}</span>;
  }

  const formatted =
    decimals > 0 ? displayValue.toFixed(decimals) : Math.round(displayValue).toString();

  return (
    <span className={`tabular-nums ${className}`}>
      {prefix}
      {formatted}
      {suffix}
    </span>
  );
}
