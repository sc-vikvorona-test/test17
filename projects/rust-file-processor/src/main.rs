use std::path::PathBuf;
use std::process;

mod error;
mod parser;
mod processor;

use processor::Processor;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("Usage: {} <input-file> <output-file>", args[0]);
        process::exit(1);
    }

    let input_path = PathBuf::from(&args[1]);
    let output_path = PathBuf::from(&args[2]);

    let proc = Processor::new(input_path, output_path);

    match proc.run() {
        Ok(summary) => {
            println!(
                "Processing complete: {}/{} records written to {}",
                summary.valid_records,
                summary.total_records,
                summary.output_path.display()
            );
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            process::exit(1);
        }
    }
}
