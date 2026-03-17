from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Config:
    input_dir: Path
    output_db: Path
    batch_size: int = 1000
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> Config:
        input_dir = Path(os.environ.get("PIPELINE_INPUT_DIR", "data/input"))
        output_db = Path(os.environ.get("PIPELINE_OUTPUT_DB", "data/pipeline.db"))
        batch_size = int(os.environ.get("PIPELINE_BATCH_SIZE", "1000"))
        log_level = os.environ.get("PIPELINE_LOG_LEVEL", "INFO")
        return cls(
            input_dir=input_dir,
            output_db=output_db,
            batch_size=batch_size,
            log_level=log_level,
        )

    def validate(self) -> None:
        if not self.input_dir.exists():
            raise ValueError(f"Input directory does not exist: {self.input_dir}")
        if not self.input_dir.is_dir():
            raise ValueError(f"Input path is not a directory: {self.input_dir}")
        if not self.output_db.parent.exists():
            raise ValueError(f"Output database directory does not exist: {self.output_db.parent}")
        if self.batch_size <= 0:
            raise ValueError(f"Batch size must be positive: {self.batch_size}")
        valid_log_levels = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if self.log_level.upper() not in valid_log_levels:
            raise ValueError(f"Invalid log level: {self.log_level}")
