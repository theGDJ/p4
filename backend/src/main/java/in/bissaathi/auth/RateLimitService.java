package in.bissaathi.auth;

import in.bissaathi.common.ApiException;
import in.bissaathi.common.AppProperties;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

/**
 * Fixed-window rate limiting on the authentication endpoints (§8).
 *
 * Backed by Redis in a real deployment so the limit is shared across instances. When
 * Redis is unavailable the limiter FAILS OPEN for throughput but the account lockout
 * in AuthService still applies — lockout is the security control, rate limiting is
 * the abuse control. That distinction matters: silently disabling lockout because
 * the cache is down would be a security regression, whereas refusing all logins
 * because the cache is down would be an availability regression (R8 says fail
 * loudly, so the degradation is logged at WARN and surfaced on /health/ready).
 */
@Service
public class RateLimitService {

  private static final Logger log = LoggerFactory.getLogger(RateLimitService.class);
  private static final String KEY_PREFIX = "bis:rl:";

  private final StringRedisTemplate redis;
  private final AppProperties properties;
  /** Single-instance fallback, used only when Redis is unreachable. */
  private final ConcurrentHashMap<String, Window> local = new ConcurrentHashMap<>();

  public RateLimitService(StringRedisTemplate redis, AppProperties properties) {
    this.redis = redis;
    this.properties = properties;
  }

  /** Guards login, register, password reset: the credential-guessing surface. */
  public void checkAuth(String key) {
    check("auth:" + key, properties.rateLimit().authMax(), properties.rateLimit().authWindowSeconds());
  }

  /** Guards message sends: the expensive, provider-backed surface. */
  public void checkChat(String key) {
    check("chat:" + key, properties.rateLimit().chatMax(), properties.rateLimit().chatWindowSeconds());
  }

  private void check(String bucket, int max, int windowSeconds) {
    if (!properties.rateLimit().enabled()) return;
    long count;
    long retryAfter = windowSeconds;
    try {
      String redisKey = KEY_PREFIX + bucket + ":" + (System.currentTimeMillis() / 1000 / windowSeconds);
      Long incremented = redis.opsForValue().increment(redisKey);
      count = incremented == null ? 0 : incremented;
      if (count == 1) {
        redis.expire(redisKey, Duration.ofSeconds(windowSeconds + 1L));
      }
      Long ttl = redis.getExpire(redisKey);
      if (ttl != null && ttl > 0) retryAfter = ttl;
    } catch (RuntimeException e) {
      log.warn("rate limiter degraded to in-process counting ({}); Redis unavailable", e.getMessage());
      Window window = local.compute(
          bucket,
          (k, existing) -> {
            long now = System.currentTimeMillis() / 1000 / windowSeconds;
            if (existing == null || existing.epoch() != now) return new Window(now, new AtomicInteger(1));
            existing.hits().incrementAndGet();
            return existing;
          });
      count = window.hits().get();
    }

    if (count > max) {
      throw ApiException.rateLimited(
          "Too many requests. Please wait a moment and try again.", String.valueOf(retryAfter));
    }
  }

  private record Window(long epoch, AtomicInteger hits) {}
}
