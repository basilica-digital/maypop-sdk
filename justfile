# Rebuild the committed Iroh WebAssembly artifacts after changing iroh/src.
build-iroh:
    cd iroh && cargo build --target wasm32-unknown-unknown --release
    cd iroh && wasm-bindgen target/wasm32-unknown-unknown/release/maypop_iroh.wasm --out-dir prebuilt --out-name iroh-v1 --weak-refs --target web
    cd iroh && wasm-opt --enable-nontrapping-float-to-int --enable-bulk-memory -Os -o prebuilt/iroh-v1_bg.wasm prebuilt/iroh-v1_bg.wasm
