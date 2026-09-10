/**
 * The registry is a pointer at something live, and every failure mode here is
 * silent. Series creation is not idempotent and there is no create-or-get, so a
 * lost or overwritten id forks a show into two shelves that both look entirely
 * correct in isolation and are only noticed by a listener.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SeriesRegistryError,
  environmentKey,
  findSeries,
  loadRegistry,
  recordSeries,
} from '../seriesRegistry';

const record = (over: Record<string, string> = {}) => ({
  seriesId: 'series-1',
  title: 'Night Shift',
  apiUrl: 'https://staging.example.com',
  createdAt: '2026-09-10T00:00:00.000Z',
  ...over,
});

describe('environmentKey', () => {
  it('keys on the host, so a trailing slash does not fork a show', () => {
    // Two entries for one environment means the second publish finds nothing,
    // creates a second series, and the show now has two shelves.
    expect(environmentKey('https://api.audiovibe.co/')).toBe(
      environmentKey('https://api.audiovibe.co')
    );
  });

  it('separates staging from production', () => {
    // A single-keyed file would publish production episodes into whichever
    // shelf was written last, which is the sort of thing you find out from a
    // listener rather than from a log.
    expect(environmentKey('https://api.audiovibe.co')).not.toBe(
      environmentKey('https://staging.audiovibe.co')
    );
  });

  it('does not throw on a malformed url', () => {
    // A bad url is a config problem that fails loudly at the first request.
    // This function being total keeps it from being where that surfaces.
    expect(() => environmentKey('not a url')).not.toThrow();
  });
});

describe('the registry', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-series-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is empty before any show has a series', () => {
    expect(loadRegistry(dir)).toEqual({});
    expect(findSeries('night-shift', 'https://x.example.com', dir)).toBeNull();
  });

  it('round-trips a record', () => {
    recordSeries('night-shift', record(), dir);
    expect(findSeries('night-shift', 'https://staging.example.com', dir)?.seriesId).toBe(
      'series-1'
    );
  });

  it('keeps staging and production apart', () => {
    recordSeries('night-shift', record(), dir);
    recordSeries(
      'night-shift',
      record({ seriesId: 'series-2', apiUrl: 'https://api.audiovibe.co' }),
      dir
    );

    expect(findSeries('night-shift', 'https://staging.example.com', dir)?.seriesId).toBe(
      'series-1'
    );
    expect(findSeries('night-shift', 'https://api.audiovibe.co', dir)?.seriesId).toBe('series-2');
  });

  it('keeps shows apart', () => {
    recordSeries('night-shift', record(), dir);
    recordSeries('other-show', record({ seriesId: 'series-9' }), dir);

    expect(findSeries('night-shift', 'https://staging.example.com', dir)?.seriesId).toBe(
      'series-1'
    );
    expect(findSeries('other-show', 'https://staging.example.com', dir)?.seriesId).toBe('series-9');
  });

  it('REFUSES to record a different series over an existing one', () => {
    // The refusal is the point. An overwrite orphans every episode already
    // published into the old shelf: they stay on the platform, still numbered,
    // attached to a series nothing here points at any more.
    recordSeries('night-shift', record(), dir);

    expect(() => recordSeries('night-shift', record({ seriesId: 'series-2' }), dir)).toThrow(
      SeriesRegistryError
    );
  });

  it('accepts recording the same series again', () => {
    // Idempotent for the id it already has, so a re-run of setup is harmless.
    recordSeries('night-shift', record(), dir);
    expect(() => recordSeries('night-shift', record(), dir)).not.toThrow();
  });

  it('THROWS on an unreadable registry rather than starting an empty one', () => {
    // Treating it as empty would create a second series for every show on the
    // next publish, and nothing about the result would look wrong until
    // somebody noticed the catalogue had two of each.
    fs.writeFileSync(path.join(dir, 'series.json'), '{ not json');
    expect(() => loadRegistry(dir)).toThrow(SeriesRegistryError);
  });

  it('THROWS on a registry whose shape has drifted', () => {
    fs.writeFileSync(path.join(dir, 'series.json'), '{"night-shift": {"host": {"seriesId": 7}}}');
    expect(() => loadRegistry(dir)).toThrow(SeriesRegistryError);
  });
});
