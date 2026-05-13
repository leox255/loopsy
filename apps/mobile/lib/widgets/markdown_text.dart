import 'package:flutter/material.dart';

import '../theme.dart';

/// Tiny markdown renderer scoped to what Claude actually emits in chat
/// text blocks. The spike confirmed text blocks arrive atomic, not as
/// token deltas, so we don't have to deal with mid-render incomplete
/// fences or splitting a `**bold**` span across two events.
///
/// Supported:
///   - Triple-backtick fenced code blocks (with optional language hint)
///   - `inline code`
///   - **bold**
///   - *italic* / _italic_
///   - Bare URLs (rendered colored but not tappable — yet)
///
/// Anything else falls through as plain text. The goal is "legible enough
/// to read a prose response that includes a snippet of code", not full
/// CommonMark compliance.
class MarkdownText extends StatelessWidget {
  final String source;
  final TextStyle? baseStyle;
  const MarkdownText(this.source, {super.key, this.baseStyle});

  @override
  Widget build(BuildContext context) {
    final base = (baseStyle ?? const TextStyle()).copyWith(
      color: baseStyle?.color ?? LoopsyColors.fg,
      fontSize: baseStyle?.fontSize ?? 14,
      height: baseStyle?.height ?? 1.4,
    );
    final blocks = _splitFences(source);
    if (blocks.length == 1 && blocks.first.lang == null) {
      // Hot path: no fences. One SelectableText.rich with inline spans.
      return SelectableText.rich(
        TextSpan(children: _inlineSpans(blocks.first.text, base)),
        style: base,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final b in blocks)
          if (b.lang != null)
            _CodeBlock(text: b.text, lang: b.lang!)
          else if (b.text.trim().isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 2),
              child: SelectableText.rich(
                TextSpan(children: _inlineSpans(b.text, base)),
                style: base,
              ),
            ),
      ],
    );
  }
}

class _Block {
  final String text;
  final String? lang;
  _Block(this.text, this.lang);
}

/// Split a string by triple-backtick fences. A `lang == null` block is
/// prose; `lang != null` is a code block (lang may be empty string when
/// the fence opened with no language hint).
List<_Block> _splitFences(String src) {
  final out = <_Block>[];
  int i = 0;
  while (i < src.length) {
    final open = src.indexOf('```', i);
    if (open < 0) {
      out.add(_Block(src.substring(i), null));
      break;
    }
    if (open > i) out.add(_Block(src.substring(i, open), null));
    // Read optional language tag through end of that line.
    int langEnd = src.indexOf('\n', open + 3);
    if (langEnd < 0) langEnd = src.length;
    final lang = src.substring(open + 3, langEnd).trim();
    final bodyStart = langEnd + 1;
    final close = src.indexOf('```', bodyStart);
    if (close < 0) {
      // Unclosed fence — render the rest as code so it doesn't bleed back
      // into prose styling.
      out.add(_Block(src.substring(bodyStart), lang));
      break;
    }
    out.add(_Block(src.substring(bodyStart, close), lang));
    i = close + 3;
    // Skip the trailing newline after the closing fence if present so the
    // next prose block doesn't start with an awkward blank line.
    if (i < src.length && src[i] == '\n') i++;
  }
  return out;
}

/// Tokenize a prose run into TextSpans for inline markdown. Implemented as
/// a single left-to-right pass — regex-based dispatching against the next
/// matching marker so we don't have to track nested state.
List<InlineSpan> _inlineSpans(String text, TextStyle base) {
  final spans = <InlineSpan>[];
  final mono = base.copyWith(
    fontFamily: 'JetBrainsMono',
    fontSize: (base.fontSize ?? 14) - 1,
    backgroundColor: LoopsyColors.surfaceAlt,
  );

  // Pattern matches inline code first (highest precedence), then bold,
  // then italic, then bare URLs.
  final re = RegExp(
    r'`([^`\n]+)`'                              // group 1: inline code
    r'|\*\*([^*\n]+)\*\*'                       // group 2: **bold**
    r'|(?:^|(?<=\s))\*([^*\n]+)\*(?:(?=\s)|$)'  // group 3: *italic*
    r"|(?:^|(?<=\s))_([^_\n]+)_(?:(?=\s)|$)"    // group 4: _italic_
    r'|(https?://[^\s)\]]+)',                   // group 5: URL
    multiLine: true,
  );

  int cursor = 0;
  for (final m in re.allMatches(text)) {
    if (m.start > cursor) {
      spans.add(TextSpan(text: text.substring(cursor, m.start), style: base));
    }
    if (m.group(1) != null) {
      spans.add(TextSpan(text: m.group(1)!, style: mono));
    } else if (m.group(2) != null) {
      spans.add(TextSpan(text: m.group(2)!, style: base.copyWith(fontWeight: FontWeight.w700)));
    } else if (m.group(3) != null) {
      spans.add(TextSpan(text: m.group(3)!, style: base.copyWith(fontStyle: FontStyle.italic)));
    } else if (m.group(4) != null) {
      spans.add(TextSpan(text: m.group(4)!, style: base.copyWith(fontStyle: FontStyle.italic)));
    } else if (m.group(5) != null) {
      spans.add(TextSpan(text: m.group(5)!, style: base.copyWith(color: LoopsyColors.accent)));
    }
    cursor = m.end;
  }
  if (cursor < text.length) {
    spans.add(TextSpan(text: text.substring(cursor), style: base));
  }
  if (spans.isEmpty) spans.add(TextSpan(text: text, style: base));
  return spans;
}

class _CodeBlock extends StatelessWidget {
  final String text;
  final String lang;
  const _CodeBlock({required this.text, required this.lang});

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        color: LoopsyColors.bg,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: LoopsyColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (lang.isNotEmpty)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
              decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: LoopsyColors.border)),
              ),
              child: Text(
                lang,
                style: const TextStyle(
                  color: LoopsyColors.muted,
                  fontSize: 10,
                  fontFamily: 'JetBrainsMono',
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.5,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(10),
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SelectableText(
                text.trimRight(),
                style: const TextStyle(
                  color: LoopsyColors.fg,
                  fontFamily: 'JetBrainsMono',
                  fontSize: 12,
                  height: 1.45,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
