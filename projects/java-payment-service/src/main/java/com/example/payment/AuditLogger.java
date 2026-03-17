package com.example.payment;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;

public class AuditLogger {

    private static final DateTimeFormatter FORMATTER = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");

    private final Path logFilePath;

    public AuditLogger(Path logFilePath) {
        this.logFilePath = logFilePath;
        try {
            if (!Files.exists(logFilePath.getParent())) {
                Files.createDirectories(logFilePath.getParent());
            }
            if (!Files.exists(logFilePath)) {
                Files.createFile(logFilePath);
            }
        } catch (IOException e) {
            throw new RuntimeException("Failed to initialize audit log file: " + logFilePath, e);
        }
    }

    public void logTransaction(String transactionId, String action, String details) {
        if (transactionId == null || transactionId.isBlank()) {
            throw new IllegalArgumentException("Transaction ID must not be blank");
        }
        if (action == null || action.isBlank()) {
            throw new IllegalArgumentException("Action must not be blank");
        }

        String entry = String.format("[%s] transactionId=%s action=%s details=%s%n",
                LocalDateTime.now().format(FORMATTER),
                transactionId,
                action,
                details != null ? details : "");

        try (BufferedWriter writer = Files.newBufferedWriter(
                logFilePath,
                StandardCharsets.UTF_8,
                StandardOpenOption.APPEND)) {
            writer.write(entry);
        } catch (IOException e) {
            throw new RuntimeException("Failed to write audit log entry for transaction: " + transactionId, e);
        }
    }

    public List<String> readAuditLog() {
        List<String> entries = new ArrayList<>();
        try (BufferedReader reader = Files.newBufferedReader(logFilePath, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (!line.isBlank()) {
                    entries.add(line);
                }
            }
        } catch (IOException e) {
            throw new RuntimeException("Failed to read audit log file: " + logFilePath, e);
        }
        return entries;
    }
}
