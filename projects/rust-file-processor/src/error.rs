use std::fmt;

#[derive(Debug)]
pub enum ProcessorError {
    IoError(std::io::Error),
    ParseError(String),
    ValidationError(String),
}

impl fmt::Display for ProcessorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProcessorError::IoError(e) => write!(f, "I/O error: {}", e),
            ProcessorError::ParseError(msg) => write!(f, "Parse error: {}", msg),
            ProcessorError::ValidationError(msg) => write!(f, "Validation error: {}", msg),
        }
    }
}

impl std::error::Error for ProcessorError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ProcessorError::IoError(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ProcessorError {
    fn from(e: std::io::Error) -> Self {
        ProcessorError::IoError(e)
    }
}
