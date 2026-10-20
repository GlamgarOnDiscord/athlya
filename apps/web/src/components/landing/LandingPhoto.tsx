/**
 * Landing photographs, served as pre-sized WebP files from
 * `public/images/landing/` (sources and licence: `docs/third-party-ui.md`).
 *
 * A plain `<img>` with `srcSet` rather than `next/image`: `next/image`
 * renders an inline `style` attribute on the server, which the strict CSP
 * rule of `docs/design/ui-direction.md` excludes, and the Workers
 * deployment has no image optimisation binding. The files are already
 * resized and compressed, so the browser only has to pick a width.
 */
import { cn } from '@/lib/utils';

import type { ReactElement } from 'react';

const BASE = '/images/landing';

export interface PhotoSource {
  /** File stem in `public/images/landing/`, e.g. `discipline-combat`. */
  readonly name: string;
  /** Widths generated for that stem, ascending. */
  readonly widths: readonly number[];
  /** Intrinsic aspect ratio as width / height, used for the width and height attributes. */
  readonly ratio: number;
}

function srcSet({ name, widths }: PhotoSource): string {
  return widths.map((w) => `${BASE}/${name}-${w}.webp ${w}w`).join(', ');
}

function largest({ name, widths }: PhotoSource): string {
  return `${BASE}/${name}-${widths[widths.length - 1]}.webp`;
}

interface LandingPhotoProps {
  readonly source: PhotoSource;
  /** Replaces `source` from the `md` breakpoint (art direction). */
  readonly wideSource?: PhotoSource;
  readonly alt: string;
  readonly sizes: string;
  /** The largest contentful paint candidate: eager, high fetch priority. */
  readonly priority?: boolean;
  readonly className?: string;
}

export function LandingPhoto({
  source,
  wideSource,
  alt,
  sizes,
  priority = false,
  className,
}: LandingPhotoProps): ReactElement {
  const width = source.widths[source.widths.length - 1] ?? 0;
  const image = (
    // eslint-disable-next-line @next/next/no-img-element -- see the file header: next/image emits an inline style under the strict CSP.
    <img
      src={largest(source)}
      srcSet={srcSet(source)}
      sizes={sizes}
      width={width}
      height={Math.round(width / source.ratio)}
      alt={alt}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding={priority ? 'sync' : 'async'}
      className={cn('size-full object-cover', className)}
    />
  );
  if (wideSource === undefined) return image;
  const wideWidth = wideSource.widths[wideSource.widths.length - 1] ?? 0;
  return (
    <picture>
      <source
        media="(min-width: 768px)"
        srcSet={srcSet(wideSource)}
        sizes={sizes}
        width={wideWidth}
        height={Math.round(wideWidth / wideSource.ratio)}
      />
      {image}
    </picture>
  );
}
