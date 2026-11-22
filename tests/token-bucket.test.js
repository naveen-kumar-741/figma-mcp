/**
 * Tests for TokenBucket rate limiter
 */
import { TokenBucket } from '../src/figma-client.js';
describe('TokenBucket', () => {
    describe('Basic consumption', () => {
        it('allows requests up to burst capacity', () => {
            const bucket = new TokenBucket(10, 10);
            for (let i = 0; i < 10; i++) {
                expect(bucket.tryConsume(1)).toBe(true);
            }
            expect(bucket.tryConsume(1)).toBe(false);
        });
        it('tracks available tokens correctly', () => {
            const bucket = new TokenBucket(5, 5);
            expect(bucket.getAvailableTokens()).toBe(5);
            bucket.tryConsume(2);
            expect(Math.floor(bucket.getAvailableTokens())).toBe(3);
            bucket.tryConsume(1);
            expect(Math.floor(bucket.getAvailableTokens())).toBe(2);
        });
    });
    describe('Refill over time', () => {
        it('refills tokens based on rate', async () => {
            const bucket = new TokenBucket(10, 5); // 10 req/s, burst 5
            // Consume all tokens
            for (let i = 0; i < 5; i++)
                bucket.tryConsume(1);
            expect(bucket.getAvailableTokens()).toBe(0);
            // Wait 500ms - should get ~5 tokens (capped at 5)
            await new Promise(r => setTimeout(r, 550));
            expect(bucket.getAvailableTokens()).toBe(5);
        });
        it('does not exceed capacity', async () => {
            const bucket = new TokenBucket(100, 10);
            // Wait longer than needed to fill
            await new Promise(r => setTimeout(r, 200));
            expect(bucket.getAvailableTokens()).toBe(10); // Capped at capacity
        });
    });
    describe('Blocking consume', () => {
        it('consumes immediately when tokens available', async () => {
            const bucket = new TokenBucket(100, 10);
            const start = Date.now();
            await bucket.consume(1);
            expect(Date.now() - start).toBeLessThan(10); // Near instant
        });
        it('waits for token refill', async () => {
            const bucket = new TokenBucket(20, 2); // 20 req/s = 50ms per token
            // Consume burst
            await bucket.consume(1);
            await bucket.consume(1);
            // Next should wait ~50ms
            const start = Date.now();
            await bucket.consume(1);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(40);
            expect(elapsed).toBeLessThan(100);
        });
    });
    describe('Figma API simulation (30 req/s)', () => {
        it('allows 30 burst requests instantly', async () => {
            const bucket = new TokenBucket(30, 30);
            const start = Date.now();
            for (let i = 0; i < 30; i++) {
                await bucket.consume(1);
            }
            expect(Date.now() - start).toBeLessThan(50); // All instant
        });
        it('31st request waits ~33ms', async () => {
            const bucket = new TokenBucket(30, 30);
            for (let i = 0; i < 30; i++) {
                await bucket.consume(1);
            }
            const start = Date.now();
            await bucket.consume(1);
            const elapsed = Date.now() - start;
            expect(elapsed).toBeGreaterThanOrEqual(25);
            expect(elapsed).toBeLessThan(60);
        });
    });
    describe('getTimeUntilReady', () => {
        it('returns 0 when tokens available', () => {
            const bucket = new TokenBucket(10, 10);
            expect(bucket.getTimeUntilReady(1)).toBe(0);
        });
        it('returns wait time when empty', () => {
            const bucket = new TokenBucket(10, 1); // 10 req/s
            bucket.tryConsume(1);
            // Need 1 token, rate is 10/s = 100ms per token
            expect(bucket.getTimeUntilReady(1)).toBeGreaterThanOrEqual(90);
            expect(bucket.getTimeUntilReady(1)).toBeLessThanOrEqual(110);
        });
    });
    describe('reset', () => {
        it('restores full capacity', () => {
            const bucket = new TokenBucket(5, 5);
            bucket.tryConsume(3);
            expect(bucket.getAvailableTokens()).toBe(2);
            bucket.reset();
            expect(bucket.getAvailableTokens()).toBe(5);
        });
    });
});
//# sourceMappingURL=token-bucket.test.js.map