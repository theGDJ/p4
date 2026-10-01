# syntax=docker/dockerfile:1
# =============================================================================
#  BIS-Saathi backend — Java 21 / Spring Boot 4.1.1
#
#  ⚠ NEVER BUILT IN THE AUTHORING SANDBOX (no Docker, no JDK, no route to Maven
#  Central — see docs/ENVIRONMENT.md). Treat this as reviewed source until
#  `docker compose build backend` has actually run (R8).
# =============================================================================

# --------------------------------------------------------------- build stage
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace

# Dependency layer first: a source-only change must not re-download the world.
# -T 1C is safe here because the build has no inter-module reactor (single module).
COPY pom.xml ./
RUN --mount=type=cache,target=/root/.m2 mvn -B -q -e dependency:go-offline

COPY src ./src
# Tests run in the image build. Skipping them here would let a broken auth flow ship
# as a green build, and CI is the only place this suite can reach a database.
RUN --mount=type=cache,target=/root/.m2 mvn -B -q package -DskipTests=false

# Extract a layered jar so the (large, slow-changing) dependency layer is cached
# separately from application classes.
RUN java -Djarmode=layertools -jar target/bis-saathi-backend.jar extract --destination /extracted

# ---------------------------------------------------------------- runtime stage
# A JRE-only base: the runtime has no compiler and no Maven, which is one less
# toolchain for a remote code execution finding to use.
FROM eclipse-temurin:21-jre-jammy

# curl is for HEALTHCHECK only; adduser rather than running as root.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --home-dir /app --shell /usr/sbin/nologin appuser

WORKDIR /app

COPY --from=build /extracted/dependencies/ ./
COPY --from=build /extracted/spring-boot-loader/ ./
COPY --from=build /extracted/snapshot-dependencies/ ./
COPY --from=build /extracted/application/ ./

# /tmp is the only writable path: uploads are streamed to object storage in P2, and a
# world-writable volume in the app directory would be a place to drop files.
USER appuser
EXPOSE 8080

# Heap is half the container limit so heap + metaspace + thread stacks + code cache
# stays clear of the cgroup ceiling; exceeding it means an OOM-kill, not an
# OutOfMemoryError, and the failure looks like a mysterious restart.
# MaxRAMFraction was removed in JDK 13+ — MaxRAMPercentage is the supported flag.
ENV JAVA_OPTS="" \
    SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-prod}" \
    SERVER_SHUTDOWN=graceful \
    SPRING_LIFECYCLE_TIMEOUT_PER_SHUTDOWN_PHASE=30s

# The Entrypoint must stay PID 1 so SIGTERM from docker stop reaches the JVM and the
# graceful shutdown can drain in-flight SSE streams.
ENTRYPOINT ["sh", "-c", "exec java $JAVA_OPTS \
  -XX:MaxRAMPercentage=50.0 \
  -XX:+ExitOnOutOfMemoryError \
  -Djava.security.egd=file:/dev/./urandom \
  org.springframework.boot.loader.launch.JarLauncher"]

HEALTHCHECK --interval=15s --timeout=3s --start-period=45s --retries=4 \
  CMD curl -fsS http://127.0.0.1:8080/api/v1/health/live || exit 1
