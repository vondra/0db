//! Read / write Arrow files for the v6 schemas. Atomic write via a
//! sibling `.tmp` rename — concurrent readers (popup, pipeline) never
//! observe a partially-written file.

use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};

use anyhow::Result;
use arrow::datatypes::Schema;
use arrow::ipc::reader::FileReader;
use arrow::ipc::writer::FileWriter;
use arrow::record_batch::RecordBatch;

use crate::arrow_schemas;

mod airborne;
mod cruise;
mod flights;
mod ground;
mod segments;

pub use airborne::write_airborne;
pub use cruise::write_cruise;
pub use flights::{write_flights, FlightRow};
pub use ground::write_ground;
pub use segments::{read_segments, write_segments};

pub(crate) fn sibling_tmp_path(p: &Path) -> PathBuf {
    let mut name = p
        .file_name()
        .map(|n| n.to_owned())
        .unwrap_or_else(|| std::ffi::OsString::from("anon"));
    name.push(".tmp");
    p.with_file_name(name)
}

pub(crate) fn write_record_batches(
    path: &Path,
    schema: &Schema,
    batches: &[RecordBatch],
) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = sibling_tmp_path(path);
    {
        let f = File::create(&tmp)?;
        let mut w = FileWriter::try_new(f, schema)?;
        for b in batches {
            if b.num_rows() > 0 {
                w.write(b)?;
            }
        }
        w.finish()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub(crate) fn read_all_batches(path: &Path) -> Result<(Schema, Vec<RecordBatch>)> {
    let f = File::open(path)?;
    let r = FileReader::try_new(BufReader::new(f), None)?;
    let schema = r.schema();
    arrow_schemas::assert_v6(schema.metadata())?;
    let mut batches = Vec::new();
    for b in r {
        batches.push(b?);
    }
    Ok(((*schema).clone(), batches))
}

pub fn read_record_batches(path: &Path) -> Result<(Schema, Vec<RecordBatch>)> {
    read_all_batches(path)
}
