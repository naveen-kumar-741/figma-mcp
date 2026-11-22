/**
 * Figma REST API Client
 * 
 * Uses native fetch (Node 18+) with proper error handling,
 * rate limit awareness, and request/response typing.
 */

import { z } from 'zod';
import pino from 'pino';

// Module-level logger for Figma client
const figmaLogger = pino({
  name: 'figma-client',
  level: process.env.FIGMA_LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV !== 'production' ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' },
  } : undefined,
});

// ============================================================================
// Rate Limiter: Token Bucket Algorithm
// ============================================================================

/**
 * Token Bucket rate limiter for Figma API (30 req/s limit)
 * Thread-safe for single-threaded Node.js event loop
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly refillRate: number; // tokens per millisecond
  private readonly capacity: number;
  private readonly waitQueue: Array<{ resolve: () => void; tokens: number }> = [];

  constructor(
    public readonly requestsPerSecond: number = 30,
    public readonly burstCapacity?: number
  ) {
    this.capacity = burstCapacity ?? requestsPerSecond;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.refillRate = requestsPerSecond / 1000; // tokens per ms
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + newTokens);
    this.lastRefill = now;
  }

  /**
   * Try to consume tokens without blocking
   * @returns true if tokens were available
   */
  tryConsume(tokens: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  /**
   * Consume tokens, blocking until available
   * @param tokens - Number of tokens to consume
   * @returns Promise that resolves when tokens are available
   */
  async consume(tokens: number = 1): Promise<void> {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return;
    }

    // Calculate wait time
    const deficit = tokens - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillRate);

    return new Promise((resolve) => {
      this.waitQueue.push({ resolve, tokens });
      setTimeout(() => {
        const idx = this.waitQueue.findIndex(w => w.resolve === resolve);
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1);
          this.consume(tokens).then(resolve);
        }
      }, waitMs);
    });
  }

  /**
   * Get current available tokens (refills first)
   */
  getAvailableTokens(): number {
    this.refill();
    return this.tokens;
  }

  /**
   * Get time until next token available (ms)
   */
  getTimeUntilReady(tokens: number = 1): number {
    this.refill();
    if (this.tokens >= tokens) return 0;
    return Math.ceil((tokens - this.tokens) / this.refillRate);
  }

  /**
   * Reset bucket to full capacity
   */
  reset(): void {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

// ============================================================================
// Types & Schemas
// ============================================================================

const FIGMA_API_BASE = 'https://api.figma.com/v1';

export const FigmaErrorSchema = z.object({
  status: z.number(),
  err: z.string(),
});

export type FigmaError = z.infer<typeof FigmaErrorSchema>;

export interface FigmaClientOptions {
  accessToken: string;
  baseUrl?: string;
  timeout?: number;
}

export interface FileResponse {
  name: string;
  lastModified: string;
  version: string;
  document: FigmaNode;
  components: Record<string, FigmaComponent>;
  styles: Record<string, FigmaStyle>;
  schemaVersion: number;
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  [key: string]: unknown;
}

export interface FigmaComponent {
  key: string;
  name: string;
  description: string;
  componentSetId?: string;
  nodeId: string;
  containingFrame?: FigmaNode;
}

export interface FigmaStyle {
  key: string;
  name: string;
  description: string;
  styleType: 'FILL' | 'TEXT' | 'EFFECT' | 'GRID';
  nodeId: string;
}

export interface FileNodesResponse {
  nodes: Record<string, { document: FigmaNode; components: Record<string, FigmaComponent>; styles: Record<string, FigmaStyle> } | null>;
}

export interface FileImagesResponse {
  images: Record<string, string | null>;
  err?: string;
}

export interface ComponentsResponse {
  components: Record<string, FigmaComponent>;
}

export interface StylesResponse {
  meta: Record<string, FigmaStyle>;
}

export interface ProjectsFilesResponse {
  files: Array<{
    key: string;
    name: string;
    lastModified: string;
    thumbnailUrl: string;
    version: string;
  }>;
}

export interface TeamsProjectsResponse {
  projects: Array<{
    id: string;
    name: string;
  }>;
}

// ============================================================================
// Figma Client Class
// ============================================================================

// ============================================================================
// ETag Cache for Conditional Requests
// ============================================================================

interface CacheEntry<T> {
  data: T;
  etag: string;
  timestamp: number;
  endpoint: string;
}

/**
 * Simple in-memory ETag cache with TTL support
 */
export class ETagCache {
  private cache = new Map<string, CacheEntry<unknown>>();
  private readonly defaultTtl: number;
  private readonly maxSize: number;

  constructor(options: { defaultTtlMs?: number; maxSize?: number } = {}) {
    this.defaultTtl = options.defaultTtlMs ?? 5 * 60 * 1000; // 5 minutes
    this.maxSize = options.maxSize ?? 100;
  }

  private makeKey(endpoint: string, init?: RequestInit): string {
    // Include method and body for non-GET requests
    const method = init?.method || 'GET';
    const body = init?.body ? JSON.stringify(init.body) : '';
    return `${method}:${endpoint}:${body}`;
  }

  get<T>(endpoint: string, init?: RequestInit): { data: T; etag: string } | null {
    const key = this.makeKey(endpoint, init);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.defaultTtl) {
      this.cache.delete(key);
      return null;
    }
    
    return { data: entry.data as T, etag: entry.etag };
  }

  set<T>(endpoint: string, data: T, etag: string, init?: RequestInit): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    
    const key = this.makeKey(endpoint, init);
    this.cache.set(key, {
      data,
      etag,
      timestamp: Date.now(),
      endpoint,
    });
  }

  /**
   * Get cached data without checking ETag (for 304 responses)
   */
  getCached<T>(endpoint: string, init?: RequestInit): T | null {
    const key = this.makeKey(endpoint, init);
    const entry = this.cache.get(key);
    
    if (!entry) return null;
    
    // Check TTL
    if (Date.now() - entry.timestamp > this.defaultTtl) {
      this.cache.delete(key);
      return null;
    }
    
    return entry.data as T;
  }

  has(endpoint: string, init?: RequestInit): boolean {
    const key = this.makeKey(endpoint, init);
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() - entry.timestamp > this.defaultTtl) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  delete(endpoint: string, init?: RequestInit): boolean {
    const key = this.makeKey(endpoint, init);
    return this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): { size: number; maxSize: number; ttlMs: number; entries: string[] } {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.defaultTtl,
      entries: Array.from(this.cache.keys()),
    };
  }
}

// ============================================================================
// Figma Client Class
// ============================================================================

export class FigmaClient {
  private accessToken: string;
  private baseUrl: string;
  private timeout: number;
  private rateLimiter: TokenBucket;
  private readonly maxRetries = 3;
  private readonly baseRetryDelay = 1000; // 1 second
  
  // ETag cache for conditional requests
  private etagCache: ETagCache;
  
  // Last response rate limit headers from Figma
  private lastRateLimitHeaders: {
    limit: number;
    remaining: number;
    reset: number;
  } | null = null;

  constructor(options: FigmaClientOptions) {
    this.accessToken = options.accessToken;
    this.baseUrl = options.baseUrl || FIGMA_API_BASE;
    this.timeout = options.timeout || 30000;
    // Figma API limit: 30 requests/second with burst of 30
    this.rateLimiter = new TokenBucket(30, 30);
    // ETag cache: 5 min TTL, max 100 entries
    this.etagCache = new ETagCache({ defaultTtlMs: 5 * 60 * 1000, maxSize: 100 });
  }

  /**
   * Get current rate limiter status
   */
  getRateLimitStatus(): { available: number; capacity: number; resetInMs: number } {
    return {
      available: Math.floor(this.rateLimiter.getAvailableTokens()),
      capacity: this.rateLimiter['capacity'],
      resetInMs: this.rateLimiter.getTimeUntilReady(1),
    };
  }

  /**
   * Get last Figma API rate limit headers
   */
  getFigmaRateLimitHeaders(): { limit: number; remaining: number; reset: number } | null {
    return this.lastRateLimitHeaders;
  }

  /**
   * Get ETag cache statistics
   */
  getCacheStats(): { size: number; maxSize: number; ttlMs: number; entries: string[] } {
    return this.etagCache.getStats();
  }

  /**
   * Clear ETag cache
   */
  clearCache(): void {
    this.etagCache.clear();
  }

  /**
   * Invalidate cache for a specific endpoint
   */
  invalidateCache(endpoint: string, init?: RequestInit): boolean {
    return this.etagCache.delete(endpoint, init);
  }

  private async request<T>(endpoint: string, init?: RequestInit): Promise<T> {
    // Wait for rate limiter token
    await this.rateLimiter.consume(1);

    const url = `${this.baseUrl}${endpoint}`;
    const method = init?.method || 'GET';
    const isGetRequest = method === 'GET';
    let attempt = 0;

    // Check ETag cache for GET requests
    let cachedEntry: { data: T; etag: string } | null = null;
    if (isGetRequest) {
      cachedEntry = this.etagCache.get<T>(endpoint, init);
    }

    while (true) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      try {
        // Build headers with conditional request support
        const headers = new Headers();
        headers.set('Authorization', `Bearer ${this.accessToken}`);
        headers.set('Content-Type', 'application/json');
        
        // Merge any custom headers from init
        if (init?.headers) {
          const customHeaders = new Headers(init.headers);
          customHeaders.forEach((value, key) => {
            headers.set(key, value);
          });
        }

        // Add If-None-Match for conditional GET requests
        if (isGetRequest && cachedEntry) {
          headers.set('If-None-Match', cachedEntry.etag);
        }

        const response = await fetch(url, {
          ...init,
          headers,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        // Handle 304 Not Modified - return cached data
        if (response.status === 304) {
          figmaLogger.debug({ endpoint }, 'Figma API cache hit (304)');
          const cachedData = this.etagCache.getCached<T>(endpoint, init);
          if (cachedData) {
            return cachedData;
          }
          // Cache miss after 304 (shouldn't happen), fall through to refetch
        }

        // Handle rate limit response (429)
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          const resetHeader = response.headers.get('X-RateLimit-Reset');
          
          let waitMs = this.baseRetryDelay * Math.pow(2, attempt); // Exponential backoff
          
          if (retryAfter) {
            waitMs = Math.max(waitMs, parseInt(retryAfter, 10) * 1000);
          } else if (resetHeader) {
            const resetTime = parseInt(resetHeader, 10) * 1000;
            waitMs = Math.max(waitMs, resetTime - Date.now());
          }

          figmaLogger.warn({ attempt: attempt + 1, maxRetries: this.maxRetries, waitMs, endpoint }, 'Figma API rate limited');
          
          if (attempt >= this.maxRetries) {
            throw new FigmaApiError(429, 'Rate limit exceeded after max retries');
          }
          
          await new Promise(r => setTimeout(r, waitMs));
          attempt++;
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage: string;
          try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.err || errorText;
          } catch {
            errorMessage = errorText;
          }
          throw new FigmaApiError(response.status, errorMessage, endpoint);
        }

        // Capture Figma rate limit headers
        const limit = response.headers.get('X-RateLimit-Limit');
        const remaining = response.headers.get('X-RateLimit-Remaining');
        const reset = response.headers.get('X-RateLimit-Reset');
        
        if (limit && remaining && reset) {
          this.lastRateLimitHeaders = {
            limit: parseInt(limit, 10),
            remaining: parseInt(remaining, 10),
            reset: parseInt(reset, 10) * 1000, // Convert to ms
          };
        }

        // Capture and store ETag for GET requests
        if (isGetRequest) {
          const etag = response.headers.get('ETag');
          if (etag) {
            const data = await response.json() as T;
            this.etagCache.set(endpoint, data, etag, init);
            return data;
          }
        }

        return await response.json() as T;
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof FigmaApiError) throw error;
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw new FigmaApiError(408, 'Request timeout', endpoint);
        }
        // Network errors - retry with backoff
        if (attempt < this.maxRetries) {
          const waitMs = this.baseRetryDelay * Math.pow(2, attempt);
          figmaLogger.warn({ attempt: attempt + 1, maxRetries: this.maxRetries, waitMs, endpoint, error: String(error) }, 'Figma API network error, retrying');
          await new Promise(r => setTimeout(r, waitMs));
          attempt++;
          continue;
        }
        throw new FigmaApiError(0, `Network error: ${error instanceof Error ? error.message : String(error)}`, endpoint);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // File Operations
  // ---------------------------------------------------------------------------

  async getFile(fileKey: string, options?: { version?: string; branchData?: boolean; geometry?: 'paths' }): Promise<FileResponse> {
    const params = new URLSearchParams();
    if (options?.version) params.set('version', options.version);
    if (options?.branchData) params.set('branch_data', 'true');
    if (options?.geometry) params.set('geometry', options.geometry);
    
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<FileResponse>(`/files/${fileKey}${query}`);
  }

  async getFileNodes(fileKey: string, nodeIds: string[], options?: { depth?: number; geometry?: 'paths' }): Promise<FileNodesResponse> {
    const params = new URLSearchParams();
    params.set('ids', nodeIds.join(','));
    if (options?.depth) params.set('depth', String(options.depth));
    if (options?.geometry) params.set('geometry', options.geometry);
    
    return this.request<FileNodesResponse>(`/files/${fileKey}/nodes?${params.toString()}`);
  }

  async getFileImages(
    fileKey: string, 
    nodeIds: string[], 
    options?: { format?: 'png' | 'jpg' | 'svg' | 'pdf'; scale?: number; useAbsoluteBounds?: boolean }
  ): Promise<FileImagesResponse> {
    const params = new URLSearchParams();
    params.set('ids', nodeIds.join(','));
    if (options?.format) params.set('format', options.format);
    if (options?.scale) params.set('scale', String(options.scale));
    if (options?.useAbsoluteBounds) params.set('use_absolute_bounds', 'true');
    
    return this.request<FileImagesResponse>(`/files/${fileKey}/images?${params.toString()}`);
  }

  // ---------------------------------------------------------------------------
  // Component Operations
  // ---------------------------------------------------------------------------

  async getFileComponents(fileKey: string): Promise<ComponentsResponse> {
    return this.request<ComponentsResponse>(`/files/${fileKey}/components`);
  }

  async getComponent(componentKey: string): Promise<{ component: FigmaComponent }> {
    return this.request<{ component: FigmaComponent }>(`/components/${componentKey}`);
  }

  // ---------------------------------------------------------------------------
  // Style/Design Token Operations
  // ---------------------------------------------------------------------------

  async getFileStyles(fileKey: string): Promise<StylesResponse> {
    return this.request<StylesResponse>(`/files/${fileKey}/styles`);
  }

  async getStyle(styleKey: string): Promise<{ style: FigmaStyle }> {
    return this.request<{ style: FigmaStyle }>(`/styles/${styleKey}`);
  }

  // ---------------------------------------------------------------------------
  // Project & Team Operations
  // ---------------------------------------------------------------------------

  async getProjectFiles(projectId: string): Promise<ProjectsFilesResponse> {
    return this.request<ProjectsFilesResponse>(`/projects/${projectId}/files`);
  }

  async getTeamProjects(teamId: string): Promise<TeamsProjectsResponse> {
    return this.request<TeamsProjectsResponse>(`/teams/${teamId}/projects`);
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  async validateToken(): Promise<boolean> {
    try {
      await this.request<{ user: { id: string } }>('/me');
      return true;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Error Class
// ============================================================================

export class FigmaApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = 'FigmaApiError';
  }

  isNotFound(): boolean {
    return this.status === 404;
  }

  isUnauthorized(): boolean {
    return this.status === 401 || this.status === 403;
  }

  isRateLimited(): boolean {
    return this.status === 429;
  }

  isTimeout(): boolean {
    return this.status === 408;
  }
}

// ============================================================================
// Singleton Factory
// ============================================================================

let figmaClientInstance: FigmaClient | null = null;

export function createFigmaClient(accessToken?: string): FigmaClient {
  const token = accessToken || process.env.FIGMA_ACCESS_TOKEN;
  
  if (!token) {
    throw new Error('FIGMA_ACCESS_TOKEN environment variable is required');
  }
  
  figmaClientInstance = new FigmaClient({ accessToken: token });
  return figmaClientInstance;
}

export function getFigmaClient(): FigmaClient {
  if (!figmaClientInstance) {
    return createFigmaClient();
  }
  return figmaClientInstance;
}