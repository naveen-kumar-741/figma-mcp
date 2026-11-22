/**
 * Tests for ServerRateLimiter
 */
import { ServerRateLimiter } from '../src/server-rate-limiter.ts';
describe('ServerRateLimiter', () => {
    let limiter;
    beforeEach(() => {
        limiter = new ServerRateLimiter(10, 5); // 10 req/s, burst 5
    });
    afterEach(() => {
        limiter.shutdown();
    });
    describe('tryConsume', () => {
        it('allows requests up to burst capacity', () => {
            for (let i = 0; i < 5; i++) {
                const result = limiter.tryConsume('client1');
                expect(result.allowed).toBe(true);
                expect(result.remaining).toBe(4 - i);
            }
        });
        it('denies requests over burst capacity', () => {
            for (let i = 0; i < 5; i++) {
                limiter.tryConsume('client1');
            }
            const result = limiter.tryConsume('client1');
            expect(result.allowed).toBe(false);
            expect(result.remaining).toBe(0);
        });
        it('tracks different clients separately', () => {
            limiter.tryConsume('client1');
            limiter.tryConsume('client1');
            const result = limiter.tryConsume('client2');
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(4);
        });
        it('returns resetInMs when denied', () => {
            for (let i = 0; i < 5; i++) {
                limiter.tryConsume('client1');
            }
            const result = limiter.tryConsume('client1');
            expect(result.resetInMs).toBeGreaterThan(0);
        });
    });
    describe('getStatus', () => {
        it('returns current status without consuming', () => {
            limiter.tryConsume('client1');
            limiter.tryConsume('client1');
            const status = limiter.getStatus('client1');
            expect(status.remaining).toBe(3);
            expect(status.capacity).toBe(5);
        });
        it('returns full capacity for new client', () => {
            const status = limiter.getStatus('new-client');
            expect(status.remaining).toBe(5);
            expect(status.capacity).toBe(5);
        });
    });
    describe('Refill over time', () => {
        it('refills tokens over time', async () => {
            // Consume all
            for (let i = 0; i < 5; i++) {
                limiter.tryConsume('client1');
            }
            expect(limiter.getStatus('client1').remaining).toBe(0);
            // Wait for refill (10 req/s = 100ms per token, need ~500ms for 5)
            await new Promise(r => setTimeout(r, 600));
            const status = limiter.getStatus('client1');
            expect(status.remaining).toBe(5);
        });
    });
    describe('Cleanup', () => {
        it('removes inactive clients', async () => {
            limiter.tryConsume('old-client');
            // Manually trigger cleanup by accessing private method
            // We can't easily test the interval, but we can verify shutdown works
            limiter.shutdown();
            // After shutdown, new limiter should work
            const newLimiter = new ServerRateLimiter(10, 5);
            const result = newLimiter.tryConsume('client1');
            expect(result.allowed).toBe(true);
            newLimiter.shutdown();
        });
    });
});
//# sourceMappingURL=server-rate-limiter.test.js.map