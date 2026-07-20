//! tile-store-transaction — internal durable fence for a scoped manual store update.

use std::path::Path;

use anyhow::{bail, Context, Result};
use tile_painter::pyramid::require_incremental_pyramid_levels;
use tile_painter::tile_store::StoreUpdateFence;

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command, store_root, base_zoom, dst_zoom, layer_names] if command == "preflight" => {
            let base_zoom: u8 = base_zoom.parse().context("base zoom must be a number")?;
            let dst_zoom: u8 = dst_zoom.parse().context("destination zoom must be a number")?;
            let layers: Vec<&str> = layer_names
                .split(',')
                .filter(|layer| !layer.is_empty())
                .collect();
            if layers.is_empty() {
                bail!("preflight needs at least one layer");
            }
            for layer in layers {
                if layer.contains('/') || layer == "." || layer == ".." {
                    bail!("unsafe layer name {layer:?}");
                }
                require_incremental_pyramid_levels(
                    &Path::new(store_root).join(layer),
                    base_zoom,
                    dst_zoom,
                )
                .with_context(|| format!("preflight incremental {layer} pyramid"))?;
            }
            Ok(())
        }
        [command, store_root, descriptor] if command == "begin" => {
            let token = StoreUpdateFence::begin(Path::new(store_root), descriptor)?;
            println!("{token}");
            Ok(())
        }
        [command, store_root, token] if command == "finish" => {
            StoreUpdateFence::finish(Path::new(store_root), token)
                .context("finish scoped store transaction")
        }
        _ => bail!(
            "usage: tile-store-transaction preflight <store-root> <base-zoom> <dst-zoom> <layer,...>\n       \
             tile-store-transaction begin <store-root> <descriptor>\n       \
             tile-store-transaction finish <store-root> <owner-token>"
        ),
    }
}
