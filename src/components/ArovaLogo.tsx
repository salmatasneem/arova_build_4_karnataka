import { motion } from "motion/react";

interface ArovaLogoProps {
  size?: number;
  className?: string;
  animated?: boolean;
}

/**
 * Medical-green AROVA emblem inspired by crisp clinical cross iconography:
 * pure white circular badge, bright medical green (#00B800) ring & cross,
 * and integrated pulse line.
 */
export function ArovaLogo({ size = 40, className = "", animated = true }: ArovaLogoProps) {
  const pulsePath = "M13.5 24H18.5L20.8 19.4L23.6 28.6L26.2 21.2L28 24H34.5";

  return (
    <motion.div
      initial={animated ? { opacity: 0, scale: 0.88 } : false}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.48, ease: [0.16, 1, 0.3, 1] }}
      className={`relative inline-flex shrink-0 ${animated ? "arova-logo-breathe" : ""} ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 48 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="w-full h-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id="arovaCrossGrad" x1="12" y1="10" x2="36" y2="38" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00B800" />
            <stop offset="1" stopColor="#008F00" />
          </linearGradient>
        </defs>

        {/* Crisp white clinical container with medical green ring */}
        <circle
          cx="24"
          cy="24"
          r="21.5"
          fill="#FFFFFF"
          stroke="#00B800"
          strokeWidth="2.4"
        />

        {/* Bold bright medical green cross */}
        <path
          d="M20.2 11.5C20.2 10.6716 20.8716 10 21.7 10H26.3C27.1284 10 27.8 10.6716 27.8 11.5V20.2H36.5C37.3284 20.2 38 20.8716 38 21.7V26.3C38 27.1284 37.3284 27.8 36.5 27.8H27.8V36.5C27.8 37.3284 27.1284 38 26.3 38H21.7C20.8716 38 20.2 37.3284 20.2 36.5V27.8H11.5C10.6716 27.8 10 27.1284 10 26.3V21.7C10 20.8716 10.6716 20.2 11.5 20.2H20.2V11.5Z"
          fill="url(#arovaCrossGrad)"
        />

        {/* Crisp white integrated pulse line */}
        {animated ? (
          <motion.path
            d={pulsePath}
            stroke="#FFFFFF"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0.4 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        ) : (
          <path
            d={pulsePath}
            stroke="#FFFFFF"
            strokeWidth="2.1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
      </svg>
    </motion.div>
  );
}

interface ArovaBrandLockupProps {
  variant?: "hero" | "hero-dark" | "sidebar" | "landing";
}

export function ArovaBrandLockup({ variant = "hero" }: ArovaBrandLockupProps) {
  if (variant === "sidebar") {
    return (
      <div className="flex items-center gap-3">
        <ArovaLogo size={38} />
        <div className="min-w-0">
          <div className="font-arova-script text-[28px] font-bold tracking-wide text-white leading-none">
            AROVA
          </div>
          <div className="text-[11px] font-medium text-[#00B800] mt-0.5 tracking-tight whitespace-nowrap">
            Connected Care Intelligence
          </div>
        </div>
      </div>
    );
  }

  if (variant === "landing") {
    return (
      <div className="flex items-center gap-3">
        <ArovaLogo size={38} />
        <div className="min-w-0">
          <div className="font-arova-script text-[28px] font-bold tracking-wide text-white leading-none">
            AROVA
          </div>
          <div className="text-[11px] font-medium text-[#00B800] mt-0.5 tracking-tight whitespace-nowrap">
            Wearable Early Warning
          </div>
        </div>
      </div>
    );
  }

  if (variant === "hero-dark") {
    return (
      <div className="flex items-center gap-3.5">
        <ArovaLogo size={46} className="rounded-full" />
        <div className="min-w-0">
          <div className="font-arova-script text-3xl sm:text-4xl font-bold tracking-wide text-white leading-none">
            AROVA
          </div>
          <div className="text-xs font-medium text-[#00B800] mt-1 tracking-tight">
            Intelligent Connected Care
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3.5">
      <ArovaLogo size={48} />
      <div className="min-w-0">
        <div className="font-arova-script text-4xl sm:text-[42px] font-bold tracking-wide text-[#202525] leading-none">
          AROVA
        </div>
        <div className="text-xs sm:text-[13px] font-semibold text-[#008F00] mt-1 tracking-tight">
          Intelligent Connected Care
        </div>
      </div>
    </div>
  );
}
