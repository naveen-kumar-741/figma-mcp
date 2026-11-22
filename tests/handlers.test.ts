/**
 * Tests for MCP tool handlers (integration-style with mocked FigmaClient)
 */
import { FigmaClient, FigmaApiError, createFigmaClient } from '../src/figma-client.ts';
import { jest } from '@jest/globals';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// We need to test the handlers, but they're in index.ts
// Let's test the FigmaClient integration which the handlers use

describe('MCP Tool Handler Integration', () => {
  let client: FigmaClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new FigmaClient({ accessToken: 'test-token' });
  });

  describe('figma_sync handler scenario', () => {
    it('fetches full file and computes stats', async () => {
      const mockFile = {
        name: 'Test File',
        lastModified: '2024-01-01T00:00:00Z',
        version: '5',
        document: {
          id: '0:0',
          name: 'Document',
          type: 'DOCUMENT',
          children: [
            { id: '1:1', name: 'Page 1', type: 'CANVAS', children: [
              { id: '1:2', name: 'Frame', type: 'FRAME', children: [] },
              { id: '1:3', name: 'Text', type: 'TEXT', children: [] },
            ]},
            { id: '2:1', name: 'Page 2', type: 'CANVAS', children: [] },
          ],
        },
        components: {
          'comp1': { key: 'comp1', name: 'Button', description: '', nodeId: '1:2', componentSetId: undefined },
          'comp2': { key: 'comp2', name: 'Input', description: '', nodeId: '1:4', componentSetId: 'set1' },
        },
        styles: {
          'style1': { key: 'style1', name: 'Primary', description: '', styleType: 'FILL', nodeId: '1:5' },
        },
        schemaVersion: 1,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'ETag': 'etag123' }),
        json: async () => mockFile,
      });

      const file = await client.getFile('fileKey', { branchData: false });

      // Simulate handler logic
      function countNodes(node: any): number {
        let count = 1;
        if (node.children) {
          for (const child of node.children) {
            count += countNodes(child);
          }
        }
        return count;
      }

      const totalNodes = countNodes(file.document);
      const componentCount = Object.keys(file.components || {}).length;
      const styleCount = Object.keys(file.styles || {}).length;
      const pages = file.document.children?.filter((n: any) => n.type === 'CANVAS').length || 0;

      expect(totalNodes).toBe(5); // Document + Page1 + Frame + Text + Page2
      expect(componentCount).toBe(2);
      expect(styleCount).toBe(1);
      expect(pages).toBe(2);
      expect(file.version).toBe('5');
    });
  });

  describe('figma_list_files handler scenario', () => {
    it('lists files from project', async () => {
      const mockFiles = {
        files: [
          { key: 'file1', name: 'File 1', lastModified: '2024-01-01T00:00:00Z', thumbnailUrl: 'thumb1', version: '1' },
          { key: 'file2', name: 'File 2', lastModified: '2024-01-02T00:00:00Z', thumbnailUrl: 'thumb2', version: '2' },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'ETag': 'etag123' }),
        json: async () => mockFiles,
      });

      const result = await client.getProjectFiles('project123');

      expect(result.files).toHaveLength(2);
      expect(result.files[0].key).toBe('file1');
      expect(result.files[1].name).toBe('File 2');
    });
  });

  describe('figma_search_design handler scenario', () => {
    it('searches nodes in file', async () => {
      const mockFile = {
        name: 'Test',
        lastModified: '',
        version: '1',
        document: {
          id: '0:0',
          name: 'Document',
          type: 'DOCUMENT',
          children: [
            { 
              id: '1:1', name: 'Page 1', type: 'CANVAS', 
              children: [
                { id: '1:2', name: 'Button', type: 'COMPONENT', fills: [{color: {r:1,g:0,b:0}}], children: [] },
                { id: '1:3', name: 'Header Text', type: 'TEXT', characters: 'Welcome', fontSize: 24, children: [] },
                { id: '1:4', name: 'Rectangle', type: 'RECTANGLE', fills: [{color: {r:0,g:1,b:0}}], children: [] },
              ] 
            },
          ],
        },
        components: {},
        styles: {},
        schemaVersion: 1,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'ETag': 'etag123' }),
        json: async () => mockFile,
      });

      const file = await client.getFile('fileKey');
      
      // Simulate search logic
      const query = 'button';
      const type = 'component';
      const results: any[] = [];
      
      function searchNode(node: any, path: string[] = []) {
        const matchesQuery = node.name?.toLowerCase().includes(query.toLowerCase());
        const matchesType = type === 'all' || (type === 'component' && node.type === 'COMPONENT');
        
        if (matchesQuery && matchesType) {
          results.push({ id: node.id, name: node.name, type: node.type });
        }
        if (node.children) {
          for (const child of node.children) {
            searchNode(child, [...path, node.name || 'root']);
          }
        }
      }
      
      searchNode(file.document);
      
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Button');
      expect(results[0].type).toBe('COMPONENT');
    });
  });

  describe('Error handling', () => {
    it('handles FigmaApiError with status', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ err: 'File not found' }),
      });

      await expect(client.getFile('invalid')).rejects.toThrow('File not found');
    });

    it('handles network errors with retry', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'ETag': 'etag123' }),
          json: async () => ({ name: 'Test', lastModified: '', version: '1', document: {}, components: {}, styles: {}, schemaVersion: 1 }),
        });

      const result = await client.getFile('fileKey');
      expect(result.name).toBe('Test');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});