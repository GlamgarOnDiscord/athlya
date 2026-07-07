import type { MetadataRoute } from 'next';

const BASE_URL = (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://athlya.app').replace(/\/$/, '');

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/me', '/me/', '/api', '/api/'],
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
