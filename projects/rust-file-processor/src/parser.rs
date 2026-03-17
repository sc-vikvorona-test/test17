use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::ProcessorError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub name: String,
    pub value: f64,
    pub timestamp: String,
}

pub fn parse_csv_line(line: &str) -> Result<Record, ProcessorError> {
    let fields: Vec<&str> = line.splitn(4, ',').collect();
    if fields.len() != 4 {
        return Err(ProcessorError::ParseError(format!(
            "expected 4 fields, got {}: {:?}",
            fields.len(),
            line
        )));
    }

    let id = fields[0].trim().to_owned();
    let name = fields[1].trim().to_owned();
    let raw_value = fields[2].trim();
    let timestamp = fields[3].trim().to_owned();

    let value = raw_value.parse::<f64>().map_err(|_| {
        ProcessorError::ParseError(format!("invalid numeric value: {:?}", raw_value))
    })?;

    Ok(Record {
        id,
        name,
        value,
        timestamp,
    })
}

pub fn parse_file(path: &Path) -> Result<Vec<Record>, ProcessorError> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let mut records = Vec::new();

    for (line_number, line_result) in reader.lines().enumerate() {
        let line = line_result?;
        if line_number == 0 {
            continue;
        }
        if line.trim().is_empty() {
            continue;
        }
        let record = parse_csv_line(&line).map_err(|e| {
            ProcessorError::ParseError(format!("line {}: {}", line_number + 1, e))
        })?;
        records.push(record);
    }

    Ok(records)
}
