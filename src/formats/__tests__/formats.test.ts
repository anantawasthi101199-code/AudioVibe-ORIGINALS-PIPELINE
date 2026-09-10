/**
 * Beat sheets are hand-edited content, so what is pinned here is the arithmetic
 * a person gets wrong: a tension curve that has drifted out of step with the
 * beats, duplicate ids, and beats that cannot add up to the episode length.
 *
 * Plus one rule that is not arithmetic at all: every shipped format must carry
 * a required counterpoint beat.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { minClaimsFor, nominalSeconds } from '../schema';
import { FormatLoadError, loadAllFormats, loadFormat, parseFormat } from '../load';

const MINIMAL = `
id: tiny
name: Tiny
kind: long
intent: A format for testing.
targetSeconds: [30, 60]
beats:
  - id: cold_open
    type: cold_open
    seconds: [8, 14]
    function: Open.
  - id: payoff
    type: payoff
    seconds: [20, 40]
    function: Land.
tensionCurve: [0.9, 1.0]
`;

describe('parseFormat', () => {
  it('parses a minimal format and applies defaults', () => {
    const f = parseFormat(MINIMAL);
    expect(f.beats).toHaveLength(2);
    expect(f.beats[0]!.constraints).toEqual([]);
    expect(f.beats[0]!.minClaims).toBe(0);
    expect(f.beats[0]!.optional).toBe(false);
  });

  it('rejects a tension curve that is out of step with the beats', () => {
    // The easiest thing to get wrong by hand: add a beat, forget the curve.
    expect(() => parseFormat(MINIMAL.replace('tensionCurve: [0.9, 1.0]', 'tensionCurve: [0.9]')))
      .toThrow(/tensionCurve.*1 entries but there are 2 beats/s);
  });

  it('rejects duplicate beat ids', () => {
    // Beat ids end up in the beat map sent to the platform, where a duplicate
    // makes retention attribution ambiguous.
    expect(() => parseFormat(MINIMAL.replace('id: payoff', 'id: cold_open'))).toThrow(
      /duplicate beat ids: cold_open/
    );
  });

  it('rejects beats that cannot reach the target length', () => {
    // Otherwise the format silently produces short episodes, discovered at
    // render time rather than here.
    expect(() => parseFormat(MINIMAL.replace('targetSeconds: [30, 60]', 'targetSeconds: [600, 720]')))
      .toThrow(/cannot reach the target/);
  });

  it('rejects beats whose minimum already overshoots the target', () => {
    expect(() => parseFormat(MINIMAL.replace('targetSeconds: [30, 60]', 'targetSeconds: [5, 10]')))
      .toThrow(/cannot reach the target/);
  });

  it('requires at least two beats', () => {
    expect(() =>
      parseFormat(`
id: one
name: One
kind: long
intent: x
targetSeconds: [10, 20]
beats:
  - id: only
    type: payoff
    seconds: [10, 20]
    function: x
tensionCurve: [1.0]
`)
    ).toThrow(FormatLoadError);
  });

  it('rejects a beat type outside the closed set', () => {
    // Stage 9 aggregates retention across shows by beat type, so a free-text
    // label would make "cold opens over twelve seconds cost 22 percent"
    // unanswerable.
    expect(() => parseFormat(MINIMAL.replace('type: payoff', 'type: vibes'))).toThrow(
      FormatLoadError
    );
  });

  it('rejects a tension value outside 0..1', () => {
    expect(() => parseFormat(MINIMAL.replace('[0.9, 1.0]', '[0.9, 1.4]'))).toThrow(FormatLoadError);
  });
});

describe('derived numbers', () => {
  it('sums the claim floor across beats', () => {
    const f = parseFormat(MINIMAL.replace('function: Land.', 'function: Land.\n    minClaims: 3'));
    expect(minClaimsFor(f)).toBe(3);
  });

  it('takes the midpoint for budgeting', () => {
    expect(nominalSeconds(parseFormat(MINIMAL))).toBe(45);
  });
});

describe('loadFormat', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-formats-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads by id', () => {
    fs.writeFileSync(path.join(dir, 'tiny.yaml'), MINIMAL);
    expect(loadFormat('tiny', dir).name).toBe('Tiny');
  });

  it('refuses when the id and the filename disagree', () => {
    fs.writeFileSync(path.join(dir, 'other.yaml'), MINIMAL);
    expect(() => loadFormat('other', dir)).toThrow(/is named/);
  });

  it('explains a missing beat sheet', () => {
    expect(() => loadFormat('absent', dir)).toThrow(FormatLoadError);
  });
});

describe('the shipped formats', () => {
  const shipped = loadAllFormats();

  it('all parse', () => {
    expect(shipped.length).toBeGreaterThan(0);
  });

  // A format that requires evidence is a format that makes claims about the
  // world, and that is what the counterpoint rule is actually about - not
  // length. A serial drama is a long format with no claim floors anywhere,
  // because it asserts nothing; demanding it steelman the other side of a
  // scene would be theatre.
  const evidenceBearing = shipped.filter((f) => f.kind === 'long' && minClaimsFor(f) > 0);
  const claimless = shipped.filter((f) => minClaimsFor(f) === 0);

  it.each(evidenceBearing.map((f) => [f.id, f] as const))(
    '%s carries a REQUIRED counterpoint beat',
    (_id, format) => {
      // The rule this repo cares about most. Confident one-sidedness is the
      // most common way generated content is false while every sentence is
      // sourced, and an optional beat is one that quietly stops appearing.
      const counterpoint = format.beats.find((b) => b.type === 'counterpoint');
      expect(counterpoint).toBeDefined();
      expect(counterpoint!.optional).toBe(false);
    }
  );

  it('has at least one evidence-bearing long format, so the rule above is not vacuous', () => {
    // Without this, deleting every claim floor in the repo would make the
    // counterpoint test pass by having nothing to run on.
    expect(evidenceBearing.length).toBeGreaterThan(0);
  });

  it.each(claimless.map((f) => [f.id, f] as const))(
    '%s makes no claims, and so carries no counterpoint either',
    (_id, format) => {
      // The other half of the bargain. A counterpoint beat in a format that
      // asserts nothing is a beat arguing against a story, which is not a
      // thing, and it would make the retention numbers for counterpoint beats
      // mean two different things at once.
      expect(format.beats.find((b) => b.type === 'counterpoint')).toBeUndefined();
    }
  );

  it.each(shipped.filter((f) => f.kind === 'short').map((f) => [f.id, f] as const))(
    '%s has no counterpoint beat, and therefore may carry no contested claim',
    (_id, format) => {
      // Seventy-five seconds cannot hold a steelmanned counterpoint, and
      // cramming one in produces a worse strawman than having none.
      //
      // So the principle is kept a different way rather than dropped: a short
      // may not make a CONTESTED claim at all. If a fact needs the other side
      // stating, it does not belong in a short - shorts carry established
      // specifics, not contested interpretations. The gate enforces it (see
      // qa/gate.ts), and this test pins the format side of the bargain.
      expect(format.beats.find((b) => b.type === 'counterpoint')).toBeUndefined();
    }
  );

  it.each(shipped.map((f) => [f.id, f] as const))(
    '%s puts its highest claim floor on the mechanism',
    (_id, format) => {
      // If some other beat demands more sourcing than the causal explanation
      // does, the format is decorating rather than explaining.
      const mechanism = format.beats.find((b) => b.type === 'mechanism');
      if (!mechanism) return;
      const heaviest = Math.max(...format.beats.map((b) => b.minClaims));
      expect(mechanism.minClaims).toBe(heaviest);
    }
  );

  it.each(shipped.map((f) => [f.id, f] as const))(
    '%s does not open at its own peak tension',
    (_id, format) => {
      // Opening hot and staying hot is what most generated audio does, and it
      // reads as hype. The open should earn attention that later beats spend.
      const peak = Math.max(...format.tensionCurve);
      expect(format.tensionCurve[0]).toBeLessThan(peak);
    }
  );
});
