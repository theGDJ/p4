package in.bissaathi.auth;

import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.OctetSequenceKey;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import in.bissaathi.common.AppProperties;
import in.bissaathi.common.Role;
import in.bissaathi.domain.UserEntity;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.JwtClaimsSet;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtEncoder;
import org.springframework.security.oauth2.jwt.JwtEncoderParameters;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtEncoder;
import org.springframework.stereotype.Service;

/**
 * Access-token issuing and validation (§8, feature #1).
 *
 * HS256 with a >= 32-byte secret, 15-minute lifetime, held by the client in memory
 * only. A short lifetime is what makes a leaked bearer token tolerable; the
 * long-lived credential is the rotating refresh token in an HttpOnly cookie.
 *
 * The `roles` claim is advisory only. Authorization re-reads roles from the
 * database on every request, so a role revoked after a token was issued takes
 * effect immediately instead of up to 15 minutes later (§4).
 */
@Service
public class JwtService {

  private final AppProperties properties;
  private final JwtEncoder encoder;
  private final JwtDecoder decoder;

  public JwtService(AppProperties properties) {
    this.properties = properties;
    SecretKey key = secretKey(properties.jwt().secret());
    OctetSequenceKey jwk =
        new OctetSequenceKey.Builder(key)
            .keyID("bis-saathi-access")
            .algorithm(com.nimbusds.jose.JWSAlgorithm.HS256)
            .build();
    this.encoder = new NimbusJwtEncoder(new ImmutableJWKSet<>(new JWKSet(jwk)));
    this.decoder = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
  }

  private static SecretKey secretKey(String secret) {
    byte[] bytes = secret.getBytes(StandardCharsets.UTF_8);
    if (bytes.length < 32) {
      // Fail at construction rather than at first use: an under-length HMAC key is a
      // configuration error that must stop the boot (R8).
      throw new IllegalStateException("JWT_SECRET must be at least 32 bytes for HS256.");
    }
    return new SecretKeySpec(bytes, "HmacSHA256");
  }

  /** Issues an access token for the user's CURRENT roles, read from the entity. */
  public IssuedToken issue(UserEntity user, Set<Role> roles) {
    Instant now = Instant.now();
    Instant expiresAt = now.plusSeconds(properties.jwt().accessTtlMinutes() * 60L);

    JwtClaimsSet.Builder claims =
        JwtClaimsSet.builder()
            .issuer(properties.jwt().issuer())
            .audience(List.of(properties.jwt().audience()))
            .subject(user.getId().toString())
            .issuedAt(now)
            .expiresAt(expiresAt)
            .id(UUID.randomUUID().toString())
            .claim("roles", roles.stream().map(Enum::name).sorted().toList())
            .claim("lang", user.getLanguage().name());

    String token = encoder.encode(JwtEncoderParameters.from(claims.build())).getTokenValue();
    return new IssuedToken(token, expiresAt, (int) (expiresAt.getEpochSecond() - now.getEpochSecond()));
  }

  public DecodedToken decode(String token) {
    var jwt = decoder.decode(token);
    String subject = jwt.getSubject();
    List<String> roleNames = jwt.getClaimAsStringList("roles");
    return new DecodedToken(
        UUID.fromString(subject),
        roleNames == null ? Set.of() : roleNames.stream().map(Role::valueOf).collect(java.util.stream.Collectors.toSet()),
        jwt.getExpiresAt() == null ? Instant.EPOCH : jwt.getExpiresAt());
  }

  public String issuer() {
    return properties.jwt().issuer();
  }

  public String audience() {
    return properties.jwt().audience();
  }

  public record IssuedToken(String accessToken, Instant accessExpiresAt, int expiresInSeconds) {}

  public record DecodedToken(UUID userId, Set<Role> roles, Instant expiresAt) {}
}
