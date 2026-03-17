from __future__ import annotations

import csv
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def load_csv_file(file_path: Path, base_dir: Path | None = None) -> list[dict]:
    resolved = file_path.resolve()

    if base_dir is not None:
        resolved_base = base_dir.resolve()
        if not str(resolved).startswith(str(resolved_base)):
            raise ValueError(
                f"File path {file_path} is outside the allowed base directory {base_dir}"
            )

    if not resolved.exists():
        raise FileNotFoundError(f"CSV file not found: {file_path}")

    if not resolved.is_file():
        raise ValueError(f"Path is not a file: {file_path}")

    records: list[dict] = []
    with resolved.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            records.append(dict(row))

    logger.debug("Loaded %d records from %s", len(records), file_path)
    return records


def discover_files(input_dir: Path, pattern: str = "*.csv") -> list[Path]:
    if not input_dir.exists():
        raise FileNotFoundError(f"Input directory not found: {input_dir}")

    if not input_dir.is_dir():
        raise ValueError(f"Path is not a directory: {input_dir}")

    files = sorted(input_dir.glob(pattern))
    logger.info("Discovered %d files matching '%s' in %s", len(files), pattern, input_dir)
    return files


def load_batch(file_paths: list[Path], base_dir: Path | None = None) -> list[dict]:
    all_records: list[dict] = []
    for file_path in file_paths:
        try:
            records = load_csv_file(file_path, base_dir=base_dir)
            all_records.extend(records)
        except (FileNotFoundError, ValueError) as exc:
            logger.warning("Skipping %s: %s", file_path, exc)

    logger.info("Loaded %d total records from %d files", len(all_records), len(file_paths))
    return all_records
