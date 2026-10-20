/**
 * Public landing page.
 *
 * A Server Component: it resolves the locale via `getLocale()` and renders
 * every section on the server. The only client pieces are `<HomeActions />`,
 * which reads the in-memory auth state (signed-out visitors see register and
 * sign in, signed-in members see their links), and `<TaglineReveal />`.
 *
 * The page is always dark, whatever the theme: `.landing-dark`
 * (`globals.css`) points the semantic colours at the shared dark tokens
 * inside `<main>`, and the public top bar applies the same class on `/`.
 *
 * Every string flows through `createTranslator(locale)` (`web.home.*`).
 * Product facts only: no price, customer logo, testimonial or figure that
 * the product cannot back up.
 *
 * @see Req 25.3: served under the strict per-request CSP (no inline style).
 * @see Req 28.1: strings read from `@athlya/shared/i18n`, not inlined.
 */
import { ArrowUpRightIcon, CheckIcon } from '@phosphor-icons/react/dist/ssr';
import Link from 'next/link';

import { cn } from '@/lib/utils';

import { AthlyaLogo } from '../components/AthlyaLogo';
import { LandingPhoto, type PhotoSource } from '../components/landing/LandingPhoto';
import { LANDING_CONTAINER, LANDING_EYEBROW, LANDING_HEADING } from '../components/landing/layout';
import { PlanningPreview } from '../components/landing/PlanningPreview';
import { TaglineReveal } from '../components/landing/TaglineReveal';
import { getLocale } from '../lib/i18n/getLocale';
import { createTranslator, type Translator } from '../lib/i18n/t';

import { HomeActions } from './HomeActions';

import type { Metadata } from 'next';
import type { ReactElement } from 'react';

export const metadata: Metadata = {
  title: 'Réservez vos cours de fitness',
  alternates: { canonical: '/' },
};

const SOURCE_URL = 'https://github.com/GlamgarOnDiscord/athlya';

const HERO_TALL: PhotoSource = { name: 'hero-run-tall', widths: [640, 960], ratio: 4 / 5 };
const HERO_WIDE: PhotoSource = { name: 'hero-run-wide', widths: [960, 1600], ratio: 2 };

const DISCIPLINES = [
  { key: 'combat', name: 'discipline-combat' },
  { key: 'strength', name: 'discipline-strength' },
  { key: 'cardio', name: 'discipline-cardio' },
  { key: 'mobility', name: 'discipline-mobility' },
] as const;

const STEPS = ['1', '2', '3'] as const;

const FEATURES = ['waitlist', 'checkin', 'programs', 'coach', 'health'] as const;

const TRUST = ['export', 'deletion', 'trackers', 'openSource'] as const;

const SECTION = 'py-20 sm:py-24 lg:py-32';

function NextClassCard({ t }: { readonly t: Translator }): ReactElement {
  return (
    <div
      aria-hidden="true"
      className="absolute inset-x-3 bottom-3 rounded-xl border border-border bg-background p-4 select-none sm:inset-x-auto sm:right-6 sm:bottom-6 sm:w-80"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground">{t('web.home.nextClass.label')}</span>
        <span className="rounded-sm bg-primary px-1.5 py-0.5 text-xs font-semibold text-primary-foreground tabular-nums">
          {t('web.home.nextClass.eta')}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{t('web.home.nextClass.name')}</p>
          <p className="truncate text-xs text-muted-foreground tabular-nums">
            {t('web.home.nextClass.meta')}
          </p>
        </div>
        <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium">
          <CheckIcon weight="bold" className="size-3" />
          {t('web.home.nextClass.booked')}
        </span>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-[81.25%] rounded-full bg-foreground" />
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('web.home.nextClass.spots')}
        </span>
      </div>
    </div>
  );
}

function Hero({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-hero" className="pt-12 sm:pt-16 lg:pt-24">
      <div className={LANDING_CONTAINER}>
        <p className={LANDING_EYEBROW}>{t('web.home.hero.eyebrow')}</p>
        <div className="mt-6 grid gap-10 lg:grid-cols-12 lg:items-end lg:gap-12">
          <h1
            id="landing-hero"
            className="text-5xl leading-none font-semibold tracking-tighter text-balance sm:text-7xl lg:col-span-7 xl:text-8xl"
          >
            <span className="block">{t('web.home.hero.titleLine1')}</span>
            <span className="block">{t('web.home.hero.titleLine2')}</span>
          </h1>
          <div className="lg:col-span-5 lg:pb-2">
            <p className="max-w-md text-lg text-pretty text-muted-foreground">
              {t('web.home.hero.lead')}
            </p>
            <HomeActions className="mt-8" />
            <p className="mt-6 max-w-md text-sm text-pretty text-muted-foreground">
              {t('web.home.hero.proof')}
            </p>
          </div>
        </div>
        <figure className="relative mt-12 aspect-[4/5] overflow-hidden rounded-2xl bg-muted sm:mt-16 md:aspect-[2/1]">
          <LandingPhoto
            source={HERO_TALL}
            wideSource={HERO_WIDE}
            alt={t('web.home.hero.photoAlt')}
            sizes="(min-width: 1280px) 1216px, (min-width: 640px) calc(100vw - 48px), calc(100vw - 32px)"
            priority
          />
          <NextClassCard t={t} />
        </figure>
      </div>
    </section>
  );
}

function StepList({
  group,
  t,
}: {
  readonly group: 'members' | 'studios';
  readonly t: Translator;
}): ReactElement {
  return (
    <div>
      <h3 className="text-xl font-semibold">{t(`web.home.how.${group}.title`)}</h3>
      <ol className="mt-6">
        {STEPS.map((step) => (
          <li
            key={step}
            className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-x-4 border-t border-border py-6"
          >
            <span className="pt-1 text-sm text-muted-foreground tabular-nums">0{step}</span>
            <div>
              <h4 className="text-lg font-semibold">
                {t(`web.home.how.${group}.step${step}Title`)}
              </h4>
              <p className="mt-2 max-w-prose text-base text-pretty text-muted-foreground">
                {t(`web.home.how.${group}.step${step}Body`)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function HowItWorks({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-how" className={SECTION}>
      <div className={LANDING_CONTAINER}>
        <p className={LANDING_EYEBROW}>{t('web.home.how.eyebrow')}</p>
        <h2 id="landing-how" className={cn(LANDING_HEADING, 'mt-4 max-w-3xl')}>
          {t('web.home.how.title')}
        </h2>
        <div className="mt-12 grid gap-12 lg:mt-16 lg:grid-cols-2 lg:gap-16">
          <StepList group="members" t={t} />
          <StepList group="studios" t={t} />
        </div>
      </div>
    </section>
  );
}

function Disciplines({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-disciplines" className="pb-20 sm:pb-24 lg:pb-32">
      <div className={LANDING_CONTAINER}>
        <h2 id="landing-disciplines" className={cn(LANDING_HEADING, 'max-w-3xl')}>
          {t('web.home.disciplines.title')}
        </h2>
        <ul className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4 lg:mt-12">
          {DISCIPLINES.map(({ key, name }) => (
            <li key={key}>
              <figure>
                <div className="aspect-[3/4] overflow-hidden rounded-xl bg-muted">
                  <LandingPhoto
                    source={{ name, widths: [480, 720], ratio: 3 / 4 }}
                    alt={t(`web.home.disciplines.${key}Alt`)}
                    sizes="(min-width: 1280px) 296px, (min-width: 768px) 25vw, 50vw"
                  />
                </div>
                <figcaption className="mt-3 text-base font-semibold">
                  {t(`web.home.disciplines.${key}`)}
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Product({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-product" className={cn(SECTION, 'border-t border-border')}>
      <div className={LANDING_CONTAINER}>
        <p className={LANDING_EYEBROW}>{t('web.home.product.eyebrow')}</p>
        <div className="mt-4 grid gap-6 lg:grid-cols-12 lg:items-end lg:gap-12">
          <h2 id="landing-product" className={cn(LANDING_HEADING, 'lg:col-span-7')}>
            {t('web.home.product.title')}
          </h2>
          <p className="max-w-md text-lg text-pretty text-muted-foreground lg:col-span-5">
            {t('web.home.product.body')}
          </p>
        </div>
        <figure className="mt-12 lg:mt-16">
          <PlanningPreview t={t} />
          <figcaption className="mt-4 text-sm text-muted-foreground">
            {t('web.home.product.caption')}
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function Features({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-features" className={cn(SECTION, 'pt-0 sm:pt-0 lg:pt-0')}>
      <div className={LANDING_CONTAINER}>
        <p className={LANDING_EYEBROW}>{t('web.home.features.eyebrow')}</p>
        <h2 id="landing-features" className={cn(LANDING_HEADING, 'mt-4')}>
          {t('web.home.features.title')}
        </h2>
        <dl className="mt-12 grid gap-x-8 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <div key={feature} className="border-t border-border pt-6 pb-10">
              <dt className="text-base font-semibold">{t(`web.home.features.${feature}Title`)}</dt>
              <dd className="mt-2 max-w-xs text-base text-pretty text-muted-foreground">
                {t(`web.home.features.${feature}Body`)}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function Trust({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-trust" className={cn(SECTION, 'border-t border-border')}>
      <div className={LANDING_CONTAINER}>
        <p className={LANDING_EYEBROW}>{t('web.home.trust.eyebrow')}</p>
        <TaglineReveal
          id="landing-trust"
          text={t('web.home.trust.tagline')}
          className="mt-6 max-w-4xl text-4xl leading-tight font-semibold tracking-tighter text-balance sm:text-5xl lg:text-6xl"
        />
        <dl className="mt-16 grid gap-x-8 sm:grid-cols-2 lg:mt-24 lg:grid-cols-4">
          {TRUST.map((item) => (
            <div key={item} className="border-t border-border pt-6 pb-10">
              <dt className="text-base font-semibold">{t(`web.home.trust.${item}Title`)}</dt>
              <dd className="mt-2 text-base text-pretty text-muted-foreground">
                {t(`web.home.trust.${item}Body`)}
                {item === 'openSource' ? (
                  <a
                    href={SOURCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-4 flex w-fit items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('web.home.trust.sourceLink')}
                    <ArrowUpRightIcon aria-hidden="true" className="size-4" />
                  </a>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

function FinalCall({ t }: { readonly t: Translator }): ReactElement {
  return (
    <section aria-labelledby="landing-final" className={cn(SECTION, 'border-t border-border')}>
      <div className={cn(LANDING_CONTAINER, 'flex flex-col gap-10 lg:flex-row lg:items-end')}>
        <h2
          id="landing-final"
          className="text-5xl leading-none font-semibold tracking-tighter text-balance sm:text-7xl lg:flex-1 xl:text-8xl"
        >
          <span className="block">{t('web.home.final.titleStart')}</span>
          <span className="block text-primary">{t('web.home.final.titleAccent')}</span>
        </h2>
        <HomeActions className="lg:pb-3" />
      </div>
    </section>
  );
}

const FOOTER_LINKS = [
  { href: '/legal', key: 'legal' },
  { href: '/privacy', key: 'privacy' },
  { href: '/cookies', key: 'cookies' },
] as const;

const FOOTER_LINK =
  'rounded-sm text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring';

function LandingFooter({ t }: { readonly t: Translator }): ReactElement {
  return (
    <footer className="border-t border-border">
      <div
        className={cn(
          LANDING_CONTAINER,
          'flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between',
        )}
      >
        <div className="flex items-center gap-4">
          <AthlyaLogo height={24} className="text-foreground" />
          <span className="text-sm text-muted-foreground">
            {t('web.home.footer.rights', { year: new Date().getFullYear() })}
          </span>
        </div>
        <nav aria-label={t('web.home.footer.nav')}>
          <ul className="flex flex-wrap gap-x-6 gap-y-3">
            {FOOTER_LINKS.map(({ href, key }) => (
              <li key={key}>
                <Link href={href} className={FOOTER_LINK}>
                  {t(`web.home.footer.${key}`)}
                </Link>
              </li>
            ))}
            <li>
              <a
                href={SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className={FOOTER_LINK}
              >
                {t('web.home.footer.source')}
              </a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}

export default async function HomePage(): Promise<ReactElement> {
  const locale = await getLocale();
  const t = createTranslator(locale);

  return (
    <main id="main-content" className="landing-dark overflow-x-clip">
      <Hero t={t} />
      <HowItWorks t={t} />
      <Disciplines t={t} />
      <Product t={t} />
      <Features t={t} />
      <Trust t={t} />
      <FinalCall t={t} />
      <LandingFooter t={t} />
    </main>
  );
}
