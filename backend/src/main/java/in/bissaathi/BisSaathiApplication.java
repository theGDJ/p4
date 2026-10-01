package in.bissaathi;

import in.bissaathi.common.AppProperties;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;

/**
 * BIS-Saathi — modular monolith entry point (§3).
 *
 * Modules: auth, user, chat, rag, ingestion, standards, certification,
 * hallmarking, labs, product, report, admin, audit, common. Cross-module calls go
 * through interfaces only; a module never reaches into another module's repository.
 *
 * P1 wires auth, user, chat, rag, admin, audit and common. The remaining modules
 * have their tables in V1__init.sql and land in P2-P4.
 */
@SpringBootApplication
@EnableConfigurationProperties(AppProperties.class)
public class BisSaathiApplication {

  public static void main(String[] args) {
    SpringApplication.run(BisSaathiApplication.class, args);
  }
}
