/**
 * Display heading whose words turn from a muted tone to full white, in
 * reading order, as the heading travels up the viewport.
 *
 * The server renders every word at full colour. On the client, and only
 * when the visitor has not asked for reduced motion, the heading is
 * "armed" (`data-armed`) and each word is marked `data-read` once the
 * scroll progress reaches it; the colours live in `globals.css`
 * (`.landing-word`). The muted tone keeps 3:1 or more on ink at this
 * size, so the text stays readable before it is lit. Scroll work is
 * limited to one `requestAnimationFrame` per frame and only while an
 * `IntersectionObserver` reports the heading on screen.
 */
'use client';

import { Fragment, useEffect, useRef, type ReactElement } from 'react';

interface TaglineRevealProps {
  readonly id: string;
  readonly text: string;
  readonly className?: string;
}

/** Progress is 0 when the heading top reaches this share of the viewport height... */
const START = 0.9;
/** ...and 1 when the heading bottom reaches this one. */
const END = 0.5;

export function TaglineReveal({ id, text, className }: TaglineRevealProps): ReactElement {
  const ref = useRef<HTMLHeadingElement>(null);
  const words = text.split(' ');

  useEffect(() => {
    const heading = ref.current;
    if (heading === null) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const spans = Array.from(heading.querySelectorAll<HTMLElement>('.landing-word'));
    let frame = 0;

    const update = (): void => {
      frame = 0;
      const rect = heading.getBoundingClientRect();
      const viewport = window.innerHeight;
      const travel = viewport * (START - END) + rect.height;
      const progress = Math.min(Math.max((viewport * START - rect.top) / travel, 0), 1);
      const read = Math.round(progress * spans.length);
      spans.forEach((span, index) => {
        span.toggleAttribute('data-read', index < read);
      });
    };
    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };

    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting === true) {
        window.addEventListener('scroll', onScroll, { passive: true });
      } else {
        window.removeEventListener('scroll', onScroll);
      }
      update();
    });

    heading.setAttribute('data-armed', '');
    update();
    observer.observe(heading);

    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
      heading.removeAttribute('data-armed');
    };
  }, [text]);

  return (
    <h2 ref={ref} id={id} className={className}>
      {words.map((word, index) => (
        <Fragment key={`${index.toString()}-${word}`}>
          <span className="landing-word">{word}</span>
          {index < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </h2>
  );
}
