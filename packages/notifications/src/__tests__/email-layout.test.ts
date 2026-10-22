import { describe, expect, it } from 'vitest';

import { renderEmailHtml, renderEmailText, type EmailBranding } from '../email-layout.js';

const CONTENT = { subject: 'Réservation confirmée', body: 'Votre place est réservée.' };

const BRANDING: EmailBranding = {
  studioName: 'Studio <Rive> Gauche',
  brandColor: '#0f766e',
  logoUrl: 'https://assets.athlya.test/studio-logos/s/light?v=1',
  hideAthlyaBranding: false,
  emailDomain: null,
};

describe('renderEmailHtml', () => {
  it('paints the header in the brand color with the AA text color', () => {
    const html = renderEmailHtml(CONTENT, BRANDING, 'fr');
    expect(html).toContain('background:#0F766E');
    expect(html).toContain('<img src="https://assets.athlya.test/studio-logos/s/light?v=1"');
    expect(html).toContain('alt="Studio &lt;Rive&gt; Gauche"');
    expect(html).toContain('Envoyé par Studio &lt;Rive&gt; Gauche via Athlya.');
    expect(html).not.toContain('<Rive>');
  });

  it('pairs a light brand color with black text', () => {
    const html = renderEmailHtml(
      CONTENT,
      { ...BRANDING, brandColor: '#D7FF3A', logoUrl: null },
      'fr',
    );
    expect(html).toContain('background:#D7FF3A');
    expect(html).toContain('color:#000000');
  });

  it('falls back to the studio name when the logo is a data URL', () => {
    const html = renderEmailHtml(
      CONTENT,
      { ...BRANDING, logoUrl: 'data:image/png;base64,iVBORw0KGgo=' },
      'en',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('Studio &lt;Rive&gt; Gauche</span>');
    expect(html).toContain('<html lang="en">');
  });

  it('drops the Athlya mention when the studio hides it', () => {
    const html = renderEmailHtml(CONTENT, { ...BRANDING, hideAthlyaBranding: true }, 'en');
    expect(html).toContain('Sent by Studio &lt;Rive&gt; Gauche.');
    expect(html).not.toContain('Athlya');
  });

  it('keeps the Athlya identity without branding', () => {
    const html = renderEmailHtml(CONTENT, null, 'fr');
    expect(html).toContain('background:#0A0A0A');
    expect(html).toContain('Envoyé par Athlya.');
  });

  it('escapes the body', () => {
    const html = renderEmailHtml({ subject: 'S', body: 'a <b>&</b>' }, null, 'fr');
    expect(html).toContain('a &lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('renderEmailText', () => {
  it('appends the footer to the plain text body', () => {
    expect(renderEmailText(CONTENT, { ...BRANDING, hideAthlyaBranding: true }, 'fr')).toBe(
      'Votre place est réservée.\n\n--\nEnvoyé par Studio <Rive> Gauche.',
    );
  });
});
