package in.bissaathi.config;

import in.bissaathi.common.AppProperties;
import in.bissaathi.common.ErrorCode;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

/**
 * Spring Security for the stateless bearer-token + rotating-cookie design (§8).
 *
 * Why the filter chain looks unusual:
 *  - Stateless. There is no HttpSession anywhere, so session fixation is not a
 *    category of bug this application can have.
 *  - CSRF is disabled for header-authenticated routes and enabled only for the
 *    cookie-borne auth routes. A bearer token in an Authorization header is not
 *    attached cross-site by a browser, so requiring a CSRF token there buys nothing
 *    and breaks non-browser clients.
 *  - Everything under /api/v1 that is not on the explicit public list requires an
 *    authenticated request. The default is closed; each public path is an
 *    intentional, reviewed exception.
 */
@Configuration
@EnableWebSecurity
public class SecurityConfig {

  private static final String API = "/api/v1";

  private final AppProperties properties;

  public SecurityConfig(AppProperties properties) {
    this.properties = properties;
  }

  @Bean
  public SecurityFilterChain filterChain(HttpSecurity http, BisSaathiAuthenticationFilter authenticationFilter)
      throws Exception {
    http
        // The bearer token is the credential; a JSESSIONID must never appear.
        // CSRF is implemented by CsrfFilter rather than by Spring's repository, so
        // that the double-submit rule is identical to the documented contract and to
        // the mock API the frontend was built against. Two mechanisms in series would
        // both have to be satisfied and would disagree about token format.
        .csrf(csrf -> csrf.disable())
        .cors(cors -> {})
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .headers(
            headers ->
                headers
                    .httpStrictTransportSecurity(hsts -> hsts.includeSubDomains(true).maxAgeInSeconds(31_536_000))
                    .frameOptions(frame -> frame.deny())
                    .contentTypeOptions(options -> {})
                    .referrerPolicy(referrer -> referrer.policy(org.springframework.security.web.header.writers
                        .ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER)))
        .authorizeHttpRequests(auth -> auth
            // ---------------------------------------------------------- public
            .requestMatchers(HttpMethod.GET, API + "/health", API + "/health/live", API + "/health/ready")
            .permitAll()
            .requestMatchers(HttpMethod.GET, API + "/meta/bootstrap")
            .permitAll()
            .requestMatchers(
                API + "/auth/register",
                API + "/auth/login",
                API + "/auth/logout",
                API + "/auth/refresh",
                API + "/auth/password/reset-request",
                API + "/auth/password/reset")
            .permitAll()
            // OpenAPI is served only when explicitly enabled; in production it is off.
            .requestMatchers(HttpMethod.GET, API + "/openapi.json", API + "/docs/**", "/v3/api-docs/**",
                "/swagger-ui/**")
            .permitAll()
            // --------------------------------------------------------- all else
            .anyRequest()
            .authenticated())
        .exceptionHandling(handling -> handling
            .authenticationEntryPoint((request, response, ex) ->
                writeError(response, ErrorCode.UNAUTHENTICATED, "Authentication required."))
            .accessDeniedHandler((request, response, ex) ->
                writeError(response, ErrorCode.FORBIDDEN, "You do not have access to this resource.")))
        .addFilterBefore(new CsrfFilter(properties), BisSaathiAuthenticationFilter.class)
        .addFilterBefore(authenticationFilter, org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter.class);

    return http.build();
  }

  private static void writeError(HttpServletResponse response, ErrorCode code, String message) throws java.io.IOException {
    response.setStatus(code.status().value());
    response.setContentType("application/json;charset=UTF-8");
    response.getWriter()
        .write(
            "{\"error\":{\"code\":\""
                + code.name()
                + "\",\"message\":\""
                + message.replace("\\", "\\\\").replace("\"", "\\\"")
                + "\",\"details\":[]}}");
  }
}
