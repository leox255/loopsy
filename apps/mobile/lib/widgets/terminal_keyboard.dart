import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hugeicons/hugeicons.dart';

import '../theme.dart';

/// Bytes-first soft keyboard for terminals. Sends raw control sequences (DEL,
/// CR, ESC, ^C, etc.) directly to the active PTY rather than going through
/// iOS's IME stack — which mangles backspace and turns Return into LF.
///
/// Layout matches iOS phone keyboard so muscle memory still works:
///   - top control strip: ctrl, alt, tab, esc, ⌫, arrows, mic
///   - 3 alpha rows + shift/123/space/return
///   - 1 toggle to a symbols layer
class TerminalKeyboard extends StatefulWidget {
  /// Send raw bytes to the PTY.
  final void Function(List<int> bytes) onBytes;
  /// Optional voice tap (omitted ⇒ no mic key shown).
  final VoidCallback? onVoice;

  const TerminalKeyboard({super.key, required this.onBytes, this.onVoice});

  @override
  State<TerminalKeyboard> createState() => _TerminalKeyboardState();
}

enum _Layer { letters, symbols }

class _TerminalKeyboardState extends State<TerminalKeyboard> {
  _Layer _layer = _Layer.letters;
  bool _shift = false;
  bool _capsLock = false;
  bool _ctrl = false;
  bool _alt = false;

  // Letter rows
  static const _row1 = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'];
  static const _row2 = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'];
  static const _row3 = ['z', 'x', 'c', 'v', 'b', 'n', 'm'];

  // Symbol rows
  static const _sym1 = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  static const _sym2 = ['-', '/', ':', ';', '(', ')', '\$', '&', '@', '"'];
  static const _sym3 = ['.', ',', '?', '!', "'", '~', '|'];

  void _send(List<int> bytes) {
    HapticFeedback.selectionClick();
    widget.onBytes(bytes);
  }

  void _sendStr(String s) {
    if (_ctrl && s.length == 1) {
      // Ctrl+letter → 0x01..0x1A
      final code = s.toLowerCase().codeUnitAt(0);
      if (code >= 'a'.codeUnitAt(0) && code <= 'z'.codeUnitAt(0)) {
        _send([code - 'a'.codeUnitAt(0) + 1]);
      } else if (s == '[') {
        _send([0x1b]); // Ctrl+[ = ESC
      } else {
        _send(utf8.encode(s));
      }
      setState(() => _ctrl = false); // ctrl is one-shot
      return;
    }
    if (_alt && s.length == 1) {
      _send([0x1b, ...utf8.encode(s)]); // ESC prefix = Alt
      setState(() => _alt = false);
      return;
    }
    String out = s;
    if (_layer == _Layer.letters && (_shift || _capsLock)) {
      out = s.toUpperCase();
    }
    _send(utf8.encode(out));
    if (_shift && !_capsLock) setState(() => _shift = false);
  }

  Widget _key(
    String label,
    VoidCallback onTap, {
    int flex = 2,
    Color? bg,
    Color? fg,
    bool selected = false,
    Widget? icon,
    double labelSize = 16,
  }) {
    return Expanded(
      flex: flex,
      child: Padding(
        padding: const EdgeInsets.all(2.5),
        child: Material(
          color: selected
              ? LoopsyColors.accent
              : (bg ?? LoopsyColors.surfaceAlt),
          borderRadius: BorderRadius.circular(7),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(7),
            child: Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(vertical: 9),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(7),
                border: Border.all(
                  color: selected ? LoopsyColors.accent : LoopsyColors.border,
                  width: 0.6,
                ),
              ),
              child: icon ??
                  Text(
                    label,
                    style: TextStyle(
                      color: selected
                          ? LoopsyColors.bg
                          : (fg ?? LoopsyColors.fg),
                      fontFamily: 'JetBrainsMono',
                      fontSize: labelSize,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _row(List<Widget> keys) =>
      Padding(padding: const EdgeInsets.symmetric(horizontal: 4), child: Row(children: keys));

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      top: false,
      child: Container(
        padding: const EdgeInsets.fromLTRB(2, 6, 2, 6),
        decoration: const BoxDecoration(
          color: LoopsyColors.surface,
          border: Border(top: BorderSide(color: LoopsyColors.border)),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Control strip
            _row([
              _key('ctrl', () => setState(() => _ctrl = !_ctrl), flex: 3, selected: _ctrl, labelSize: 13),
              _key('alt', () => setState(() => _alt = !_alt), flex: 3, selected: _alt, labelSize: 13),
              _key('esc', () => _send([0x1b]), flex: 3, labelSize: 13),
              _key('tab', () => _send([0x09]), flex: 3, labelSize: 13),
              _key('', () => _send([0x1b, 0x5b, 0x41]), flex: 2,
                  icon: const HugeIcon(icon: HugeIcons.strokeRoundedArrowUp02, color: LoopsyColors.fg, size: 16)),
              _key('', () => _send([0x1b, 0x5b, 0x42]), flex: 2,
                  icon: const HugeIcon(icon: HugeIcons.strokeRoundedArrowDown02, color: LoopsyColors.fg, size: 16)),
              _key('', () => _send([0x1b, 0x5b, 0x44]), flex: 2,
                  icon: const HugeIcon(icon: HugeIcons.strokeRoundedArrowLeft02, color: LoopsyColors.fg, size: 16)),
              _key('', () => _send([0x1b, 0x5b, 0x43]), flex: 2,
                  icon: const HugeIcon(icon: HugeIcons.strokeRoundedArrowRight02, color: LoopsyColors.fg, size: 16)),
              if (widget.onVoice != null)
                _key('', widget.onVoice!, flex: 3,
                    icon: const HugeIcon(icon: HugeIcons.strokeRoundedMic01, color: LoopsyColors.accent, size: 18)),
            ]),
            const SizedBox(height: 6),
            // Alpha / symbol rows
            if (_layer == _Layer.letters) ...[
              _row(_row1.map((c) => _key(_displayLetter(c), () => _sendStr(c))).toList()),
              _row([
                const SizedBox(width: 12),
                ..._row2.map((c) => _key(_displayLetter(c), () => _sendStr(c))),
                const SizedBox(width: 12),
              ]),
              _row([
                _key('', () {
                  if (_shift) {
                    setState(() { _shift = false; _capsLock = !_capsLock; });
                  } else {
                    setState(() => _shift = true);
                  }
                }, flex: 3, selected: _shift || _capsLock,
                    icon: HugeIcon(
                      icon: _capsLock ? HugeIcons.strokeRoundedArrowUpDouble : HugeIcons.strokeRoundedArrowUp01,
                      color: (_shift || _capsLock) ? LoopsyColors.bg : LoopsyColors.fg,
                      size: 18,
                    )),
                ..._row3.map((c) => _key(_displayLetter(c), () => _sendStr(c))),
                _key('', () => _send([0x7f]), flex: 3,
                    icon: const HugeIcon(icon: HugeIcons.strokeRoundedDelete02, color: LoopsyColors.fg, size: 18)),
              ]),
            ] else ...[
              _row(_sym1.map((c) => _key(c, () => _sendStr(c), labelSize: 14)).toList()),
              _row([
                const SizedBox(width: 6),
                ..._sym2.map((c) => _key(c, () => _sendStr(c), labelSize: 14)),
                const SizedBox(width: 6),
              ]),
              _row([
                _key('123', () { /* no-op (already in symbols) */ }, flex: 3, labelSize: 12),
                ..._sym3.map((c) => _key(c, () => _sendStr(c), labelSize: 14)),
                _key('', () => _send([0x7f]), flex: 3,
                    icon: const HugeIcon(icon: HugeIcons.strokeRoundedDelete02, color: LoopsyColors.fg, size: 18)),
              ]),
            ],
            // Bottom row: layer toggle, space, return
            _row([
              _key(_layer == _Layer.letters ? '123' : 'ABC', () {
                setState(() {
                  _layer = _layer == _Layer.letters ? _Layer.symbols : _Layer.letters;
                });
              }, flex: 3, labelSize: 13),
              _key(' ', () => _sendStr(' '), flex: 12),
              _key('return', () => _send([0x0d]), flex: 4, labelSize: 13),
            ]),
          ],
        ),
      ),
    );
  }

  String _displayLetter(String c) =>
      (_shift || _capsLock) ? c.toUpperCase() : c;
}
