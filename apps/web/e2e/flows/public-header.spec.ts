/**
 * The signed-out top bar must fit a phone: no horizontal scroll on the
 * public pages at 320 and 390 px, and the language select stays on screen.
 */
import { expect, test } from '@playwright/test';

const publicPaths = ['/', '/login', '/register'] as const;

for (const width of [320, 390] as const) {
  for (const path of publicPaths) {
    test(`public header fits at ${String(width)}px on ${path}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.route('**/api/auth/refresh', async (route) => {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ title: 'Unauthorized', status: 401 }),
        });
      });
      await page.goto(path);
      const locale = page.getByRole('banner').getByLabel('Locale');
      await expect(locale).toBeAttached();

      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

      const box = await locale.boundingBox();
      expect(box).not.toBeNull();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(innerWidth);
    });
  }
}
