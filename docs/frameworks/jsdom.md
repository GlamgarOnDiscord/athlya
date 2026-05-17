# jsdom — Framework Audit

## Version Status

|             | Value                                      |
| ----------- | ------------------------------------------ |
| **Used**    | ^26.0.0                                    |
| **Purpose** | DOM environment for Vitest (web app tests) |

## Configuration

In `apps/web/vitest.config.ts`:

```ts
test: {
  environment: 'jsdom';
}
```

Provides `window`, `document`, `crypto.getRandomValues`, `btoa`, `fetch` and other Web APIs for component tests and CSP/nonce unit tests.

## Assessment

jsdom 26.x is current. Provides sufficient Web API coverage for:

- React component rendering (via @testing-library/react)
- CSP string generation tests
- Nonce generation tests (crypto.getRandomValues)
- Cookie manipulation tests

## No Issues Detected

## Source

- https://github.com/jsdom/jsdom
