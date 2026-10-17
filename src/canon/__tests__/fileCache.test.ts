import fs from 'fs';
import os from 'os';
import path from 'path';
import { cachedByFiles } from '../fileCache';

describe('a parsed file kept between reads', () => {
  it('parses once, sees an edit, and hands out copies', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cache-')), 'a.txt');
    fs.writeFileSync(file, 'one');
    let parses = 0;
    const read = () => cachedByFiles(`t:${file}`, [file], () => (parses++, { text: fs.readFileSync(file, 'utf8') }));

    read().text = 'changed by a caller';
    expect(read().text).toBe('one');
    expect(parses).toBe(1);

    fs.writeFileSync(file, 'two!');
    expect(read().text).toBe('two!');
    expect(parses).toBe(2);
  });
});
