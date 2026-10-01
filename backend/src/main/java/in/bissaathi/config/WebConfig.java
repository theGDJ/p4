package in.bissaathi.config;

import in.bissaathi.common.AppProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * CORS.
 *
 * An explicit allowlist from configuration. The browser never talks to this service
 * from an origin that is not listed, and "*" is refused at boot because every
 * authenticated request is credentialed.
 */
@Configuration
public class WebConfig implements WebMvcConfigurer {

  private final AppProperties properties;

  public WebConfig(AppProperties properties) {
    this.properties = properties;
  }

  @Override
  public void addCorsMappings(CorsRegistry registry) {
    registry
        .addMapping("/api/**")
        .allowedOrigins(properties.cors().allowedOrigins().toArray(String[]::new))
        .allowedMethods("GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS")
        .allowedHeaders("Authorization", "Content-Type", "Accept", "X-XSRF-TOKEN", "X-Trace-Ref")
        .exposedHeaders("X-Trace-Ref", "Retry-After")
        .allowCredentials(true)
        .maxAge(600);
  }
}
