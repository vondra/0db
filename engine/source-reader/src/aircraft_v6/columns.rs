//! Typed downcasts of `RecordBatch` columns by name. Each helper
//! returns `None` when the column is missing or has the wrong dtype,
//! matching the soft-fail behaviour of the v6 row builders (a malformed
//! batch contributes zero rows rather than panicking the popup).

use arrow::array::*;
use arrow::record_batch::RecordBatch;

pub fn col_u64<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a UInt64Array> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_u16<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a UInt16Array> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_u8<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a UInt8Array> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_i64<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Int64Array> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_f32<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a Float32Array> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_str<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a StringArray> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_list<'a>(batch: &'a RecordBatch, name: &str) -> Option<&'a ListArray> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
pub fn col_fixed_size_binary<'a>(
    batch: &'a RecordBatch,
    name: &str,
) -> Option<&'a FixedSizeBinaryArray> {
    batch.column_by_name(name)?.as_any().downcast_ref()
}
