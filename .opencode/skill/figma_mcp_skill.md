---
name: "figma-mcp"
description: "Use Figma MCP server to access Figma files, components, design tokens, and assets via Model Context Protocol"
version: "1.0.0"
---

# Figma MCP Server Skill

This skill provides guidance for using the Figma MCP server to access Figma design data programmatically.

## Server Configuration

```bash
# Required environment variable
FIGMA_ACCESS_TOKEN=figd_your_personal_access_token

# Optional
MCP_API_KEY=your_api_key          # Enable HTTP auth
MCP_ALLOWED_IPS=127.0.0.1,::1    # IP allowlist
MCP_LOG_LEVEL=info               # debug, info, warn, error
MCP_RATE_LIMIT_RPS=10            # Server rate limit (req/s per client)
MCP_RATE_LIMIT_BURST=10          # Server burst capacity
PORT=3000                         # Server port
```

## Available Tools (14)

### 1. `figma_sync` - Full File Sync
Sync entire file with completeness stats
```json
{
  "fileKey": "string",
  "mode": "manual|auto|full",
  "branchName": "string?"
}
```

### 2. `figma_list_files` - List Files
List files in project or team (requires one)
```json
{
  "projectId": "string?",
  "teamId": "string?"
}
```

### 3. `figma_list_all_files` - List All Files
List all files across all teams accessible to token (no params needed)
```json
{}
```

### 4. `figma_get_file_overview` - File Metadata
Get file info, pages, and stats
```json
{
  "fileKey": "string",
  "version": "string?",
  "branchData": "boolean?"
}
```

### 5. `figma_get_page_context` - Page Node Tree
Get full page node hierarchy
```json
{
  "fileKey": "string",
  "pageId": "string",
  "depth": "number (1-10)?",
  "includeStyles": "boolean?"
}
```

### 6. `figma_get_node_context` - Specific Node
Get detailed node context (auto-converts URL format `1-5729` → `1:5729`)
```json
{
  "fileKey": "string",
  "nodeId": "string",  // Accepts both `1:5729` and `1-5729`
  "depth": "number (1-10)?",
  "includeStyles": "boolean?",
  "includeChildren": "boolean?"
}
```

### 7. `figma_search_design` - Search Design Elements
Search within a file
```json
{
  "query": "string",
  "fileKey": "string",
  "type": "component|frame|text|shape|instance|all?",
  "limit": "number (1-100)?"
}
```

### 8. `figma_get_components` - Component Definitions
Get all components in a file
```json
{
  "fileKey": "string",
  "includeVariants": "boolean?",
  "onlyPublished": "boolean?"
}
```

### 9. `figma_get_design_tokens` - Design Tokens (Styles)
Export styles as design tokens
```json
{
  "fileKey": "string",
  "tokenTypes": "color|text|spacing|border|shadow|opacity|all[]?",
  "format": "json|css|scss|figma?"
}
```

### 10. `figma_get_screenshot` - Node Screenshots
Export node screenshots (auto-converts `selection` IDs)
```json
{
  "fileKey": "string",
  "selection": "string[]",  // Accepts `1-5729` format
  "format": "png|jpg|svg|pdf?",
  "scale": "number (0.5-4)?",
  "backgroundColor": "string (#RRGGBB)?"
}
```

### 11. `figma_get_assets` - Export Assets
Export multiple nodes as images
```json
{
  "fileKey": "string",
  "format": "svg|png|jpg|pdf|webp?",
  "scale": "number (0.5-4)?",
  "ids": "string[]?"  // Auto-discovers exportable if omitted
}
```

### 12. `figma_get_sync_status` - Version Info
Get file version and sync status
```json
{
  "fileKey": "string",
  "includeHistory": "boolean?",
  "limit": "number?"
}
```

### 13. `figma_get_rate_limit_status` - Rate Limit Info
```json
{}
```

### 14. `figma_get_cache_status` - ETag Cache Stats
```json
{}
```

### 15. `figma_clear_cache` - Clear ETag Cache
```json
{}
```

## Parameter Naming Convention

**All parameters use camelCase:**
- `fileKey` (not `file_key` or `file_id`)
- `projectId` / `teamId`
- `nodeId` / `pageId`
- `fileKey` + `selection[]` / `ids[]`

## Node ID Format

**Both formats accepted** (auto-converted):
- API format: `1:5729` (colon)
- URL format: `1-5729` (hyphen) - from browser URLs

## Health & Monitoring

```bash
# Health check (no auth, no rate limit)
GET http://localhost:3000/health

# Rate limit status (requires auth if configured)
GET http://localhost:3000/rate-limit-status
```

## Rate Limits

| Layer | Limit |
|-------|-------|
| Figma API | 30 req/s (per token) |
| Server (per client) | 10 req/s, burst 10 |

Headers returned: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`

## Request Tracing

All responses include: `X-Request-ID` for correlation

## Docker Deployment

```bash
# Build
docker compose up -d --build

# Or manual
docker build -t figma-mcp .
docker run -d -p 3000:3000 -e FIGMA_ACCESS_TOKEN=figd_xxx figma-mcp
```

## Debugging Permissions

On startup, server logs token info:
```
Figma token permissions
  user: "your-handle"
  userId: "123456"
  teams: [{id, name, handle}]
  teamCount: 0  # 0 = only personal drafts access
```

**404 errors usually mean:**
- Token has `teamCount: 0` → file in team workspace, move to Drafts
- Wrong `fileKey` → get new key from Drafts file URL

## Example Workflow

```bash
# 1. Get file overview
figma_get_file_overview({ fileKey: "NEW_KEY_FROM_DRAFTS" })

# 2. Search for components
figma_search_design({ query: "button", fileKey: "KEY", type: "component" })

# 3. Get specific component
figma_get_node_context({ fileKey: "KEY", nodeId: "1:5729" })

# 3. Get design tokens as CSS
figma_get_design_tokens({ fileKey: "KEY", format: "css" })

# 4. Get screenshots
figma_get_screenshot({ fileKey: "KEY", selection: ["1:5729", "1:5730"] })
```

## Error Codes

| Code | Meaning | Action |
|------|---------|--------|
| 401 | Unauthorized | Check `FIGMA_ACCESS_TOKEN` |
| 403 | Forbidden | Token lacks permission / expired |
| 404 | Not Found | Wrong fileKey or no access |
| 429 | Rate Limited | Wait, check `Retry-After` |
| 400 | Bad Request | Check parameter names (camelCase) |

## Caching

- **ETag Cache**: 5 min TTL, 100 entries max, 304 Not Modified support
- **Request Store**: In-memory map of parsed MCP requests by request ID
- **Rate Limiter**: Token bucket per client (10 req/s, burst 10)
- All caches are in-memory (cleared on restart)