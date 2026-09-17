import { describe, expect, it } from 'vitest';

import webConfig from '../apps/web/vite.config.ts';

describe('web development proxy', () => {
  it('proxies root API routes when they include query parameters', () => {
    const [routePattern] = Object.keys(webConfig.server.proxy);
    const route = new RegExp(routePattern, 'u');

    expect(route.test('/candidates')).toBe(true);
    expect(route.test('/candidates?hardFilterStatus=pass&limit=50')).toBe(true);
    expect(route.test('/candidates/candidate-id')).toBe(true);
    expect(route.test('/candidate-search')).toBe(false);
  });
});
