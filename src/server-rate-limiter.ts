/**
 * Server-Side Rate Limiter (Per-Client)
 * 
 * Extracted to separate module to avoid starting HTTP server during tests
 */

export class ServerRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number; capacity: number; rate: number }>();
  private readonly defaultRate: number;    // requests per second
  private readonly defaultCapacity: number; // burst capacity
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor(
    requestsPerSecond: number = 10,
    burstCapacity: number = 10
  ) {
    this.defaultRate = requestsPerSecond;
    this.defaultCapacity = burstCapacity;
    
    // Cleanup old buckets every 5 minutes
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    this.cleanupInterval.unref(); // Don't prevent process exit
  }

  private getBucket(key: string) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: this.defaultCapacity,
        lastRefill: Date.now(),
        capacity: this.defaultCapacity,
        rate: this.defaultRate,
      };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }

  private refill(bucket: { tokens: number; lastRefill: number; capacity: number; rate: number }) {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const newTokens = elapsed * (bucket.rate / 1000);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + newTokens);
    bucket.lastRefill = now;
  }

  /**
   * Try to consume a token for the given key
   * @returns { allowed: boolean, remaining: number, resetInMs: number }
   */
  tryConsume(key: string): { allowed: boolean; remaining: number; resetInMs: number } {
    const bucket = this.getBucket(key);
    this.refill(bucket);
    
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        resetInMs: bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / (bucket.rate / 1000)),
      };
    }
    
    return {
      allowed: false,
      remaining: 0,
      resetInMs: Math.ceil((1 - bucket.tokens) / (bucket.rate / 1000)),
    };
  }

  /**
   * Get current status without consuming
   */
  getStatus(key: string): { remaining: number; capacity: number; resetInMs: number } {
    const bucket = this.getBucket(key);
    this.refill(bucket);
    return {
      remaining: Math.floor(bucket.tokens),
      capacity: bucket.capacity,
      resetInMs: bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / (bucket.rate / 1000)),
    };
  }

  private cleanup() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      // Remove buckets inactive for > 10 minutes
      if (now - bucket.lastRefill > 10 * 60 * 1000) {
        this.buckets.delete(key);
      }
    }
  }

  shutdown() {
    clearInterval(this.cleanupInterval);
  }
}