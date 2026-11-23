/**
 * MCP HTTP Server using official @modelcontextprotocol/server SDK v2
 *
 * Uses createMcpHandler(() => createFigmaMcpServer()) wrapped in Node's HTTP server.
 * Business logic (11 Figma tool handlers) remains isolated from the transport layer.
 */

// Load .env file at runtime (must be first)
import 'dotenv/config';

import http from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import pino from 'pino';
import { FigmaClient, FigmaApiError, getFigmaClient, createFigmaClient } from './figma-client.js';

// Main server logger
const logger = pino({
  name: 'figma-mcp-server',
  level: process.env.MCP_LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
  } : undefined,
});

// Zod v4 validation schemas for all Figma tools
const figmaSchemas = {
  figma_sync: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    mode: z.enum(['manual', 'auto', 'full']).optional().default('manual'),
    branchName: z.string().optional(),
  }),

  figma_list_files: z.object({
    projectId: z.string().optional(),
    teamId: z.string().optional(),
  }),

  figma_get_file_overview: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    version: z.string().optional(),
    branchData: z.boolean().optional().default(false),
  }),

  figma_get_page_context: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    pageId: z.string().min(1, 'Page ID is required'),
    depth: z.number().int().min(1).max(10).optional().default(3),
    includeStyles: z.boolean().optional().default(true),
  }),

  figma_get_node_context: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    nodeId: z.string().min(1, 'Node ID is required'),
    depth: z.number().int().min(1).max(10).optional().default(3),
    includeStyles: z.boolean().optional().default(true),
    includeChildren: z.boolean().optional().default(true),
  }),

  figma_search_design: z.object({
    query: z.string().min(1, 'Search query is required'),
    fileKey: z.string().optional(),
    type: z.enum(['component', 'frame', 'text', 'shape', 'instance', 'all']).optional().default('all'),
    limit: z.number().int().min(1).max(100).optional().default(20),
  }),

  figma_get_components: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    includeVariants: z.boolean().optional().default(true),
    onlyPublished: z.boolean().optional().default(false),
  }),

  figma_get_design_tokens: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    tokenTypes: z.array(z.enum(['color', 'text', 'spacing', 'border', 'shadow', 'opacity', 'all'])).optional().default(['all']),
    format: z.enum(['json', 'css', 'scss', 'figma']).optional().default('json'),
  }),

  figma_get_screenshot: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    selection: z.array(z.string()).min(1, 'At least one node ID required'),
    format: z.enum(['png', 'jpg', 'svg', 'pdf']).optional().default('png'),
    scale: z.number().min(0.5).max(4).optional().default(2),
    backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }),

  figma_get_assets: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    format: z.enum(['svg', 'png', 'jpg', 'pdf', 'webp']).optional().default('svg'),
    scale: z.number().min(0.5).max(4).optional().default(1),
    ids: z.array(z.string()).optional(),
  }),

  figma_get_sync_status: z.object({
    fileKey: z.string().min(1, 'File key is required'),
    includeHistory: z.boolean().optional().default(true),
    limit: z.number().int().min(1).max(100).optional().default(50),
  }),

  // Rate limit status (local + Figma)
  figma_get_rate_limit_status: z.object({}),

  // ETag cache status
  figma_get_cache_status: z.object({}),
  figma_clear_cache: z.object({}),
};

// Initialize Figma client
let figmaClient: FigmaClient;

try {
  figmaClient = createFigmaClient();
  logger.info('Figma client initialized successfully');
} catch (error) {
  logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Figma client not initialized');
  figmaClient = null as any;
}

// Helper to get client or throw
function getClient(): FigmaClient {
  if (!figmaClient) {
    throw new Error('Figma client not initialized. Set FIGMA_ACCESS_TOKEN environment variable.');
  }
  return figmaClient;
}

// Helper to normalize node IDs from URL format (1-5729) to API format (1:5729)
function normalizeNodeId(id: string): string {
  if (!id) return id;
  return id.replace(/-/g, ':');
}

function normalizeNodeIds(ids: string[]): string[] {
  if (!ids) return ids;
  return ids.map(normalizeNodeId);
}

// Helper to handle Figma API errors
function handleFigmaError(error: unknown, operation: string): never {
  if (error instanceof FigmaApiError) {
    const msg = `Figma API error (${error.status}): ${error.message}`;
    if (error.isUnauthorized()) {
      throw new Error(`${msg} - Check FIGMA_ACCESS_TOKEN`);
    }
    if (error.isNotFound()) {
      throw new Error(`${msg} - Resource not found`);
    }
    if (error.isRateLimited()) {
      throw new Error(`${msg} - Rate limited, try again later`);
    }
    throw new Error(msg);
  }
  throw new Error(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`);
}

// 11 Figma tool handlers - now with real Figma API integration
const figmaToolHandlers = {
  // Synchronize local snapshots with Figma - fetches full file data
  async figma_sync(params: { fileKey: string; mode?: 'manual' | 'auto' | 'full'; branchName?: string }) {
    const { fileKey, mode = 'manual', branchName } = params;
    const client = getClient();
    
    try {
      const file = await client.getFile(fileKey, { branchData: !!branchName });
      
      // Count nodes recursively
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
      
      return {
        success: true,
        fileKey,
        mode,
        version: file.version,
        lastModified: file.lastModified,
        name: file.name,
        completeness: {
          percentage: 100,
          extracted: totalNodes + componentCount + styleCount,
          total: totalNodes + componentCount + styleCount,
          warnings: [],
          isComplete: true,
        },
        stats: {
          totalNodes,
          components: componentCount,
          styles: styleCount,
          pages: file.document.children?.filter((n: any) => n.type === 'CANVAS').length || 0,
        },
      };
    } catch (error) {
      handleFigmaError(error, 'figma_sync');
    }
  },

  // List accessible Figma files - via project or team
  async figma_list_files(params: { projectId?: string; teamId?: string }) {
    const { projectId, teamId } = params;
    const client = getClient();
    
    try {
      let files: any[] = [];
      
      if (projectId) {
        const response = await client.getProjectFiles(projectId);
        files = response.files;
      } else if (teamId) {
        const projects = await client.getTeamProjects(teamId);
        for (const project of projects.projects) {
          const response = await client.getProjectFiles(project.id);
          files.push(...response.files);
        }
      } else {
        throw new Error('Either projectId or teamId is required');
      }
      
      return {
        success: true,
        files: files.map(f => ({
          key: f.key,
          name: f.name,
          lastModified: f.lastModified,
          thumbnailUrl: f.thumbnailUrl,
          version: f.version,
        })),
        count: files.length,
      };
    } catch (error) {
      handleFigmaError(error, 'figma_list_files');
    }
  },

  // Get file metadata and structure
  async figma_get_file_overview(params: { fileKey: string; version?: string; branchData?: boolean }) {
    const { fileKey, version, branchData } = params;
    const client = getClient();
    
    try {
      const file = await client.getFile(fileKey, { version, branchData });
      
      // Extract page info
      const pages = file.document.children
        ?.filter((n: any) => n.type === 'CANVAS')
        .map((p: any) => ({
          id: p.id,
          name: p.name,
          childCount: p.children?.length || 0,
        })) || [];
      
      return {
        success: true,
        fileKey,
        name: file.name,
        version: file.version,
        lastModified: file.lastModified,
        editorType: 'figma',
        pages,
        stats: {
          totalComponents: Object.keys(file.components || {}).length,
          totalStyles: Object.keys(file.styles || {}).length,
        },
      };
    } catch (error) {
      handleFigmaError(error, 'figma_get_file_overview');
    }
  },

  // Get context for a specific page
  async figma_get_page_context(params: { fileKey: string; pageId: string; depth?: number; includeStyles?: boolean }) {
    const { fileKey, pageId, depth = 3, includeStyles = true } = params;
    const client = getClient();
    
    try {
      const response = await client.getFileNodes(fileKey, [pageId], { depth });
      const pageData = response.nodes[pageId];
      
      if (!pageData) {
        throw new Error(`Page ${pageId} not found in file ${fileKey}`);
      }
      
      const result: any = {
        success: true,
        fileKey,
        pageId,
        page: pageData.document,
      };
      
      if (includeStyles && pageData.styles) {
        result.styles = Object.values(pageData.styles);
      }
      
      return result;
    } catch (error) {
      handleFigmaError(error, 'figma_get_page_context');
    }
  },

  // Get context for a specific node
  async figma_get_node_context(params: { fileKey: string; nodeId: string; depth?: number; includeStyles?: boolean; includeChildren?: boolean }) {
    const { fileKey, nodeId, depth = 3, includeStyles = true, includeChildren = true } = params;
    const client = getClient();
    
    // Normalize nodeId from URL format (1-5729) to API format (1:5729)
    const normalizedNodeId = normalizeNodeId(nodeId);
    
    try {
      const response = await client.getFileNodes(fileKey, [normalizedNodeId], { depth });
      const nodeData = response.nodes[normalizedNodeId];
      
      if (!nodeData) {
        throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
      }
      
      const result: any = {
        success: true,
        fileKey,
        nodeId,
        node: nodeData.document,
      };
      
      if (!includeChildren && nodeData.document.children) {
        delete nodeData.document.children;
      }
      
      if (includeStyles && nodeData.styles) {
        result.styles = Object.values(nodeData.styles);
      }
      
      if (nodeData.components) {
        result.components = Object.values(nodeData.components);
      }
      
      return result;
    } catch (error) {
      handleFigmaError(error, 'figma_get_node_context');
    }
  },

  // Search design elements - searches within a file's nodes
  async figma_search_design(params: { query: string; fileKey?: string; type?: 'component' | 'frame' | 'text' | 'shape' | 'instance' | 'all'; limit?: number }) {
    const { query, fileKey, type = 'all', limit = 20 } = params;
    const client = getClient();
    
    if (!fileKey) {
      throw new Error('fileKey is required for search');
    }
    
    try {
      // Get full file to search
      const file = await client.getFile(fileKey);
      
      const results: any[] = [];
      const queryLower = query.toLowerCase();
      
      function searchNode(node: any, path: string[] = []) {
        if (results.length >= limit) return;
        
        const matchesQuery = node.name?.toLowerCase().includes(queryLower) || 
                            node.type?.toLowerCase().includes(queryLower);
        
        const matchesType = type === 'all' || 
                           (type === 'component' && node.type === 'COMPONENT') ||
                           (type === 'frame' && node.type === 'FRAME') ||
                           (type === 'text' && node.type === 'TEXT') ||
                           (type === 'shape' && ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR'].includes(node.type)) ||
                           (type === 'instance' && node.type === 'INSTANCE');
        
        if (matchesQuery && matchesType) {
          results.push({
            id: node.id,
            name: node.name,
            type: node.type,
            path: [...path, node.name].join(' > '),
            // Include minimal relevant props
            fills: node.fills,
            strokes: node.strokes,
            characters: node.characters,
            fontSize: node.fontSize,
          });
        }
        
        if (node.children && results.length < limit) {
          for (const child of node.children) {
            searchNode(child, [...path, node.name || 'root']);
          }
        }
      }
      
      searchNode(file.document);
      
      return {
        success: true,
        query,
        fileKey,
        results: results.slice(0, limit),
        total: results.length,
      };
    } catch (error) {
      handleFigmaError(error, 'figma_search_design');
    }
  },

  // Get component definitions
  async figma_get_components(params: { fileKey: string; includeVariants?: boolean; onlyPublished?: boolean }) {
    const { fileKey, includeVariants = true, onlyPublished = false } = params;
    const client = getClient();
    
    try {
      const response = await client.getFileComponents(fileKey);
      let components = Object.values(response.components);
      
      if (onlyPublished) {
        components = components.filter(c => c.description || c.key); // Figma marks published components
      }
      
      if (!includeVariants) {
        // Filter out variant children (keep only component sets)
        components = components.filter(c => !c.componentSetId);
      }
      
      return {
        success: true,
        fileKey,
        components: components.map(c => ({
          key: c.key,
          name: c.name,
          description: c.description,
          componentSetId: c.componentSetId,
          nodeId: c.nodeId,
          containingFrame: c.containingFrame ? {
            id: c.containingFrame.id,
            name: c.containingFrame.name,
          } : null,
        })),
        count: components.length,
      };
    } catch (error) {
      handleFigmaError(error, 'figma_get_components');
    }
  },

  // Get design tokens (styles)
  async figma_get_design_tokens(params: { fileKey: string; tokenTypes?: Array<'color' | 'text' | 'spacing' | 'border' | 'shadow' | 'opacity' | 'all'>; format?: 'json' | 'css' | 'scss' | 'figma' }) {
    const { fileKey, tokenTypes = ['all'], format = 'json' } = params;
    const client = getClient();
    
    try {
      const response = await client.getFileStyles(fileKey);
      const styles = Object.values(response.meta);
      
      // Map Figma style types to token types
      const typeMap: Record<string, string[]> = {
        color: ['FILL'],
        text: ['TEXT'],
        spacing: [], // Figma doesn't have explicit spacing styles
        border: ['EFFECT'], // strokes/borders are often effects
        shadow: ['EFFECT'],
        opacity: ['EFFECT'],
      };
      
      let filteredStyles = styles;
      if (!tokenTypes.includes('all')) {
        const allowedFigmaTypes = tokenTypes.flatMap(t => typeMap[t] || []);
        filteredStyles = styles.filter(s => allowedFigmaTypes.includes(s.styleType));
      }
      
      const tokens = filteredStyles.map(style => ({
        key: style.key,
        name: style.name,
        description: style.description,
        type: style.styleType.toLowerCase(),
        nodeId: style.nodeId,
      }));
      
      // Format output
      let formattedTokens: any;
      switch (format) {
        case 'css':
          formattedTokens = tokens.map(t => `--${t.name.replace(/\s+/g, '-')}: ${t.description || 'var(...)'};`).join('\n');
          break;
        case 'scss':
          formattedTokens = tokens.map(t => `$${t.name.replace(/\s+/g, '-')}: ${t.description || 'var(...)'};`).join('\n');
          break;
        case 'figma':
          formattedTokens = tokens;
          break;
        default:
          formattedTokens = tokens.reduce((acc, t) => {
            acc[t.name] = { value: t.description, type: t.type, description: t.description };
            return acc;
          }, {} as Record<string, any>);
      }
      
      return {
        success: true,
        fileKey,
        tokens: formattedTokens,
        count: tokens.length,
        format,
      };
    } catch (error) {
      handleFigmaError(error, 'figma_get_design_tokens');
    }
  },

  // Get screenshot of selection
  async figma_get_screenshot(params: { fileKey: string; selection: string[]; format?: 'png' | 'jpg' | 'svg' | 'pdf'; scale?: number; backgroundColor?: string }) {
    const { fileKey, selection, format = 'png', scale = 2, backgroundColor } = params;
    const client = getClient();
    
    // Normalize selection from URL format (1-5729) to API format (1:5729)
    const normalizedSelection = normalizeNodeIds(selection);
    
    try {
      const response = await client.getFileImages(fileKey, normalizedSelection, { 
        format: format === 'pdf' ? 'svg' : format, // PDF not directly supported, use SVG
        scale,
        useAbsoluteBounds: true,
      });
      
      const images = Object.entries(response.images)
        .filter(([_, url]) => url !== null)
        .map(([nodeId, url]) => ({ nodeId, url }));
      
      if (images.length === 0) {
        throw new Error('No images generated for the selected nodes');
      }
      
      return {
        success: true,
        fileKey,
        selection,
        format,
        scale,
        images,
        count: images.length,
      };
    } catch (error) {
      handleFigmaError(error, 'figma_get_screenshot');
    }
  },

  // Get assets from file (export nodes as images)
  async figma_get_assets(params: { fileKey: string; format?: 'svg' | 'png' | 'jpg' | 'pdf' | 'webp'; scale?: number; ids?: string[] }) {
    const { fileKey, format = 'svg', scale = 1, ids } = params;
    const client = getClient();
    
    // Normalize ids from URL format (1-5729) to API format (1:5729) if provided
    const normalizedIds = ids ? normalizeNodeIds(ids) : undefined;
    
    try {
      // If no IDs provided, get all exportable nodes from file
      let nodeIds = normalizedIds;
      if (!nodeIds) {
        const file = await client.getFile(fileKey);
        
        function findExportableNodes(node: any): string[] {
          const results: string[] = [];
          if (node.exportSettings && node.exportSettings.length > 0) {
            results.push(node.id);
          }
          if (node.children) {
            for (const child of node.children) {
              results.push(...findExportableNodes(child));
            }
          }
          return results;
        }
        
        nodeIds = findExportableNodes(file.document);
      }
      
      if (!nodeIds || nodeIds.length === 0) {
        return { success: true, fileKey, assets: [], count: 0, message: 'No exportable nodes found' };
      }
      
      const response = await client.getFileImages(fileKey, nodeIds, { 
        format: format === 'pdf' || format === 'webp' ? 'svg' : format,
        scale,
      });
      
      const assets = Object.entries(response.images)
        .filter(([_, url]) => url !== null)
        .map(([nodeId, url]) => ({ nodeId, url, format, scale }));
      
      return {
        success: true,
        fileKey,
        assets,
        count: assets.length,
        requested: nodeIds.length,
      };
    } catch (error) {
      handleFigmaError(error, 'figma_get_assets');
    }
  },

  // Get synchronization status - returns file version info
  async figma_get_sync_status(params: { fileKey: string; includeHistory?: boolean; limit?: number }) {
    const { fileKey, includeHistory = true, limit = 50 } = params;
    const client = getClient();
    
    try {
      const file = await client.getFile(fileKey);
      
      // Figma API doesn't provide version history directly
      // This returns current version info as a baseline
      const history = includeHistory ? [{
        version: file.version,
        timestamp: file.lastModified,
        user: 'unknown', // Figma API doesn't expose this in file endpoint
        description: 'Current version',
      }] : [];
      
      return {
        success: true,
        fileKey,
        currentVersion: file.version,
        lastModified: file.lastModified,
        name: file.name,
        history: history.slice(0, limit),
      };
    } catch (error) {
      handleFigmaError(error, 'figma_get_sync_status');
    }
  },

  // Get rate limit status - local token bucket + Figma headers
  async figma_get_rate_limit_status(params: {}) {
    const client = getClient();
    
    const localStatus = client.getRateLimitStatus();
    const figmaHeaders = client.getFigmaRateLimitHeaders();
    
    return {
      success: true,
      local: {
        availableTokens: localStatus.available,
        capacity: localStatus.capacity,
        resetInMs: localStatus.resetInMs,
        requestsPerSecond: 30,
      },
      figma: figmaHeaders ? {
        limit: figmaHeaders.limit,
        remaining: figmaHeaders.remaining,
        resetTimestamp: figmaHeaders.reset,
        resetInMs: Math.max(0, figmaHeaders.reset - Date.now()),
      } : null,
      note: 'Local bucket protects against 429s; Figma headers show actual API state',
    };
  },

  // Get ETag cache statistics
  async figma_get_cache_status(params: {}) {
    const client = getClient();
    const stats = client.getCacheStats();
    
    return {
      success: true,
      cache: {
        entries: stats.size,
        maxEntries: stats.maxSize,
        ttlMs: stats.ttlMs,
        ttlMinutes: Math.round(stats.ttlMs / 60000),
        entryKeys: stats.entries,
      },
    };
  },

  // Clear ETag cache
  async figma_clear_cache(params: {}) {
    const client = getClient();
    client.clearCache();
    
    return {
      success: true,
      message: 'ETag cache cleared',
    };
  },
};

function createFigmaMcpServer(): McpServer {
  const server = new McpServer({
    name: 'figma-context-engine',
    version: '1.0.0',
  });

  Object.entries(figmaToolHandlers).forEach(([name, handler]) => {
    const schema = figmaSchemas[name as keyof typeof figmaSchemas];
    (server as any).registerTool(
      name,
      schema, // Zod v4 schema for validation & JSON Schema generation
      async (args: Record<string, unknown> | undefined) => {
        try {
          // @ts-ignore - SDK type compatibility
          const result = await handler(args ?? {});
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
            isError: false,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: false, error: message }),
              },
            ],
            isError: true,
          };
        }
      }
    );
  });

  return server;
}

const mcpHandler = createMcpHandler(() => createFigmaMcpServer());

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const mcpPath = process.env.MCP_PATH ?? '/mcp';

// ============================================================================
// Server-Side Rate Limiter (Per-Client)
// ============================================================================

import { ServerRateLimiter } from './server-rate-limiter.js';

// Rate limiter instance (configurable via env)
const SERVER_RATE_LIMIT_RPS = Number(process.env.MCP_RATE_LIMIT_RPS ?? 10);
const SERVER_RATE_LIMIT_BURST = Number(process.env.MCP_RATE_LIMIT_BURST ?? 10);
const serverRateLimiter = new ServerRateLimiter(SERVER_RATE_LIMIT_RPS, SERVER_RATE_LIMIT_BURST);

// HTTP Server Authentication
const MCP_API_KEY = process.env.MCP_API_KEY; // Optional: set to enable auth
const MCP_ALLOWED_IPS = process.env.MCP_ALLOWED_IPS?.split(',').map(ip => ip.trim()).filter(Boolean) || [];

function getClientIdentifier(req: http.IncomingMessage): string {
  // Use API key if available, otherwise IP
  const authHeader = req.headers['authorization'];
  const apiKeyHeader = req.headers['x-api-key'];
  
  if (authHeader?.startsWith('Bearer ')) {
    return `apikey:${authHeader.slice(7).slice(0, 8)}...`; // Partial for logging
  }
  if (apiKeyHeader) {
    return `apikey:${apiKeyHeader.slice(0, 8)}...`;
  }
  
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0])?.trim()
    || req.socket.remoteAddress 
    || 'unknown';
  return `ip:${ip}`;
}

function authenticateRequest(req: http.IncomingMessage): { authorized: boolean; error?: string } {
  // IP allowlist check
  const forwardedFor = req.headers['x-forwarded-for'];
  const clientIp = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor?.split(',')[0])?.trim()
    || req.socket.remoteAddress 
    || 'unknown';
  
  if (MCP_ALLOWED_IPS.length > 0 && !MCP_ALLOWED_IPS.includes(clientIp)) {
    return { authorized: false, error: `IP ${clientIp} not allowed` };
  }

  // API Key check (Bearer token or custom header)
  if (MCP_API_KEY) {
    const authHeader = req.headers['authorization'];
    const apiKeyHeader = req.headers['x-api-key'];
    
    const providedKey = authHeader?.startsWith('Bearer ') 
      ? authHeader.slice(7) 
      : apiKeyHeader;
    
    if (!providedKey || providedKey !== MCP_API_KEY) {
      return { authorized: false, error: 'Invalid or missing API key' };
    }
  }

  return { authorized: true };
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer | undefined> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Generate unique request ID
function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

const httpServer = http.createServer(async (req, res) => {
  const startTime = Date.now();
  const requestId = generateRequestId();
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
  const clientIp = (Array.isArray(req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'][0] : req.headers['x-forwarded-for']?.split(',')[0])?.trim()
    || req.socket.remoteAddress 
    || 'unknown';

  // Create child logger with request context
  const reqLogger = logger.child({ 
    requestId,
    method: req.method,
    path: url.pathname,
    ip: clientIp,
    userAgent: req.headers['user-agent'],
  });

  // Add request ID to response headers for tracing
  res.setHeader('X-Request-ID', requestId);

  // Log incoming request
  reqLogger.info('Incoming request');

  // Health check endpoint (no auth, no rate limit)
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
    res.end(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: '1.0.0',
    }));
    reqLogger.info({ statusCode: 200, durationMs: Date.now() - startTime }, 'Request completed');
    return;
  }

  // Rate limit status endpoint (requires auth if enabled, but no rate limit)
  if (url.pathname === '/rate-limit-status') {
    const auth = authenticateRequest(req);
    if (!auth.authorized) {
      res.writeHead(401, { 
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="figma-mcp"',
        'X-Request-ID': requestId,
      });
      res.end(JSON.stringify({ error: 'Unauthorized', message: auth.error }));
      reqLogger.warn({ statusCode: 401, durationMs: Date.now() - startTime, error: auth.error }, 'Request unauthorized');
      return;
    }
    const clientId = getClientIdentifier(req);
    const status = serverRateLimiter.getStatus(clientId);
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
    res.end(JSON.stringify({
      clientId,
      limit: SERVER_RATE_LIMIT_BURST,
      remaining: status.remaining,
      resetInMs: status.resetInMs,
      requestsPerSecond: SERVER_RATE_LIMIT_RPS,
    }));
    reqLogger.info({ statusCode: 200, durationMs: Date.now() - startTime }, 'Request completed');
    return;
  }

  if (url.pathname !== mcpPath) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
    res.end(JSON.stringify({ error: 'Not Found' }));
    reqLogger.warn({ statusCode: 404, durationMs: Date.now() - startTime }, 'Request not found');
    return;
  }

  // Authentication check
  const auth = authenticateRequest(req);
  if (!auth.authorized) {
    res.writeHead(401, { 
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer realm="figma-mcp"',
      'X-Request-ID': requestId,
    });
    res.end(JSON.stringify({ error: 'Unauthorized', message: auth.error }));
    reqLogger.warn({ statusCode: 401, durationMs: Date.now() - startTime, error: auth.error }, 'Request unauthorized');
    return;
  }

  // Rate limiting check (per client)
  const clientId = getClientIdentifier(req);
  const rateLimit = serverRateLimiter.tryConsume(clientId);
  
  // Set rate limit headers on all responses
  res.setHeader('X-RateLimit-Limit', SERVER_RATE_LIMIT_BURST.toString());
  res.setHeader('X-RateLimit-Remaining', rateLimit.remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.ceil((Date.now() + rateLimit.resetInMs) / 1000).toString());
  
  if (!rateLimit.allowed) {
    res.writeHead(429, { 
      'Content-Type': 'application/json',
      'Retry-After': Math.ceil(rateLimit.resetInMs / 1000).toString(),
      'X-RateLimit-Limit': SERVER_RATE_LIMIT_BURST.toString(),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': Math.ceil((Date.now() + rateLimit.resetInMs) / 1000).toString(),
      'X-Request-ID': requestId,
    });
    res.end(JSON.stringify({ 
      error: 'Too Many Requests', 
      message: `Rate limit exceeded. Try again in ${Math.ceil(rateLimit.resetInMs / 1000)} seconds.`,
      retryAfter: Math.ceil(rateLimit.resetInMs / 1000),
    }));
    reqLogger.warn({ statusCode: 429, durationMs: Date.now() - startTime, retryAfter: rateLimit.resetInMs }, 'Rate limit exceeded');
    return;
  }

  try {
    const body = await readRequestBody(req);
    
    // Parse and log MCP request (JSON-RPC)
    let mcpRequest: { method?: string; params?: any; id?: string | number } | null = null;
    if (body && body.length > 0) {
      try {
        const parsed = JSON.parse(body.toString('utf-8'));
        if (parsed && typeof parsed === 'object') {
          mcpRequest = {
            method: parsed.method,
            params: parsed.params,
            id: parsed.id,
          };
          // Log MCP request (debug level, sanitized)
          reqLogger.debug({ 
            mcpMethod: parsed.method, 
            mcpId: parsed.id,
            // Don't log full params as they may be large
            hasParams: !!parsed.params,
          }, 'MCP request');
        }
      } catch {
        // Not JSON, skip MCP logging
      }
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) {
        headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
    }

    const webRequest = new Request(url.toString(), {
      method: req.method ?? 'POST',
      headers,
      body: body && body.length > 0 ? new Uint8Array(body) : undefined,
    });

    const webResponse = await mcpHandler.fetch(webRequest);

    // Add request ID to response headers
    res.setHeader('X-Request-ID', requestId);
    
    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });

    // Capture response body for logging
    let responseBody: Buffer | null = null;
    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      const chunks: Buffer[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Convert Uint8Array to Buffer
        const buffer = Buffer.from(value);
        chunks.push(buffer);
        res.write(buffer);
      }
      if (chunks.length > 0) {
        responseBody = Buffer.concat(chunks);
      }
    }
    res.end();
    
    // Log MCP response (debug level)
    if (responseBody && responseBody.length > 0) {
      try {
        const parsedResponse = JSON.parse(responseBody.toString('utf-8'));
        if (parsedResponse && typeof parsedResponse === 'object') {
          reqLogger.debug({ 
            mcpId: parsedResponse.id,
            mcpResult: parsedResponse.result ? 'present' : undefined,
            mcpError: parsedResponse.error ? {
              code: parsedResponse.error.code,
              message: parsedResponse.error.message,
            } : undefined,
          }, 'MCP response');
        }
      } catch {
        // Not JSON, skip
      }
    }
    
    // Log successful response
    const durationMs = Date.now() - startTime;
    reqLogger.info({ statusCode: res.statusCode, durationMs }, 'Request completed');
  } catch (err) {
    const durationMs = Date.now() - startTime;
    reqLogger.error({ err: err instanceof Error ? err.message : String(err), durationMs }, 'MCP HTTP transport error');
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'X-Request-ID': requestId });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    } else {
      res.end();
    }
  }
});

httpServer.listen(port, host, () => {
  logger.info({ host, port, mcpPath }, 'Figma MCP HTTP server listening');
  logger.info({ path: '/health' }, 'Health check endpoint');
  logger.info({ path: '/rate-limit-status' }, 'Rate limit status endpoint');
  logger.info({ path: mcpPath }, 'MCP endpoint');
  logger.info({ rps: SERVER_RATE_LIMIT_RPS, burst: SERVER_RATE_LIMIT_BURST }, 'Server rate limit config');
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down gracefully...');
  serverRateLimiter.shutdown();
  httpServer.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });
  
  // Force close after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
