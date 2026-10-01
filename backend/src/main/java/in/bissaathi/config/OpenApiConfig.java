package in.bissaathi.config;

import io.swagger.v3.oas.models.Components;
import io.swagger.v3.oas.models.OpenAPI;
import io.swagger.v3.oas.models.info.Info;
import io.swagger.v3.oas.models.info.License;
import io.swagger.v3.oas.models.security.SecurityRequirement;
import io.swagger.v3.oas.models.security.SecurityScheme;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * OpenAPI metadata.
 *
 * docs/API.md remains the authoritative contract; this document is generated from
 * the running code so that a drift between the two is visible rather than silent.
 */
@Configuration
public class OpenApiConfig {

  @Bean
  public OpenAPI bisSaathiOpenApi() {
    return new OpenAPI()
        .info(
            new Info()
                .title("BIS-Saathi API")
                .version("0.1.0")
                .description(
                    "Source-grounded bilingual assistant for Indian Standards and BIS services. "
                        + "The authoritative contract is docs/API.md in the repository root. "
                        + "Answers are informational and are never a certification decision.")
                .license(new License().name("See repository LICENSE")))
        .components(
            new Components()
                .addSecuritySchemes(
                    "bearerAuth",
                    new SecurityScheme()
                        .type(SecurityScheme.Type.HTTP)
                        .scheme("bearer")
                        .bearerFormat("JWT")
                        .description("15-minute HS256 access token obtained from /auth/login or /auth/refresh.")))
        .addSecurityItem(new SecurityRequirement().addList("bearerAuth"));
  }
}
