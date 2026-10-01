package in.bissaathi.config;

import in.bissaathi.common.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationListener;
import org.springframework.context.event.ContextRefreshedEvent;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Refuses to boot with an insecure security configuration (§8, R8).
 *
 * A misconfigured deployment that starts successfully and then leaks refresh tokens
 * is far worse than one that fails to start. These checks are fail-loud on purpose.
 */
@Component
public class CookiePropertiesValidator implements ApplicationListener<ContextRefreshedEvent> {

  private static final Logger log = LoggerFactory.getLogger(CookiePropertiesValidator.class);

  /** The development secrets shipped in .env.example. None may reach production. */
  private static final String[] DEV_ONLY_SECRETS = {
    "dev-only-do-not-use-in-production",
    "change-me",
    "changeme",
    "secret"
  };

  private final AppProperties properties;
  private final Environment environment;

  public CookiePropertiesValidator(AppProperties properties, Environment environment) {
    this.properties = properties;
    this.environment = environment;
  }

  @Override
  public void onApplicationEvent(ContextRefreshedEvent event) {
    boolean production = isProduction();

    // 1. The refresh cookie must be HttpOnly + Secure + SameSite. HttpOnly is set
    //    unconditionally in code; Secure and SameSite are configuration, so they
    //    are validated here.
    if (production && !properties.refresh().secure()) {
      throw new IllegalStateException(
          "REFRESH_COOKIE_SECURE must be true in production: the refresh token is a long-lived credential.");
    }
    String sameSite = properties.refresh().sameSite();
    if (!sameSite.equalsIgnoreCase("Lax") && !sameSite.equalsIgnoreCase("Strict")) {
      throw new IllegalStateException(
          "REFRESH_COOKIE_SAMESITE must be Lax or Strict; 'None' would expose the refresh token cross-site.");
    }

    // 2. A short-lived access token is the whole point of the rotation scheme.
    if (properties.jwt().accessTtlMinutes() > 30) {
      throw new IllegalStateException(
          "JWT_ACCESS_TTL_MINUTES must be <= 30; the spec mandates 15 minutes for a bearer token held in memory.");
    }

    // 3. No development secret may be used where real traffic arrives.
    if (production) {
      String secret = properties.jwt().secret();
      if (secret.length() < 32) {
        throw new IllegalStateException("JWT_SECRET must be at least 32 bytes for HS256.");
      }
      String lowered = secret.toLowerCase();
      for (String marker : DEV_ONLY_SECRETS) {
        if (lowered.contains(marker)) {
          throw new IllegalStateException("JWT_SECRET looks like a development placeholder; refusing to start.");
        }
      }
      if (properties.seed().enabled()) {
        throw new IllegalStateException("SEED_DEMO_USERS must not be enabled in production.");
      }
    }

    // 4. CORS must never be a wildcard with credentials in play.
    if (properties.cors().allowedOrigins().stream().anyMatch("*"::equals)) {
      throw new IllegalStateException(
          "CORS_ALLOWED_ORIGINS must not contain '*': credentialed requests require an explicit allowlist.");
    }

    log.info(
        "security configuration accepted: sameSite={} secure={} accessTtl={}m corsOrigins={} mockLlm={}",
        sameSite,
        properties.refresh().secure(),
        properties.jwt().accessTtlMinutes(),
        properties.cors().allowedOrigins().size(),
        properties.rag().isMockLlm());
  }

  private boolean isProduction() {
    for (String profile : environment.getActiveProfiles()) {
      if (profile.equalsIgnoreCase("prod") || profile.equalsIgnoreCase("production")) return true;
    }
    return "production".equalsIgnoreCase(environment.getProperty("SPRING_PROFILES_ACTIVE", ""));
  }
}
