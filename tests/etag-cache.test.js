/**
 * Tests for ETagCache
 */
import { ETagCache } from '../src/figma-client.ts';
describe('ETagCache', () => {
    let cache;
    beforeEach(() => {
        cache = new ETagCache({ defaultTtlMs: 1000, maxSize: 10 });
    });
    describe('Basic operations', () => {
        it('stores and retrieves data with ETag', () => {
            const data = { name: 'test', value: 123 };
            const etag = 'abc123';
            cache.set('/files/key', data, etag);
            const result = cache.get('/files/key');
            expect(result).not.toBeNull();
            expect(result.data).toEqual(data);
            expect(result.etag).toBe(etag);
        });
        it('returns null for missing key', () => {
            const result = cache.get('/files/missing');
            expect(result).toBeNull();
        });
        it('differentiates by method', () => {
            cache.set('/files/key', { data: 'get' }, 'etag1', { method: 'GET' });
            cache.set('/files/key', { data: 'post' }, 'etag2', { method: 'POST' });
            const getResult = cache.get('/files/key', { method: 'GET' });
            const postResult = cache.get('/files/key', { method: 'POST' });
            expect(getResult.data).toEqual({ data: 'get' });
            expect(postResult.data).toEqual({ data: 'post' });
        });
        it('differentiates by body', () => {
            cache.set('/files/key/nodes', { ids: ['a'] }, 'etag1', {
                method: 'GET',
                body: { ids: ['a'] }
            });
            cache.set('/files/key/nodes', { ids: ['b'] }, 'etag2', {
                method: 'GET',
                body: { ids: ['b'] }
            });
            const resultA = cache.get('/files/key/nodes', {
                method: 'GET',
                body: { ids: ['a'] }
            });
            const resultB = cache.get('/files/key/nodes', {
                method: 'GET',
                body: { ids: ['b'] }
            });
            expect(resultA.data).toEqual({ ids: ['a'] });
            expect(resultB.data).toEqual({ ids: ['b'] });
        });
    });
    describe('TTL expiration', () => {
        it('expires entries after TTL', async () => {
            cache = new ETagCache({ defaultTtlMs: 100, maxSize: 10 });
            cache.set('/files/key', { data: 'test' }, 'etag1');
            expect(cache.get('/files/key')).not.toBeNull();
            await new Promise(r => setTimeout(r, 150));
            expect(cache.get('/files/key')).toBeNull();
        });
        it('has() returns false for expired entries', async () => {
            cache = new ETagCache({ defaultTtlMs: 100, maxSize: 10 });
            cache.set('/files/key', { data: 'test' }, 'etag1');
            expect(cache.has('/files/key')).toBe(true);
            await new Promise(r => setTimeout(r, 150));
            expect(cache.has('/files/key')).toBe(false);
        });
    });
    describe('getCached (for 304 responses)', () => {
        it('returns cached data without ETag', () => {
            cache.set('/files/key', { data: 'cached' }, 'etag1');
            const result = cache.getCached('/files/key');
            expect(result).toEqual({ data: 'cached' });
        });
        it('returns null for missing key', () => {
            const result = cache.getCached('/files/missing');
            expect(result).toBeNull();
        });
        it('respects TTL', async () => {
            cache = new ETagCache({ defaultTtlMs: 100, maxSize: 10 });
            cache.set('/files/key', { data: 'test' }, 'etag1');
            expect(cache.getCached('/files/key')).toEqual({ data: 'test' });
            await new Promise(r => setTimeout(r, 150));
            expect(cache.getCached('/files/key')).toBeNull();
        });
    });
    describe('Invalidation', () => {
        it('deletes specific entry', () => {
            cache.set('/files/key', { data: 'test' }, 'etag1');
            expect(cache.delete('/files/key')).toBe(true);
            expect(cache.get('/files/key')).toBeNull();
        });
        it('returns false for missing entry', () => {
            expect(cache.delete('/files/missing')).toBe(false);
        });
        it('clears all entries', () => {
            cache.set('/files/key1', { data: 'test1' }, 'etag1');
            cache.set('/files/key2', { data: 'test2' }, 'etag2');
            cache.clear();
            expect(cache.get('/files/key1')).toBeNull();
            expect(cache.get('/files/key2')).toBeNull();
        });
    });
    describe('Eviction (maxSize)', () => {
        it('evicts oldest entry when at capacity', () => {
            cache = new ETagCache({ defaultTtlMs: 60000, maxSize: 3 });
            cache.set('/files/key1', { data: '1' }, 'etag1');
            cache.set('/files/key2', { data: '2' }, 'etag2');
            cache.set('/files/key3', { data: '3' }, 'etag3');
            // This should evict key1
            cache.set('/files/key4', { data: '4' }, 'etag4');
            expect(cache.get('/files/key1')).toBeNull();
            expect(cache.get('/files/key2')).not.toBeNull();
            expect(cache.get('/files/key3')).not.toBeNull();
            expect(cache.get('/files/key4')).not.toBeNull();
        });
    });
    describe('getStats', () => {
        it('returns correct statistics', () => {
            cache.set('/files/key1', { data: '1' }, 'etag1');
            cache.set('/files/key2', { data: '2' }, 'etag2');
            const stats = cache.getStats();
            expect(stats.size).toBe(2);
            expect(stats.maxSize).toBe(10);
            expect(stats.ttlMs).toBe(1000);
            expect(stats.entries).toHaveLength(2);
        });
    });
});
//# sourceMappingURL=etag-cache.test.js.map