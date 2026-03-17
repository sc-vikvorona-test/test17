from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

PAYMENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT,
    amount REAL,
    currency TEXT,
    status TEXT,
    payer_id TEXT,
    payee_id TEXT,
    created_at TEXT,
    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""

AUDIT_RECORDS_SCHEMA = """
CREATE TABLE IF NOT EXISTS audit_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_id TEXT,
    entity_table TEXT,
    changed_by TEXT,
    changed_at TEXT,
    old_value TEXT,
    new_value TEXT,
    inserted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
"""


class Database:
    def __init__(self, db_path: Path) -> None:
        self._db_path = db_path
        self._connection: sqlite3.Connection | None = None

    def initialize(self) -> None:
        self._connection = sqlite3.connect(self._db_path)
        self._connection.row_factory = sqlite3.Row
        with self._connection:
            self._connection.execute(PAYMENTS_SCHEMA)
            self._connection.execute(AUDIT_RECORDS_SCHEMA)
        logger.info("Database initialized at %s", self._db_path)

    def _insert_record(self, table: str, record: dict) -> None:
        if self._connection is None:
            raise RuntimeError("Database is not initialized. Call initialize() first.")
        columns = ", ".join(record.keys())
        placeholders = ", ".join("?" for _ in record)
        sql = f"INSERT INTO {table} ({columns}) VALUES ({placeholders})"
        with self._connection:
            self._connection.execute(sql, list(record.values()))

    def insert_payment_record(self, record: dict) -> None:
        payment_fields = {
            "transaction_id", "amount", "currency", "status",
            "payer_id", "payee_id", "created_at",
        }
        filtered = {k: v for k, v in record.items() if k in payment_fields}
        self._insert_record("payments", filtered)
        logger.debug("Inserted payment record with transaction_id=%s", record.get("transaction_id"))

    def insert_audit_record(self, record: dict) -> None:
        audit_fields = {
            "event_type", "entity_id", "entity_table",
            "changed_by", "changed_at", "old_value", "new_value",
        }
        filtered = {k: v for k, v in record.items() if k in audit_fields}
        self._insert_record("audit_records", filtered)
        logger.debug("Inserted audit record with event_type=%s", record.get("event_type"))

    def get_record_count(self, table: str) -> int:
        if self._connection is None:
            raise RuntimeError("Database is not initialized. Call initialize() first.")
        cursor = self._connection.execute(f"SELECT COUNT(*) FROM {table}")
        row = cursor.fetchone()
        return int(row[0])

    def close(self) -> None:
        if self._connection is not None:
            self._connection.close()
            self._connection = None
            logger.info("Database connection closed")
