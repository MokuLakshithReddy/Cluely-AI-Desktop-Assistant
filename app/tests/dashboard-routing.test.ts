import { describe, it, expect } from 'vitest';
import { parseHashRoute } from '../src/App';

describe('Dashboard Route and Hash Parsing', () => {
  it('parses empty or missing hash as default "all" view', () => {
    expect(parseHashRoute('')).toEqual({ route: 'all', tab: undefined });
    expect(parseHashRoute('#')).toEqual({ route: 'all', tab: undefined });
    expect(parseHashRoute('#/')).toEqual({ route: 'all', tab: undefined });
  });

  it('parses direct routes without query parameters', () => {
    expect(parseHashRoute('#control')).toEqual({ route: 'control', tab: undefined });
    expect(parseHashRoute('#chat')).toEqual({ route: 'chat', tab: undefined });
    expect(parseHashRoute('#dashboard')).toEqual({ route: 'dashboard', tab: undefined });
    expect(parseHashRoute('#/dashboard')).toEqual({ route: 'dashboard', tab: undefined });
  });

  it('correctly extracts route and tab query parameters from complex hashes', () => {
    expect(parseHashRoute('#dashboard?tab=models')).toEqual({
      route: 'dashboard',
      tab: 'models',
    });

    expect(parseHashRoute('#dashboard?tab=shortcuts')).toEqual({
      route: 'dashboard',
      tab: 'shortcuts',
    });

    expect(parseHashRoute('#dashboard?tab=history')).toEqual({
      route: 'dashboard',
      tab: 'history',
    });

    expect(parseHashRoute('#dashboard?tab=desktop')).toEqual({
      route: 'dashboard',
      tab: 'desktop',
    });
  });

  it('handles leading slash with query parameters', () => {
    expect(parseHashRoute('#/dashboard?tab=knowledge')).toEqual({
      route: 'dashboard',
      tab: 'knowledge',
    });
  });
});
