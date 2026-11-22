/**
 * Tests for FigmaClient with mocked fetch
 */
import { FigmaClient, FigmaApiError } from '../src/figma-client.ts';
import { jest } from '@jest/globals';
// Helper to create mock fetch response
function createMockResponse(data, options = {}) {
    const { ok = true, status = 200, headers = {}, text } = options;
    const headersObj = new Headers(headers);
    return {
        ok,
        status,
        headers: headersObj,
        json: async () => data,
        text: async () => text ?? JSON.stringify(data),
    };
}
// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;
describe('FigmaClient', () => {
    let client;
    beforeEach(() => {
        jest.clearAllMocks();
        client = new FigmaClient({ accessToken: 'test-token' });
    });
    describe('getFile', () => {
        it('fetches file successfully', async () => {
            const mockFile = {
                name: 'Test File',
                lastModified: '2024-01-01T00:00:00Z',
                version: '1',
                document: { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [] },
                components: {},
                styles: {},
                schemaVersion: 1,
            };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockFile, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await client.getFile('fileKey123');
            expect(result).toEqual(mockFile);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url, options] = mockFetch.mock.calls[0];
            expect(url).toBe('https://api.figma.com/v1/files/fileKey123');
            expect(options?.headers).toBeDefined();
            // Headers are a Headers object, check Authorization
            const headers = options?.headers;
            expect(headers.get('Authorization')).toBe('Bearer test-token');
        });
        it('includes version parameter', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({}, {
                headers: { 'ETag': 'etag123' },
            }));
            await client.getFile('fileKey123', { version: 'v1', branchData: true });
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url] = mockFetch.mock.calls[0];
            expect(url).toBe('https://api.figma.com/v1/files/fileKey123?version=v1&branch_data=true');
        });
        it('throws FigmaApiError on 404', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse(null, {
                ok: false,
                status: 404,
                text: JSON.stringify({ err: 'File not found' }),
            }));
            try {
                await client.getFile('invalid');
                throw new Error('Should have thrown');
            }
            catch (error) {
                expect(error).toBeInstanceOf(FigmaApiError);
                expect(error.message).toContain('File not found');
            }
        });
        it('throws FigmaApiError on 401', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse(null, {
                ok: false,
                status: 401,
                text: JSON.stringify({ err: 'Unauthorized' }),
            }));
            try {
                await client.getFile('fileKey');
                throw new Error('Should have thrown');
            }
            catch (error) {
                expect(error).toBeInstanceOf(FigmaApiError);
                expect(error.message).toContain('Unauthorized');
            }
        });
    });
    describe('getFileNodes', () => {
        it('fetches specific nodes', async () => {
            const mockNodes = {
                nodes: {
                    'node1': {
                        document: { id: 'node1', name: 'Frame', type: 'FRAME', children: [] },
                        components: {},
                        styles: {},
                    },
                },
            };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockNodes, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await client.getFileNodes('fileKey', ['node1', 'node2'], { depth: 2 });
            expect(result).toEqual(mockNodes);
            expect(mockFetch).toHaveBeenCalledTimes(1);
            const [url] = mockFetch.mock.calls[0];
            // URL encodes comma as %2C
            expect(url).toBe('https://api.figma.com/v1/files/fileKey/nodes?ids=node1%2Cnode2&depth=2');
        });
    });
    describe('getFileComponents', () => {
        it('fetches components', async () => {
            const mockComponents = {
                components: {
                    'comp1': { key: 'comp1', name: 'Button', description: '', nodeId: 'node1' },
                },
            };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockComponents, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await client.getFileComponents('fileKey');
            expect(result).toEqual(mockComponents);
        });
    });
    describe('getFileStyles', () => {
        it('fetches styles', async () => {
            const mockStyles = {
                meta: {
                    'style1': { key: 'style1', name: 'Primary', description: '#000', styleType: 'FILL', nodeId: 'node1' },
                },
            };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockStyles, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await client.getFileStyles('fileKey');
            expect(result).toEqual(mockStyles);
        });
    });
    describe('getProjectFiles', () => {
        it('fetches project files', async () => {
            const mockFiles = {
                files: [
                    { key: 'file1', name: 'File 1', lastModified: '2024-01-01T00:00:00Z', thumbnailUrl: '', version: '1' },
                ],
            };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockFiles, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await client.getProjectFiles('project123');
            expect(result).toEqual(mockFiles);
        });
    });
    describe('getTeamProjects', () => {
        it('fetches team projects', async () => {
            const mockProjects = {
                projects: [
                    { id: 'proj1', name: 'Project 1' },
                ],
            };
            mockFetch.mockResolvedValueOnce(createMockResponse(mockProjects, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await client.getTeamProjects('team123');
            expect(result).toEqual(mockProjects);
        });
    });
    describe('Rate limiting', () => {
        it('waits when rate limited', async () => {
            // Create client with very low rate for testing
            const limitedClient = new FigmaClient({ accessToken: 'test-token' });
            // Mock 429 then success
            mockFetch
                .mockResolvedValueOnce(createMockResponse(null, {
                ok: false,
                status: 429,
                headers: { 'Retry-After': '0' },
                text: JSON.stringify({ err: 'Rate limited' }),
            }))
                .mockResolvedValueOnce(createMockResponse({
                name: 'Test', lastModified: '', version: '1', document: {}, components: {}, styles: {}, schemaVersion: 1
            }, {
                headers: { 'ETag': 'etag123' },
            }));
            const result = await limitedClient.getFile('fileKey');
            expect(result.name).toBe('Test');
            expect(mockFetch).toHaveBeenCalledTimes(2);
        }, 10000);
    });
    describe('ETag caching', () => {
        it('caches GET responses with ETag', async () => {
            const mockFile = {
                name: 'Test', lastModified: '', version: '1', document: {}, components: {}, styles: {}, schemaVersion: 1
            };
            mockFetch
                .mockResolvedValueOnce(createMockResponse(mockFile, {
                headers: { 'ETag': 'etag123' },
            }))
                .mockResolvedValueOnce(createMockResponse(null, {
                ok: true,
                status: 304,
            }));
            // First request - cache miss
            const result1 = await client.getFile('fileKey');
            expect(result1).toEqual(mockFile);
            // Second request - should use cached ETag and get 304
            const result2 = await client.getFile('fileKey');
            expect(result2).toEqual(mockFile);
            // Verify If-None-Match header sent
            expect(mockFetch).toHaveBeenCalledTimes(2);
            const secondCall = mockFetch.mock.calls[1];
            const headers = secondCall[1]?.headers;
            expect(headers.get('If-None-Match')).toBe('etag123');
        });
        it('invalidates cache on clearCache()', async () => {
            const mockFile = {
                name: 'Test', lastModified: '', version: '1', document: {}, components: {}, styles: {}, schemaVersion: 1
            };
            mockFetch
                .mockResolvedValueOnce(createMockResponse(mockFile, {
                headers: { 'ETag': 'etag123' },
            }))
                .mockResolvedValueOnce(createMockResponse(mockFile, {
                headers: { 'ETag': 'etag456' },
            }));
            await client.getFile('fileKey');
            client.clearCache();
            await client.getFile('fileKey');
            expect(mockFetch).toHaveBeenCalledTimes(2);
            // Second call should not have If-None-Match since cache was cleared
            const secondCall = mockFetch.mock.calls[1];
            const headers = secondCall[1]?.headers;
            expect(headers.has('If-None-Match')).toBe(false);
        });
        it('getCacheStats returns stats', () => {
            const stats = client.getCacheStats();
            expect(stats).toHaveProperty('size');
            expect(stats).toHaveProperty('maxSize');
            expect(stats).toHaveProperty('ttlMs');
            expect(stats).toHaveProperty('entries');
        });
    });
    describe('validateToken', () => {
        it('returns true for valid token', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse({ user: { id: 'user1' } }));
            const result = await client.validateToken();
            expect(result).toBe(true);
        });
        it('returns false for invalid token', async () => {
            mockFetch.mockResolvedValueOnce(createMockResponse(null, {
                ok: false,
                status: 401,
            }));
            const result = await client.validateToken();
            expect(result).toBe(false);
        });
    });
});
//# sourceMappingURL=figma-client.test.js.map