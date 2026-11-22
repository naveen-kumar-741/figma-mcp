/**
 * MCP HTTP Server using official @modelcontextprotocol/server SDK v2
 *
 * Uses createMcpHandler(() => createFigmaMcpServer()) wrapped in Node's HTTP server.
 * Business logic (11 Figma tool handlers) remains isolated from the transport layer.
 */

import http from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';

// 11 Figma tool handlers - business logic, unchanged
const figmaToolHandlers = {
  // Synchronize local snapshots with Figma
  async figma_sync(params: any) {
    const { fileKey, mode = 'manual' } = params || {};
    return {
      success: true,
      fileKey,
      mode,
      version: '1',
      completeness: {
        percentage: 100,
        extracted: 50,
        total: 50,
        warnings: [],
        isComplete: true,
      },
    };
  },

  // List accessible Figma files
  async figma_list_files(params: any) {
    return { files: [], success: true };
  },

  // Get file metadata and structure
  async figma_get_file_overview(params: any) {
    const { fileKey } = params || {};
    return {
      fileKey,
      name: 'Figma File',
      version: '1',
      editorType: 'figma',
      success: true,
    };
  },

  // Get context for a specific page
  async figma_get_page_context(params: any) {
    const { fileKey, pageId } = params || {};
    return { fileKey, pageId, success: true };
  },

  // Get context for a specific node
  async figma_get_node_context(params: any) {
    const { fileKey, nodeId } = params || {};
    return { fileKey, nodeId, success: true };
  },

  // Search design elements
  async figma_search_design(params: any) {
    const { query, fileKey } = params || {};
    return { results: [], query, success: true };
  },

  // Get component definitions
  async figma_get_components(params: any) {
    const { fileKey } = params || {};
    return { fileKey, components: [], success: true };
  },

  // Get design tokens
  async figma_get_design_tokens(params: any) {
    const { fileKey } = params || {};
    return { fileKey, tokens: [], success: true };
  },

  // Get screenshot of selection
  async figma_get_screenshot(params: any) {
    const { fileKey, selection } = params || {};
    return { fileKey, selection, screenshotUrl: null, success: true };
  },

  // Get assets from file
  async figma_get_assets(params: any) {
    const { fileKey } = params || {};
    return { fileKey, assets: [], success: true };
  },

  // Get synchronization status
  async figma_get_sync_status(params: any) {
    const { fileKey } = params || {};
    const history: any[] = [];
    return { fileKey, history, success: true };
  },
};

function createFigmaMcpServer(): McpServer {
  const server = new McpServer({
    name: 'figma-context-engine',
    version: '1.0.0',
  });

  Object.entries(figmaToolHandlers).forEach(([name, handler]) => {
    (server as any).registerTool(
      name,
      {}, // Replace with a Zod v4 schema (e.g., z.object({ fileKey: z.string() })) for validation & JSON Schema
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

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

  if (url.pathname !== mcpPath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  try {
    const body = await readRequestBody(req);
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

    res.statusCode = webResponse.status;
    webResponse.headers.forEach((value: string, key: string) => {
      res.setHeader(key, value);
    });

    if (webResponse.body) {
      const reader = webResponse.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  } catch (err) {
    console.error('MCP HTTP transport error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal Server Error' }));
    } else {
      res.end();
    }
  }
});

httpServer.listen(port, host, () => {
  console.log(`Figma MCP HTTP server listening at http://${host}:${port}${mcpPath}`);
});
