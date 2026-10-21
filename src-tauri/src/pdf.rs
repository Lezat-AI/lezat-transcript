//! Minimal PDF writer for transcript downloads, same layout as the Word file:
//! a title, a date line and one paragraph per turn with the speaker (and
//! time) in bold, plus page numbers. Uses the standard Helvetica fonts (every
//! PDF reader has them, nothing embedded) with WinAnsi encoding, which covers
//! Spanish (á, ñ, ¿, ¡…); anything else (emoji, other scripts) becomes "?".

use std::io::Write;

use crate::docx::DocxParagraph;

const PAGE_W: f32 = 612.0; // US Letter, in points
const PAGE_H: f32 = 792.0;
const MARGIN: f32 = 72.0;
const TEXT_W: f32 = PAGE_W - 2.0 * MARGIN;
const BODY_SIZE: f32 = 11.0;
const BODY_LEADING: f32 = 15.0;
const PARAGRAPH_GAP: f32 = 7.0;
const TITLE_SIZE: f32 = 18.0;
const TITLE_LEADING: f32 = 23.0;
const SUBTITLE_SIZE: f32 = 10.0;
const FOOTER_SIZE: f32 = 9.0;

#[derive(Clone, Copy, PartialEq)]
enum Font {
    Regular,
    Bold,
}

impl Font {
    fn resource(self) -> &'static str {
        match self {
            Font::Regular => "F1",
            Font::Bold => "F2",
        }
    }
}

/// The WinAnsi byte for a character, or `?` when it has none.
fn win_ansi(c: char) -> u8 {
    match c {
        ' '..='~' => c as u8,
        '\u{a0}'..='\u{ff}' => c as u32 as u8,
        '€' => 0x80,
        '‚' => 0x82,
        '„' => 0x84,
        '…' => 0x85,
        '‘' => 0x91,
        '’' => 0x92,
        '“' => 0x93,
        '”' => 0x94,
        '•' => 0x95,
        '–' => 0x96,
        '—' => 0x97,
        '\t' => b' ',
        _ => b'?',
    }
}

/// Helvetica / Helvetica-Bold advance width (1/1000 em) of a WinAnsi byte.
/// Accented letters are as wide as their base letter.
fn width(b: u8, font: Font) -> f32 {
    let base = match b {
        0xc0..=0xc5 => b'A',
        0xc7 => b'C',
        0xc8..=0xcb => b'E',
        0xcc..=0xcf => b'I',
        0xd1 => b'N',
        0xd2..=0xd6 | 0xd8 => b'O',
        0xd9..=0xdc => b'U',
        0xdd => b'Y',
        0xe0..=0xe5 => b'a',
        0xe7 => b'c',
        0xe8..=0xeb => b'e',
        0xec..=0xef => b'i',
        0xf1 => b'n',
        0xf2..=0xf6 | 0xf8 => b'o',
        0xf9..=0xfc => b'u',
        0xfd | 0xff => b'y',
        0xa0 => b' ',
        0xb7 | 0x95 => b'.',
        0x96 => b'-',
        other => other,
    };
    let regular = match base {
        b' ' | b',' | b'.' | b'/' | b':' | b';' | b'!' | b'[' | b']' | b'\\' => 278,
        b'i' | b'j' | b'l' => 222,
        b'f' | b't' | b'I' => 278,
        b'r' | b'(' | b')' | b'-' | b'`' | 0xa1 => 333,
        b'c' | b'k' | b's' | b'v' | b'x' | b'y' | b'z' | b'J' => 500,
        b'm' | b'M' => 833,
        b'w' | b'C' | b'D' | b'H' | b'N' | b'R' | b'U' => 722,
        b'W' => 944,
        b'A' | b'B' | b'E' | b'K' | b'P' | b'S' | b'V' | b'X' | b'Y' | b'&' => 667,
        b'F' | b'T' | b'Z' | 0xbf => 611,
        b'G' | b'O' | b'Q' => 778,
        b'L' => 556,
        b'%' => 889,
        b'@' => 1015,
        b'\'' => 191,
        b'"' => 355,
        b'*' => 389,
        b'+' | b'<' | b'=' | b'>' | b'~' => 584,
        b'^' => 469,
        b'{' | b'}' => 334,
        b'|' => 260,
        0x97 => 1000,
        0x85 => 1000,
        _ => 556,
    } as f32;
    match font {
        Font::Regular => regular,
        Font::Bold => match base {
            b'b' | b'd' | b'g' | b'h' | b'n' | b'o' | b'p' | b'q' | b'u' | b'?' | 0xbf => 611.0,
            b'c' | b'k' | b's' | b'v' | b'x' | b'y' | b'J' => 556.0,
            b'i' | b'j' | b'l' => 278.0,
            b'f' | b't' | b'r' | b'!' | b':' | b';' | b'[' | b']' => 333.0,
            b'w' => 778.0,
            b'm' => 889.0,
            b'A' | b'B' | b'K' => 722.0,
            b'L' => 611.0,
            _ => regular,
        },
    }
}

fn text_width(bytes: &[u8], font: Font, size: f32) -> f32 {
    bytes.iter().map(|&b| width(b, font)).sum::<f32>() * size / 1000.0
}

/// One line of text made of runs in different fonts.
type Line = Vec<(Font, Vec<u8>)>;

/// Builds wrapped lines word by word.
struct Wrapper {
    size: f32,
    max_w: f32,
    lines: Vec<Line>,
    line: Line,
    line_w: f32,
}

impl Wrapper {
    fn break_line(&mut self) {
        self.lines.push(std::mem::take(&mut self.line));
        self.line_w = 0.0;
    }

    fn char_w(&self, b: u8, font: Font) -> f32 {
        width(b, font) * self.size / 1000.0
    }

    fn push_word(&mut self, font: Font, mut word: Vec<u8>) {
        loop {
            let gap = if self.line.is_empty() {
                0.0
            } else {
                self.char_w(b' ', font)
            };
            let w = text_width(&word, font, self.size);
            if self.line_w + gap + w <= self.max_w {
                let mut bytes = if gap > 0.0 { vec![b' '] } else { Vec::new() };
                bytes.extend_from_slice(&word);
                match self.line.last_mut() {
                    Some((f, run)) if *f == font => run.extend_from_slice(&bytes),
                    _ => self.line.push((font, bytes)),
                }
                self.line_w += gap + w;
                return;
            }
            if !self.line.is_empty() {
                self.break_line();
                continue;
            }
            // A single word wider than the line: cut it where it overflows.
            let mut cut = 0;
            let mut acc = 0.0;
            while cut < word.len() && acc + self.char_w(word[cut], font) <= self.max_w {
                acc += self.char_w(word[cut], font);
                cut += 1;
            }
            let rest = word.split_off(cut.max(1));
            self.line.push((font, word));
            self.break_line();
            word = rest;
            if word.is_empty() {
                return;
            }
        }
    }
}

/// Word-wraps runs (e.g. a bold label then the text) to `max_w` points.
/// Words longer than a whole line are split by characters.
fn wrap(runs: &[(Font, &str)], size: f32, max_w: f32) -> Vec<Line> {
    let mut w = Wrapper {
        size,
        max_w,
        lines: Vec::new(),
        line: Vec::new(),
        line_w: 0.0,
    };
    for (font, text) in runs {
        for (i, text_line) in text.split('\n').enumerate() {
            if i > 0 {
                w.break_line();
            }
            for word in text_line.split_whitespace() {
                w.push_word(*font, word.chars().map(win_ansi).collect());
            }
        }
    }
    if !w.line.is_empty() {
        w.break_line();
    }
    w.lines
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02X}")).collect()
}

/// Lays the transcript out into pages of PDF drawing commands.
fn layout(title: &str, subtitle: &str, paragraphs: &[DocxParagraph]) -> Vec<String> {
    let mut pages: Vec<String> = Vec::new();
    let mut page = String::new();
    let mut y = PAGE_H - MARGIN;

    let draw = |line: &Line,
                size: f32,
                leading: f32,
                gray: bool,
                page: &mut String,
                y: &mut f32,
                pages: &mut Vec<String>| {
        if *y - leading < MARGIN {
            pages.push(std::mem::take(page));
            *y = PAGE_H - MARGIN;
        }
        *y -= leading;
        let color = if gray { "0.4 g" } else { "0 g" };
        page.push_str(&format!("BT {color} {MARGIN} {y:.2} Td"));
        for (font, bytes) in line {
            page.push_str(&format!(
                " /{} {size} Tf <{}> Tj",
                font.resource(),
                hex(bytes)
            ));
        }
        page.push_str(" ET\n");
    };

    for line in wrap(&[(Font::Bold, title)], TITLE_SIZE, TEXT_W) {
        draw(
            &line,
            TITLE_SIZE,
            TITLE_LEADING,
            false,
            &mut page,
            &mut y,
            &mut pages,
        );
    }
    if !subtitle.is_empty() {
        for line in wrap(&[(Font::Regular, subtitle)], SUBTITLE_SIZE, TEXT_W) {
            draw(
                &line,
                SUBTITLE_SIZE,
                BODY_LEADING,
                true,
                &mut page,
                &mut y,
                &mut pages,
            );
        }
    }
    y -= 2.0 * PARAGRAPH_GAP;

    for p in paragraphs {
        let label = p
            .label
            .as_deref()
            .filter(|l| !l.is_empty())
            .map(|l| format!("{l}:"));
        let mut runs = Vec::new();
        if let Some(label) = label.as_deref() {
            runs.push((Font::Bold, label));
        }
        runs.push((Font::Regular, p.text.as_str()));
        for line in wrap(&runs, BODY_SIZE, TEXT_W) {
            draw(
                &line,
                BODY_SIZE,
                BODY_LEADING,
                false,
                &mut page,
                &mut y,
                &mut pages,
            );
        }
        y -= PARAGRAPH_GAP;
    }
    pages.push(page);

    // Page numbers, now that the total is known.
    let total = pages.len();
    for (i, page) in pages.iter_mut().enumerate() {
        let label: Vec<u8> = format!("{} / {total}", i + 1).bytes().collect();
        let x = PAGE_W - MARGIN - text_width(&label, Font::Regular, FOOTER_SIZE);
        page.push_str(&format!(
            "BT 0.5 g {x:.2} {:.2} Td /F1 {FOOTER_SIZE} Tf <{}> Tj ET\n",
            MARGIN / 2.0,
            hex(&label)
        ));
    }
    pages
}

fn deflate(data: &[u8]) -> Vec<u8> {
    let mut enc = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    // Writing to a Vec cannot fail.
    let _ = enc.write_all(data);
    enc.finish().unwrap_or_default()
}

/// The bytes of a PDF holding the given transcript.
pub fn build_pdf(title: &str, subtitle: &str, paragraphs: &[DocxParagraph]) -> Vec<u8> {
    let pages = layout(title, subtitle, paragraphs);

    // Objects: 1 catalog, 2 page tree, 3-4 fonts, 5 info, then a page and
    // its content stream for every page.
    let mut objects: Vec<Vec<u8>> = Vec::new();
    let kids = (0..pages.len())
        .map(|i| format!("{} 0 R", 6 + 2 * i))
        .collect::<Vec<_>>()
        .join(" ");
    objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
    objects.push(format!("<< /Type /Pages /Kids [{kids}] /Count {} >>", pages.len()).into_bytes());
    for name in ["Helvetica", "Helvetica-Bold"] {
        objects.push(
            format!(
                "<< /Type /Font /Subtype /Type1 /BaseFont /{name} /Encoding /WinAnsiEncoding >>"
            )
            .into_bytes(),
        );
    }
    let pdf_title: Vec<u8> = std::iter::once(0xfe_u8)
        .chain(std::iter::once(0xff))
        .chain(title.encode_utf16().flat_map(|u| u.to_be_bytes()))
        .collect();
    objects.push(
        format!(
            "<< /Title <{}> /Producer (Lezat Transcript) >>",
            hex(&pdf_title)
        )
        .into_bytes(),
    );
    for (i, content) in pages.iter().enumerate() {
        objects.push(
            format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents {} 0 R >>",
                7 + 2 * i
            )
            .into_bytes(),
        );
        let data = deflate(content.as_bytes());
        let mut stream = format!(
            "<< /Length {} /Filter /FlateDecode >>\nstream\n",
            data.len()
        )
        .into_bytes();
        stream.extend_from_slice(&data);
        stream.extend_from_slice(b"\nendstream");
        objects.push(stream);
    }

    let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
    let mut offsets = Vec::with_capacity(objects.len());
    for (i, obj) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n", i + 1).as_bytes());
        out.extend_from_slice(obj);
        out.extend_from_slice(b"\nendobj\n");
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 5 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spanish_characters_map_to_win_ansi() {
        let bytes: Vec<u8> = "¿Sí? ñ — “ok” 🙂".chars().map(win_ansi).collect();
        assert_eq!(
            bytes,
            vec![
                0xbf, b'S', 0xed, b'?', b' ', 0xf1, b' ', 0x97, b' ', 0x93, b'o', b'k', 0x94, b' ',
                b'?'
            ]
        );
    }

    #[test]
    fn wraps_within_the_text_width() {
        let text = "palabra ".repeat(200) + &"x".repeat(300);
        let lines = wrap(
            &[(Font::Bold, "Luis:"), (Font::Regular, &text)],
            BODY_SIZE,
            TEXT_W,
        );
        assert!(lines.len() > 10);
        for line in &lines {
            let w: f32 = line.iter().map(|(f, b)| text_width(b, *f, BODY_SIZE)).sum();
            assert!(w <= TEXT_W + 0.01, "line too wide: {w}");
        }
        assert_eq!(lines[0][0].0 as u8, Font::Bold as u8);
    }

    #[test]
    fn long_transcripts_get_several_numbered_pages() {
        let paragraphs: Vec<DocxParagraph> = (0..200)
            .map(|i| DocxParagraph {
                label: Some(format!("[{i:02}:00] Daniela")),
                text: "Hablamos de PropZat y de la validación con clientes.".into(),
            })
            .collect();
        let pages = layout("Presentación", "21 oct 2026", &paragraphs);
        assert!(pages.len() > 2);
        assert!(pages[1].contains(&hex(format!("2 / {}", pages.len()).as_bytes())));
        let pdf = build_pdf("Presentación", "21 oct 2026", &paragraphs);
        assert!(pdf.starts_with(b"%PDF-1.4"));
        assert!(pdf.ends_with(b"%%EOF\n"));
    }
}
