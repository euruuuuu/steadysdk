import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cp } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { generate } from '../src/generate.js';
import { PETSTORE_DIR } from './helpers.js';

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

type Route = (seen: Seen) => { status?: number; type?: string; body?: string; delayMs?: number };

/** End-to-end: the generated Petstore SDK talking to a real HTTP server. */
describe('generated runtime', () => {
  let server: Server;
  let baseUrl: string;
  let sdk: Record<string, any>;
  let route: Route = () => ({ status: 200, type: 'application/json', body: '{}' });
  const requests: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        requests.push(seen);
        const reply = route(seen);
        setTimeout(() => {
          res.statusCode = reply.status ?? 200;
          if (reply.type) res.setHeader('Content-Type', reply.type);
          res.end(reply.body ?? '');
        }, reply.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    // tempDir() cleans up per test, so generate into a directory that lives for the whole file.
    const dir = path.join(PETSTORE_DIR, '..', '..', 'node_modules', '.cache', 'apisteady-runtime-test');
    await cp(path.join(PETSTORE_DIR, 'openapi.yaml'), path.join(dir, 'openapi.yaml'));
    await cp(path.join(PETSTORE_DIR, '.apisteadyrc.yml'), path.join(dir, '.apisteadyrc.yml'));
    await generate({ config: await loadConfig({ cwd: dir }), force: true });
    sdk = await import(pathToFileURL(path.join(dir, 'sdk', 'index.ts')).href);
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const last = (): Seen => requests.at(-1)!;
  const client = (options: Record<string, unknown> = {}) => new sdk['PetstoreClient']({ baseUrl, ...options });

  it('sends query, header and auth parameters', async () => {
    route = () => ({ type: 'application/json', body: '[{"id":1,"name":"Rex"}]' });
    const pets = await client({ auth: { bearerAuth: async () => 'tok-123' } }).pets.listPets({
      limit: 10,
      status: ['available', 'pending'],
      xRequestID: 'req-1',
    });
    expect(pets).toEqual([{ id: 1, name: 'Rex' }]);
    expect(last().method).toBe('GET');
    expect(last().url).toBe('/v1/pets?limit=10&status=available%2Cpending');
    expect(last().headers['x-request-id']).toBe('req-1');
    expect(last().headers['authorization']).toBe('Bearer tok-123');
  });

  it('omits undefined query parameters', async () => {
    await client().pets.listPets();
    expect(last().url).toBe('/v1/pets');
  });

  it('encodes path parameters', async () => {
    route = () => ({ type: 'application/json', body: '{"id":"a/b","petId":1,"quantity":1}' });
    await client().store.getOrderByID({ orderID: 'a/b c' });
    expect(last().url).toBe('/v1/store/orders/a%2Fb%20c');
  });

  it('sends JSON bodies and parses JSON responses', async () => {
    route = (seen) => ({ status: 201, type: 'application/json', body: JSON.stringify({ id: 7, ...JSON.parse(seen.body) }) });
    const pet = await client().pets.createPet({ name: 'Rex', tag: 'dog' });
    expect(pet).toEqual({ id: 7, name: 'Rex', tag: 'dog' });
    expect(last().headers['content-type']).toBe('application/json');
  });

  it('sends multipart bodies with files', async () => {
    route = () => ({ type: 'application/json', body: '{"url":"https://x/y.png"}' });
    await client().pets.createPetPhoto({ petID: 3 }, { file: new Blob(['PNG']), caption: 'hi' });
    expect(last().headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(last().body).toContain('name="caption"');
    expect(last().body).toContain('PNG');
  });

  it('sends form bodies and reads text responses, without auth when the operation has none', async () => {
    route = () => ({ type: 'text/plain', body: 'session-token' });
    const token = await client({ auth: { bearerAuth: 'tok' } }).users.loginUsers({ username: 'ann', password: 'p w' });
    expect(token).toBe('session-token');
    expect(last().body).toBe('username=ann&password=p+w');
    expect(last().headers['authorization']).toBeUndefined();
  });

  it('applies API key auth where the operation requires it', async () => {
    route = () => ({ type: 'application/json', body: '{"available":3}' });
    expect(await client({ auth: { apiKey: 'k-1' } }).store.getInventory()).toEqual({ available: 3 });
    expect(last().headers['x-api-key']).toBe('k-1');
  });

  it('returns undefined for 204 responses', async () => {
    route = () => ({ status: 204 });
    expect(await client().pets.deletePet({ petID: 1 })).toBeUndefined();
    expect(last().method).toBe('DELETE');
  });

  it('throws ApiError with status and parsed body for error responses', async () => {
    route = () => ({ status: 404, type: 'application/json', body: '{"code":404,"message":"nope"}' });
    const error = await client().pets.getPet({ petID: 9 }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(sdk['ApiError']);
    expect(error).toMatchObject({ status: 404, body: { code: 404, message: 'nope' }, method: 'GET' });
  });

  it('times out slow requests', async () => {
    route = () => ({ delayMs: 200, type: 'application/json', body: '{}' });
    await expect(client({ timeoutMs: 20 }).healthCheck()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('honours caller abort signals', async () => {
    route = () => ({ delayMs: 200, type: 'application/json', body: '{}' });
    const controller = new AbortController();
    const pending = client().healthCheck({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('merges default, per-request and hook-provided headers', async () => {
    route = () => ({ type: 'application/json', body: '{"status":"ok"}' });
    const seen: string[] = [];
    await client({
      headers: { 'X-App': 'demo', 'X-Over': 'default' },
      onRequest: (request: Request) => {
        seen.push(request.url);
      },
    }).healthCheck({ headers: { 'X-Over': 'call' } });
    expect(last().headers['x-app']).toBe('demo');
    expect(last().headers['x-over']).toBe('call');
    expect(seen).toEqual([`${baseUrl}/health`]);
  });

  it('can be extended in user code (the scaffolded subclass)', async () => {
    route = () => ({ type: 'application/json', body: '{"status":"ok"}' });
    const Base: new (options: object) => { healthCheck(): Promise<{ status: string }> } = sdk['PetstoreClient'];
    class MyClient extends Base {
      async isHealthy(): Promise<boolean> {
        return (await this.healthCheck()).status === 'ok';
      }
    }
    expect(await new MyClient({ baseUrl }).isHealthy()).toBe(true);
  });

  it('explains a missing base URL', async () => {
    const http = new sdk['HttpClient']({});
    await expect(http.request({ method: 'GET', path: '/x' })).rejects.toThrow(/No baseUrl configured/);
  });
});
