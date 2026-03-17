use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

use crate::error::ProcessorError;
use crate::parser::{parse_file, Record};

pub struct Processor {
    input_path: PathBuf,
    output_path: PathBuf,
}

pub struct ProcessingSummary {
    pub total_records: usize,
    pub valid_records: usize,
    pub output_path: PathBuf,
}

impl Processor {
    pub fn new(input: PathBuf, output: PathBuf) -> Self {
        Processor {
            input_path: input,
            output_path: output,
        }
    }

    pub fn run(&self) -> Result<ProcessingSummary, ProcessorError> {
        let records = parse_file(&self.input_path)?;
        let total_records = records.len();

        Self::validate_records(&records)?;

        let transformed: Vec<Record> = records.into_iter().map(Self::transform_record).collect();
        let valid_records = transformed.len();

        let json = serde_json::to_string_pretty(&transformed).map_err(|e| {
            ProcessorError::ParseError(format!("failed to serialize output: {}", e))
        })?;

        let mut output_file = File::create(&self.output_path)?;
        output_file.write_all(json.as_bytes())?;

        Ok(ProcessingSummary {
            total_records,
            valid_records,
            output_path: self.output_path.clone(),
        })
    }

    pub fn validate_records(records: &[Record]) -> Result<(), ProcessorError> {
        for record in records {
            if record.name.trim().is_empty() {
                return Err(ProcessorError::ValidationError(format!(
                    "record {} has an empty name",
                    record.id
                )));
            }
            if record.value < 0.0 {
                return Err(ProcessorError::ValidationError(format!(
                    "record {} has a negative value: {}",
                    record.id, record.value
                )));
            }
        }
        Ok(())
    }

    pub fn transform_record(mut record: Record) -> Record {
        record.name = record.name.trim().to_uppercase();
        record.id = record.id.trim().to_owned();
        record.timestamp = record.timestamp.trim().to_owned();
        record
    }
}
