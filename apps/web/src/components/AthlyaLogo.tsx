/**
 * Athlya logo: the A-mi mascot (a running italic "A") and the ATHLYA wordmark.
 *
 * GENERATED from assets/brand/scripts/build-brand.mjs; see docs/brand/README.md.
 * Inline SVG so it inherits `currentColor`; the eyes are cut out with a
 * mask so they show whatever background the logo sits on.
 */
import { useId } from 'react';

import type { ReactElement } from 'react';

export interface AthlyaLogoProps {
  /** `lockup` = mascot + wordmark, `mascot` = pictogram only. */
  readonly variant?: 'lockup' | 'mascot';
  /** Rendered height in CSS pixels; width follows the aspect ratio. */
  readonly height?: number;
  /** Headband colour; defaults to the logo colour. */
  readonly band?: string;
  readonly className?: string;
}

const WORDMARK =
  'M75.90 68.80L52.50 68.80L51.66 59.10L27.56 59.10L22.60 68.80L0 68.80L39.72 0L65.42 0L75.90 68.80ZM47.94 19.20L35.44 43.70L50.34 43.70L48.34 19.20L47.94 19.20ZM149.28 17.60L126.78 17.60L115.90 68.80L93.80 68.80L104.68 17.60L82.08 17.60L85.82 0L153.02 0L149.28 17.60ZM216.00 68.80L193.90 68.80L199.45 42.70L175.15 42.70L169.60 68.80L147.50 68.80L162.12 0L184.22 0L178.89 25.10L203.19 25.10L208.52 0L230.62 0L216.00 68.80ZM229.80 68.80L244.42 0L266.52 0L255.64 51.20L290.94 51.20L287.20 68.80L229.80 68.80ZM336.18 42.10L330.50 68.80L308.40 68.80L314.08 42.10L295.72 0L321.12 0L329.46 22.90L329.86 22.90L347.92 0L372.02 0L336.18 42.10ZM424.70 68.80L401.30 68.80L400.46 59.10L376.36 59.10L371.40 68.80L348.80 68.80L388.52 0L414.22 0L424.70 68.80ZM396.74 19.20L384.24 43.70L399.14 43.70L397.14 19.20L396.74 19.20Z';

function Mascot({
  color,
  band,
  maskId,
}: {
  color: string;
  band: string;
  maskId: string;
}): ReactElement {
  return (
    <g mask={`url(#${maskId})`}>
      <path
        d="M3 50 H17"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M7 64 H19"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M3 78 H13"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M45 58 L31 52"
        stroke={color}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M84 54 L97 43"
        stroke={color}
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <g transform="translate(10 0) skewX(-12)">
        <path d="M32 90 L52 14 L72 14 L92 90 L74 90 L62 46 L50 90 Z" fill={color} />
      </g>
      <g transform="translate(10 0) skewX(-12)">
        <rect x="47" y="18" width="29" height="6" rx="3" fill={band} />
      </g>
      <path
        d="M53.5 21 L42.5 25"
        stroke={band}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path
        d="M53.5 22 L45.5 31"
        stroke={band}
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </g>
  );
}

export function AthlyaLogo({
  variant = 'lockup',
  height = 32,
  band,
  className,
}: AthlyaLogoProps): ReactElement {
  const maskId = `athlya-eyes-${useId().replace(/:/g, '')}`;
  const color = 'currentColor';
  const bandColor = band ?? color;
  const mask = (
    <mask id={maskId} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
      <rect x="-10" y="-10" width="120" height="120" fill="white" />
      <ellipse cx="60.41" cy="31" rx="2.9" ry="4.2" fill="black" />
      <ellipse cx="69.91" cy="31" rx="2.9" ry="4.2" fill="black" />
    </mask>
  );
  if (variant === 'mascot') {
    return (
      <svg
        role="img"
        aria-label="Athlya"
        viewBox="0 0 100 100"
        height={height}
        className={className}
      >
        <defs>{mask}</defs>
        <Mascot color={color} band={bandColor} maskId={maskId} />
      </svg>
    );
  }
  return (
    <svg
      role="img"
      aria-label="Athlya"
      viewBox="0 0 543.4 97.0"
      height={height}
      className={className}
    >
      <defs>{mask}</defs>
      <g transform="translate(0 -14.46) scale(1.1044)">
        <Mascot color={color} band={bandColor} maskId={maskId} />
      </g>
      <path transform="translate(118.70 16.14)" d={WORDMARK} fill={color} />
    </svg>
  );
}
