import { describe, expect, it } from 'vitest';

import { ApiError, ApiServerError } from './client';
import { failureCode, loadFailure } from './load-failure';

describe('loadFailure', () => {
  it('names a 403 and a 404, and folds everything else into an error', () => {
    expect(loadFailure(new ApiError('Forbidden', 403))).toBe('forbidden');
    expect(loadFailure(new ApiError('Not Found', 404))).toBe('notFound');
    expect(loadFailure(new ApiError('Unprocessable', 422))).toBe('error');
    expect(loadFailure(new ApiServerError('Bad Gateway', 502))).toBe('error');
    expect(loadFailure(new TypeError('Failed to fetch'))).toBe('error');
  });
});

describe('failureCode', () => {
  it('reads the problem code, or flags a rate limit', () => {
    const problem = { type: 'about:blank', title: 'x', status: 422, code: 'outside_window' };
    expect(failureCode(new ApiError('x', 422, problem))).toBe('outside_window');
    expect(failureCode(Object.assign(new Error('Rate limited'), { status: 429 }))).toBe(
      'rate_limited',
    );
    expect(failureCode(new Error('boom'))).toBeUndefined();
  });
});
