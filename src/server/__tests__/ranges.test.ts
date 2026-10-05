import fs from 'fs';
import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { createServer } from '../index';

/** Audio players start and seek with partial requests; the file server must answer them. */
describe('partial requests', () => {
  let server: http.Server;
  let base: string;
  beforeAll(async () => {
    process.env.FOUNDRY_ADMIN_PASSWORD = process.env.FOUNDRY_ADMIN_PASSWORD || 'test-password-long';
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const get = (range?: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
      http
        .get(`${base}/index.html`, { headers: range ? { range } : {} }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });

  // Needs the built interface to have a file to serve; a fresh clone skips it.
  const built = fs.existsSync(path.join(__dirname, '..', '..', '..', 'web', 'dist', 'index.html'));
  (built ? it : it.skip)('sends the bytes asked for, and says it can', async () => {
    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers['accept-ranges']).toBe('bytes');

    const part = await get('bytes=10-19');
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 10-19/${whole.body.length}`);
    expect(part.body.equals(whole.body.subarray(10, 20))).toBe(true);

    const fromStart = await get('bytes=0-');
    expect(fromStart.status).toBe(206);
    expect(fromStart.body.length).toBe(whole.body.length);

    expect((await get(`bytes=${whole.body.length + 5}-`)).status).toBe(416);
  });
});
