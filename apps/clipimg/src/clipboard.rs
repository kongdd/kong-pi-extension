use arboard::Clipboard;
use png::{BitDepth, ColorType, Compression, Encoder};

/// 读取剪贴板图像并编成 RGBA PNG。
pub(crate) fn clipboard_png() -> Result<Vec<u8>, String> {
    let image = Clipboard::new()
        .map_err(|e| format!("clipboard unavailable: {e}"))?
        .get_image()
        .map_err(|e| format!("clipboard does not contain an image: {e}"))?;
    let width = u32::try_from(image.width).map_err(|_| "clipboard image is too wide")?;
    let height = u32::try_from(image.height).map_err(|_| "clipboard image is too tall")?;

    let mut output = Vec::with_capacity(image.bytes.len());
    let mut encoder = Encoder::new(&mut output, width, height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(Compression::Fast);
    encoder
        .write_header()
        .and_then(|mut writer| writer.write_image_data(image.bytes.as_ref()))
        .map_err(|error| format!("PNG encoding failed: {error}"))?;
    Ok(output)
}
