/**
 * Global ambient declaration for Cloudflare Turnstile's client runtime.
 *
 * The `<script src="…/turnstile/v0/api.js">` payload attaches a single
 * `turnstile` object to `window`. We consume three members —
 * `render`, `reset`, and `remove` — so the surface declared here stays minimal.
 * Full typings live in `@cloudflare/turnstile-types` but adding the
 * package for three functions is overkill at this stage.
 *
 * @see https://developers.cloudflare.com/turnstile/reference/client-side-rendering/
 */
export { };

declare global {
    interface TurnstileRenderOptions {
        readonly sitekey: string;
        readonly callback?: (token: string) => void;
        readonly 'error-callback'?: () => void;
        readonly 'expired-callback'?: () => void;
        readonly 'timeout-callback'?: () => void;
        readonly 'before-interactive-callback'?: () => void;
        readonly 'refresh-expired'?: 'auto' | 'manual' | 'never';
        readonly theme?: 'light' | 'dark' | 'auto';
        readonly action?: string;
    }

    interface TurnstileGlobal {
        render(
            element: HTMLElement | string,
            options: TurnstileRenderOptions,
        ): string | undefined;
        reset(widgetId?: string): void;
        remove(widgetId?: string): void;
    }


    interface Window {
        turnstile?: TurnstileGlobal;
    }
}
