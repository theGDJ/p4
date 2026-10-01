package in.bissaathi.config;

import in.bissaathi.auth.PasswordService;
import in.bissaathi.common.AppProperties;
import in.bissaathi.common.Language;
import in.bissaathi.common.Persona;
import in.bissaathi.common.Role;
import in.bissaathi.domain.UserEntity;
import in.bissaathi.repo.UserRepository;
import java.security.SecureRandom;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;
import org.springframework.core.env.Environment;

/**
 * Demo accounts for local development only.
 *
 * Two rules, both learned from how easy it is to get this wrong:
 *  - Guarded twice: by profile AND by property, so a copied environment file cannot
 *    seed accounts into a production database.
 *  - The password is either the operator-supplied SEED_DEMO_PASSWORD or a random one
 *    printed once to the console. A hard-coded default like `password123` would end up
 *    in a deployed container, and a secret in the repository is not a secret.
 */
@Configuration
@Profile({"!prod & !production"})
@ConditionalOnProperty(prefix = "bissaathi.seed", name = "enabled", havingValue = "true")
public class DevSeedRunner {

  private static final Logger log = LoggerFactory.getLogger(DevSeedRunner.class);
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final char[] ALPHABET =
      "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%".toCharArray();

  @Bean
  public ApplicationRunner seedDemoUsers(UserRepository users, PasswordService passwords, AppProperties properties, Environment environment) {
    return args -> {
      String password = properties.seed().password();
      boolean generated = password == null || password.isBlank();
      if (generated) password = randomPassword();

      UserEntity admin = upsert(users, passwords, "admin@example.org", "BIS Admin", password, Role.ADMIN, Persona.STUDENT_ENGINEER, Language.en);
      UserEntity manager = upsert(users, passwords, "content@example.org", "Content Manager", password, Role.CONTENT_MANAGER, Persona.STUDENT_ENGINEER, Language.en);
      UserEntity demo = upsert(users, passwords, "demo@example.org", "Demo User", password, Role.USER, Persona.CONSUMER, Language.hi);

      if (admin == null && manager == null && demo == null) {
        log.info("demo accounts already present; nothing seeded");
        return;
      }
      log.warn("DEMO ACCOUNTS SEEDED (development only, profile={})", String.join(",", environment.getActiveProfiles()));
      log.warn("  admin@example.org / content@example.org / demo@example.org");
      if (generated) {
        // Printed once, never stored in the repository, and regenerated on a fresh
        // database. Anyone who needs it reads it from the container log.
        log.warn("  shared password (generated for this boot): {}", password);
      } else {
        log.warn("  shared password: taken from SEED_DEMO_PASSWORD");
      }
    };
  }

  private static UserEntity upsert(
      UserRepository users,
      PasswordService passwords,
      String email,
      String fullName,
      String password,
      Role role,
      Persona persona,
      Language language) {
    if (users.existsByEmailIgnoreCase(email)) return null;
    UserEntity user = new UserEntity(email, passwords.hash(password), passwords.scheme(), fullName);
    user.grantRole(role);
    if (role == Role.ADMIN) user.grantRole(Role.CONTENT_MANAGER);
    if (role != Role.USER) user.grantRole(Role.USER);
    user.setPersona(persona);
    user.setLanguage(language);
    user.setEmailVerified(true);
    users.save(user);
    return user;
  }

  private static String randomPassword() {
    StringBuilder builder = new StringBuilder(18);
    for (int i = 0; i < 18; i++) {
      builder.append(ALPHABET[RANDOM.nextInt(ALPHABET.length)]);
    }
    // The policy requires a letter and a digit; the alphabet has both, but appending
    // a digit keeps the generated value valid if the alphabet is ever edited.
    return builder.append(RANDOM.nextInt(10)).toString();
  }
}
