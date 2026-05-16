/**
 * Global ambient declaration for Cloudflare Turnstile's client runtime.
 * Mirror of `apps/web/src/types/turnstile.d.ts`.
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
