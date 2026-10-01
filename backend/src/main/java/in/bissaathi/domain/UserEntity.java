package in.bissaathi.domain;

import in.bissaathi.common.Language;
import in.bissaathi.common.Persona;
import in.bissaathi.common.Role;
import jakarta.persistence.CollectionTable;
import jakarta.persistence.Column;
import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import java.time.Instant;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;

/**
 * A registered account.
 *
 * Roles are loaded eagerly and re-read from the database on every request: a role
 * change or a revocation must take effect immediately, not when a cached token
 * expires (§4).
 */
@Entity
@Table(
    name = "users",
    uniqueConstraints = @UniqueConstraint(name = "users_email_key", columnNames = "email"))
public class UserEntity {

  @Id
  @GeneratedValue
  @Column(name = "id", updatable = false, nullable = false)
  private UUID id;

  /** Stored lowercased; the DB CHECK constraint enforces it too. */
  @Column(name = "email", nullable = false, length = 254)
  private String email;

  @Column(name = "password_hash", nullable = false, length = 255)
  private String passwordHash;

  @Column(name = "password_scheme", nullable = false, length = 16)
  private String passwordScheme = "argon2id";

  @Column(name = "full_name", nullable = false, length = 120)
  private String fullName;

  @Enumerated(EnumType.STRING)
  @Column(name = "persona", length = 32)
  private Persona persona;

  @Enumerated(EnumType.STRING)
  @Column(name = "language", nullable = false, length = 8)
  private Language language = Language.en;

  @Column(name = "email_verified", nullable = false)
  private boolean emailVerified = false;

  @Column(name = "failed_login_attempts", nullable = false)
  private short failedLoginAttempts = 0;

  @Column(name = "locked_until")
  private Instant lockedUntil;

  @Column(name = "last_login_at")
  private Instant lastLoginAt;

  @Column(name = "deactivated_at")
  private Instant deactivatedAt;

  @ElementCollection(fetch = FetchType.EAGER)
  @CollectionTable(name = "user_roles", joinColumns = @JoinColumn(name = "user_id"))
  @Column(name = "role_id")
  private Set<Short> roleIds = new HashSet<>();

  @CreationTimestamp
  @Column(name = "created_at", nullable = false, updatable = false)
  private Instant createdAt;

  @UpdateTimestamp
  @Column(name = "updated_at", nullable = false)
  private Instant updatedAt;

  protected UserEntity() {
    // JPA
  }

  public UserEntity(String email, String passwordHash, String passwordScheme, String fullName) {
    this.email = email;
    this.passwordHash = passwordHash;
    this.passwordScheme = passwordScheme;
    this.fullName = fullName;
  }

  /**
   * Role ids are stored as smallints because user_roles references the closed
   * `roles` table. The mapping is fixed by V1__init.sql: 1=USER, 2=CONTENT_MANAGER,
   * 3=ADMIN.
   */
  private static short roleId(Role role) {
    return switch (role) {
      case USER -> 1;
      case CONTENT_MANAGER -> 2;
      case ADMIN -> 3;
    };
  }

  private static Role roleOf(short id) {
    return switch (id) {
      case 2 -> Role.CONTENT_MANAGER;
      case 3 -> Role.ADMIN;
      default -> Role.USER;
    };
  }

  public Set<Role> roles() {
    Set<Role> roles = new HashSet<>();
    for (Short id : roleIds) {
      roles.add(roleOf(id));
    }
    // Every account is at least a USER, even if the join row is somehow missing.
    if (roles.isEmpty()) roles.add(Role.USER);
    return roles;
  }

  public void grantRole(Role role) {
    roleIds.add(roleId(role));
  }

  public void revokeRole(Role role) {
    roleIds.remove(roleId(role));
  }

  public boolean hasRole(Role required) {
    for (Role held : roles()) {
      if (held.implies(required)) return true;
    }
    return false;
  }

  public boolean isLocked(Instant now) {
    return lockedUntil != null && lockedUntil.isAfter(now);
  }

  /** Records a failed attempt and applies lockout when the threshold is reached. */
  public void registerFailedAttempt(int maxAttempts, int lockMinutes, Instant now) {
    failedLoginAttempts = (short) (failedLoginAttempts + 1);
    if (failedLoginAttempts >= maxAttempts) {
      lockedUntil = now.plusSeconds(lockMinutes * 60L);
    }
  }

  public void registerSuccessfulLogin(Instant now) {
    failedLoginAttempts = 0;
    lockedUntil = null;
    lastLoginAt = now;
  }

  /* ------------------------------------------------------------- accessors */

  public UUID getId() { return id; }
  public String getEmail() { return email; }
  public String getPasswordHash() { return passwordHash; }
  public String getPasswordScheme() { return passwordScheme; }
  public String getFullName() { return fullName; }
  public Persona getPersona() { return persona; }
  public Language getLanguage() { return language; }
  public boolean isEmailVerified() { return emailVerified; }
  public short getFailedLoginAttempts() { return failedLoginAttempts; }
  public Instant getLockedUntil() { return lockedUntil; }
  public Instant getLastLoginAt() { return lastLoginAt; }
  public Instant getCreatedAt() { return createdAt; }

  public void setEmail(String email) { this.email = email; }
  public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }
  public void setPasswordScheme(String passwordScheme) { this.passwordScheme = passwordScheme; }
  public void setFullName(String fullName) { this.fullName = fullName; }
  public void setPersona(Persona persona) { this.persona = persona; }
  public void setLanguage(Language language) { this.language = language; }
  public void setEmailVerified(boolean emailVerified) { this.emailVerified = emailVerified; }
  public void setLockedUntil(Instant lockedUntil) { this.lockedUntil = lockedUntil; }
  public void setDeactivatedAt(Instant deactivatedAt) { this.deactivatedAt = deactivatedAt; }
}
