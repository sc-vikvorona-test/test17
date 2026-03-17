from __future__ import annotations

import logging
from typing import Callable

logger = logging.getLogger(__name__)


def normalize_record(record: dict) -> dict:
    normalized: dict = {}
    for key, value in record.items():
        clean_key = key.strip().lower().replace(" ", "_")
        if isinstance(value, str):
            clean_value: str | None = value.strip() or None
        else:
            clean_value = value
        normalized[clean_key] = clean_value
    return normalized


def paginate_records(records: list, page: int, page_size: int) -> list:
    if page < 0:
        raise ValueError(f"Page index must be non-negative: {page}")
    if page_size <= 0:
        raise ValueError(f"Page size must be positive: {page_size}")
    return records[page * page_size : (page + 1) * page_size]


def filter_records(records: list, predicate: Callable[[dict], bool]) -> list:
    return [record for record in records if predicate(record)]


def transform_batch(records: list[dict]) -> list[dict]:
    transformed: list[dict] = []
    for record in records:
        try:
            normalized = normalize_record(record)
            transformed.append(normalized)
        except Exception as exc:
            logger.warning("Failed to transform record %s: %s", record, exc)
    logger.debug("Transformed %d/%d records", len(transformed), len(records))
    return transformed
