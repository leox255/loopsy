import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hugeicons/hugeicons.dart';

import '../theme.dart';

/// Slim accessory bar pinned above the system keyboard. Mirrors the
/// "shortcuts above keyboard" pattern from Termius/Blink/Working Copy —
/// the OS handles letters/digits/symbols (in any language, with paste,
/// emoji, voice dictation), and this bar carries the terminal-only keys
/// the system keyboard can't produce (Ctrl, Alt, Esc, Tab, arrows).
///
/// Ctrl/Alt are one-shot toggles: tap, then the next key typed on the
/// system keyboard gets the modifier applied. The screen owning this bar
/// holds the latched state and applies it inside the wrap around
/// `Terminal.onOutput`. The bar itself is stateless from that perspective —
/// it just renders the current armed flag and fires toggle callbacks.
class TerminalAccessoryBar extends StatelessWidget {
  /// Send a raw byte sequence (no modifier transform).
  final void Function(List<int> bytes) onBytes;
  /// Whether the Ctrl modifier is armed for the next keystroke.
  final bool ctrlArmed;
  /// Whether the Alt modifier is armed for the next keystroke.
  final bool altArmed;
  /// Toggle the Ctrl modifier (one-shot — auto-clears after the next key).
  final VoidCallback onToggleCtrl;
  /// Toggle the Alt modifier (one-shot — auto-clears after the next key).
  final VoidCallback onToggleAlt;
  /// Optional voice tap; omit to hide the mic key.
  final VoidCallback? onVoice;

  const TerminalAccessoryBar({
    super.key,
    required this.onBytes,
    required this.ctrlArmed,
    required this.altArmed,
    required this.onToggleCtrl,
    required this.onToggleAlt,
    this.onVoice,
  });

  void _tap(List<int> bytes) {
    HapticFeedback.selectionClick();
    onBytes(bytes);
  }

  @override
  Widget build(BuildContext context) {
    return Material(
      color: LoopsyColors.surface,
      child: SafeArea(
        top: false,
        child: Container(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: LoopsyColors.border)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _LabelKey(label: 'ctrl', selected: ctrlArmed, onTap: () { HapticFeedback.selectionClick(); onToggleCtrl(); }),
                _LabelKey(label: 'alt', selected: altArmed, onTap: () { HapticFeedback.selectionClick(); onToggleAlt(); }),
                _LabelKey(label: 'esc', onTap: () => _tap([0x1b])),
                _LabelKey(label: 'tab', onTap: () => _tap([0x09])),
                _IconKey(icon: HugeIcons.strokeRoundedArrowUp02, onTap: () => _tap([0x1b, 0x5b, 0x41])),
                _IconKey(icon: HugeIcons.strokeRoundedArrowDown02, onTap: () => _tap([0x1b, 0x5b, 0x42])),
                _IconKey(icon: HugeIcons.strokeRoundedArrowLeft02, onTap: () => _tap([0x1b, 0x5b, 0x44])),
                _IconKey(icon: HugeIcons.strokeRoundedArrowRight02, onTap: () => _tap([0x1b, 0x5b, 0x43])),
                _LabelKey(label: '|', onTap: () => _tap('|'.codeUnits)),
                _LabelKey(label: '/', onTap: () => _tap('/'.codeUnits)),
                _LabelKey(label: '~', onTap: () => _tap('~'.codeUnits)),
                if (onVoice != null)
                  _IconKey(
                    icon: HugeIcons.strokeRoundedMic01,
                    color: LoopsyColors.accent,
                    onTap: () { HapticFeedback.selectionClick(); onVoice!(); },
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _LabelKey extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _LabelKey({required this.label, this.selected = false, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return _KeyShell(
      selected: selected,
      onTap: onTap,
      child: Text(
        label,
        style: TextStyle(
          color: selected ? LoopsyColors.bg : LoopsyColors.fg,
          fontFamily: 'JetBrainsMono',
          fontSize: 13,
          fontWeight: FontWeight.w500,
        ),
      ),
    );
  }
}

class _IconKey extends StatelessWidget {
  final IconData icon;
  final Color? color;
  final VoidCallback onTap;
  const _IconKey({required this.icon, this.color, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return _KeyShell(
      onTap: onTap,
      child: HugeIcon(icon: icon, color: color ?? LoopsyColors.fg, size: 18),
    );
  }
}

class _KeyShell extends StatelessWidget {
  final Widget child;
  final bool selected;
  final VoidCallback onTap;
  const _KeyShell({required this.child, this.selected = false, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 3),
      child: Material(
        color: selected ? LoopsyColors.accent : LoopsyColors.surfaceAlt,
        borderRadius: BorderRadius.circular(7),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(7),
          child: Container(
            constraints: const BoxConstraints(minWidth: 42, minHeight: 36),
            padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 8),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(7),
              border: Border.all(
                color: selected ? LoopsyColors.accent : LoopsyColors.border,
                width: 0.6,
              ),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}
