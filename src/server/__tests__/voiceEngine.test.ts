import fs from 'fs';
import os from 'os';
import path from 'path';
import { Run } from '../../run/store';
import { applyVoiceEngine } from '../routes';

describe('choosing the voice engine per run', () => {
  let root: string;
  const key = process.env.ELEVENLABS_API_KEY;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
    process.env.FOUNDRY_RUNS_DIR = root;
    process.env.ELEVENLABS_API_KEY = 'test-key';
  });
  afterEach(() => {
    delete process.env.FOUNDRY_RUNS_DIR;
    if (key === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = key;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const make = () =>
    Run.create({ personaId: 'eureka-tales', formatId: 'science-short', topic: 'Velcro' }, { root });

  it('defaults to GPT', () => {
    expect(make().manifest.voiceEngine).toBe('openai');
  });

  it('switching deletes the other engine beats so one episode never mixes voices', () => {
    const run = make();
    fs.writeFileSync(run.mediaPath('01-story.mp3'), 'gpt beat');
    fs.writeFileSync(run.mediaPath('02-close-p01.mp3'), 'gpt piece');
    fs.writeFileSync(run.mediaPath('cover.supplied.png'), 'art');

    applyVoiceEngine(run, { engine: 'elevenlabs' }, 'anant');

    const reopened = Run.open(run.id, { root });
    expect(reopened.manifest.voiceEngine).toBe('elevenlabs');
    expect(fs.readdirSync(path.join(run.dir, 'media'))).toEqual(['cover.supplied.png']);
  });

  it('the same engine again, or no engine, touches nothing', () => {
    const run = make();
    fs.writeFileSync(run.mediaPath('01-story.mp3'), 'gpt beat');
    applyVoiceEngine(run, { engine: 'openai' }, null);
    applyVoiceEngine(run, null, null);
    expect(fs.existsSync(run.mediaPath('01-story.mp3'))).toBe(true);
  });

  it('refuses ElevenLabs without a key, before deleting anything', () => {
    process.env.ELEVENLABS_API_KEY = '';
    const run = make();
    fs.writeFileSync(run.mediaPath('01-story.mp3'), 'gpt beat');
    expect(() => applyVoiceEngine(run, { engine: 'elevenlabs' }, null)).toThrow(/ELEVENLABS_API_KEY/);
    expect(fs.existsSync(run.mediaPath('01-story.mp3'))).toBe(true);
  });
});
