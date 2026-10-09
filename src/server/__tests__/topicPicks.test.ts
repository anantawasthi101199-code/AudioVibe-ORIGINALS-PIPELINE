/** Suggestions kept for next time; removed topics stay removed (owner, 2026-10-09). */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isHidden, keepSuggestions, picksFor, removeTopic, topicUsed } from '../topicPicks';
import { getChannel, removeChannelTopic } from '../routes';
import { loadTopics } from '../../schedule/load';

describe('kept suggestions', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'picks-'));
    process.env.FOUNDRY_RUNS_DIR = root;
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps every suggestion per channel and format, newest first, without duplicates', () => {
    keepSuggestions('business-decoded', 'biz-short', [{ topic: 'How Lego nearly died', why: 'w' }], 'anant');
    const list = keepSuggestions('business-decoded', 'biz-short', [
      { topic: 'How Nike began', why: 'w' },
      { topic: 'how lego nearly  died', why: 'same one' },
    ], 'devesh');
    expect(list.map((s) => s.topic)).toEqual(['How Nike began', 'How Lego nearly died']);
    expect(picksFor('business-decoded').saved['biz-episode']).toBeUndefined();
    expect(getChannel('business-decoded').savedSuggestions['biz-short']).toHaveLength(2);
  });

  it('a removed suggestion is gone for good and never kept again', () => {
    keepSuggestions('business-decoded', 'biz-short', [{ topic: 'How Nike began', why: 'w' }], null);
    removeChannelTopic('business-decoded', { topic: 'How Nike began' });
    expect(picksFor('business-decoded').saved['biz-short']).toEqual([]);
    expect(keepSuggestions('business-decoded', 'biz-short', [{ topic: 'How Nike began', why: 'again' }], null)).toEqual([]);
  });

  it('a removed topic-queue pill is hidden from the channel page', () => {
    const first = loadTopics('business-decoded').topics[0]!;
    expect(getChannel('business-decoded').topics).toContain(first);
    removeTopic('business-decoded', first);
    expect(isHidden('business-decoded', first)).toBe(true);
    expect(getChannel('business-decoded').topics).not.toContain(first);
  });

  it('a topic a run was started on leaves the kept list', () => {
    keepSuggestions('business-decoded', 'biz-short', [{ topic: 'How Nike began', why: 'w' }], null);
    topicUsed('business-decoded', 'How Nike began');
    expect(picksFor('business-decoded').saved['biz-short']).toEqual([]);
    expect(isHidden('business-decoded', 'How Nike began')).toBe(false);
  });
});
