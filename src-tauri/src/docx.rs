//! Minimal Word (.docx) writer for transcript downloads: a title, a subtitle
//! line and one paragraph per turn, with the speaker (and time, when known)
//! in bold. A .docx is a zip of a few XML parts; the zip is written by hand
//! (entries stored, CRC from flate2) so no extra crate is needed.

use serde::Deserialize;
use specta::Type;

/// One paragraph of the exported transcript.
#[derive(Clone, Debug, Deserialize, Type)]
pub struct DocxParagraph {
    /// Bold prefix, e.g. "[03:12] Daniela Botero". None for plain text.
    pub label: Option<String>,
    pub text: String,
}

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;

const DOCUMENT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

const STYLES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="320"/></w:pPr><w:rPr><w:color w:val="666666"/></w:rPr></w:style></w:styles>"#;

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            // Control characters are not allowed in XML 1.0.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

fn run(text: &str, bold: bool) -> String {
    let props = if bold { "<w:rPr><w:b/></w:rPr>" } else { "" };
    // Line breaks inside a paragraph become <w:br/>.
    let body = text
        .split('\n')
        .map(|line| format!(r#"<w:t xml:space="preserve">{}</w:t>"#, escape_xml(line)))
        .collect::<Vec<_>>()
        .join("<w:br/>");
    format!("<w:r>{props}{body}</w:r>")
}

fn paragraph(style: Option<&str>, runs: &str) -> String {
    let props = style
        .map(|s| format!(r#"<w:pPr><w:pStyle w:val="{s}"/></w:pPr>"#))
        .unwrap_or_default();
    format!("<w:p>{props}{runs}</w:p>")
}

fn document_xml(title: &str, subtitle: &str, paragraphs: &[DocxParagraph]) -> String {
    let mut body = paragraph(Some("Title"), &run(title, true));
    if !subtitle.is_empty() {
        body.push_str(&paragraph(Some("Subtitle"), &run(subtitle, false)));
    }
    for p in paragraphs {
        let mut runs = String::new();
        if let Some(label) = p.label.as_deref().filter(|l| !l.is_empty()) {
            runs.push_str(&run(&format!("{label}: "), true));
        }
        runs.push_str(&run(&p.text, false));
        body.push_str(&paragraph(None, &runs));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>"#
    )
}

/// Zip archive with every entry stored (no compression).
fn stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut central = Vec::new();
    for (name, data) in entries {
        let mut crc = flate2::Crc::new();
        crc.update(data);
        let crc = crc.sum();
        let size = data.len() as u32;
        let offset = out.len() as u32;
        let name_len = name.len() as u16;

        // Local file header.
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes()); // version needed
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&0u32.to_le_bytes()); // mod time + date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&name_len.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra length
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);

        // Central directory entry.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes()); // version made by
        central.extend_from_slice(&20u16.to_le_bytes()); // version needed
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u32.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&name_len.to_le_bytes());
        central.extend_from_slice(&[0u8; 12]); // extra, comment, disk, attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name.as_bytes());
    }
    let central_offset = out.len() as u32;
    let count = entries.len() as u16;
    out.extend_from_slice(&central);
    // End of central directory.
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]); // disk numbers
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // comment length
    out
}

/// The bytes of a .docx holding the given transcript.
pub fn build_docx(title: &str, subtitle: &str, paragraphs: &[DocxParagraph]) -> Vec<u8> {
    let document = document_xml(title, subtitle, paragraphs);
    stored_zip(&[
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes()),
        ("_rels/.rels", ROOT_RELS.as_bytes()),
        ("word/_rels/document.xml.rels", DOCUMENT_RELS.as_bytes()),
        ("word/styles.xml", STYLES.as_bytes()),
        ("word/document.xml", document.as_bytes()),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_markup_and_keeps_accents() {
        let xml = document_xml(
            "Presentación <PropZat>",
            "21 oct 2026",
            &[DocxParagraph {
                label: Some("Daniela & Co".into()),
                text: "¿Sí?\u{0007}".into(),
            }],
        );
        assert!(xml.contains("Presentación &lt;PropZat&gt;"));
        assert!(xml.contains("Daniela &amp; Co: "));
        assert!(xml.contains("¿Sí?</w:t>"));
    }

    #[test]
    fn zip_has_all_parts() {
        let bytes = build_docx("T", "", &[]);
        assert_eq!(&bytes[..4], b"PK\x03\x04");
        let tail = &bytes[bytes.len() - 22..];
        assert_eq!(&tail[..4], b"PK\x05\x06");
        assert_eq!(u16::from_le_bytes([tail[10], tail[11]]), 5);
    }
}
