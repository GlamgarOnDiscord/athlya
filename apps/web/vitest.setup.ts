/**
 * Vitest setup — polyfills jsdom does not provide.
 *
 * jsdom 26 does not implement the PointerEvent API. base-ui v1.x
 * Checkbox + a couple of other primitives reach into `PointerEvent`
 * inside their click handlers (see `useButton.js` →
 * `CheckboxRoot.js` `onClick`). Without a polyfill, any synthetic
 * click on a base-ui interactive element throws
 * `ReferenceError: PointerEvent is not defined` and the surrounding
 * test fails on what looks like a state-flip assertion.
 *
 * The polyfill below extends `MouseEvent` so the constructor accepts
 * the standard `PointerEventInit` payload and exposes the bare
 * minimum properties base-ui inspects (`pointerType`, `pointerId`,
 * `pressure`, `width`, `height`). This is the same shape Mozilla
 * documents for the API and matches what jsdom upstream is working
 * toward.
 *
 * @see https://github.com/jsdom/jsdom/issues/2527
 */
if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    public readonly pointerId: number;
    public readonly pointerType: string;
    public readonly pressure: number;
    public readonly tangentialPressure: number;
    public readonly width: number;
    public readonly height: number;
    public readonly tiltX: number;
    public readonly tiltY: number;
    public readonly twist: number;
    public readonly isPrimary: boolean;

    public constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? '';
      this.pressure = init.pressure ?? 0;
      this.tangentialPressure = init.tangentialPressure ?? 0;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.tiltX = init.tiltX ?? 0;
      this.tiltY = init.tiltY ?? 0;
      this.twist = init.twist ?? 0;
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  // Cast through `unknown` because the structural shape matches the
  // DOM `PointerEvent` interface but our polyfill class is not the
  // same nominal type lib.dom.d.ts declares.
  (globalThis as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    PointerEventPolyfill as unknown as typeof PointerEvent;
}
