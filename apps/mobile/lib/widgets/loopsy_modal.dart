import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../theme.dart';

/// Shared modal scaffold used by every Loopsy dialog and bottom sheet.
///
/// Existing screens used `AlertDialog` and `showModalBottomSheet` directly,
/// which gave us cramped layouts: tight default padding, mismatched type
/// scales, action buttons jammed together. This widget replaces both with a
/// single, opinionated container that gives every modal generous breathing
/// room and a consistent header/body/actions structure.
///
/// Usage:
///   showLoopsyDialog(
///     context: context,
///     icon: HugeIcons.strokeRoundedKey01,
///     title: 'Enable auto-approve',
///     subtitle: 'Skip the agent's confirmation prompts.',
///     body: Column(...),
///     actions: [
///       LoopsyModalAction.text('Cancel', () => Navigator.pop(context)),
///       LoopsyModalAction.primary('Save', () => Navigator.pop(context, value)),
///     ],
///   );
class LoopsyModal extends StatelessWidget {
  final IconData? icon;
  final Color? iconColor;
  final String title;
  final String? subtitle;
  final Widget? body;
  final List<LoopsyModalAction> actions;

  const LoopsyModal({
    super.key,
    this.icon,
    this.iconColor,
    required this.title,
    this.subtitle,
    this.body,
    this.actions = const [],
  });

  @override
  Widget build(BuildContext context) {
    // Tight, intrinsic-height layout. No width: double.infinity (which can
    // make the Container expand under loose-constraint parents like Center)
    // and no manual viewInsets math here — keyboard avoidance is the
    // wrapper's responsibility (showLoopsyDialog/Sheet handles it).
    final children = <Widget>[
      if (icon != null) ...[
        Container(
          width: 44,
          height: 44,
          decoration: BoxDecoration(
            color: LoopsyColors.surfaceAlt,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: LoopsyColors.border),
          ),
          child: HugeIcon(icon: icon!, color: iconColor ?? LoopsyColors.accent, size: 22),
        ),
        const SizedBox(height: 16),
      ],
      Text(
        title,
        style: const TextStyle(
          color: LoopsyColors.fg,
          fontSize: 18,
          fontWeight: FontWeight.w700,
          letterSpacing: -0.2,
          height: 1.2,
        ),
      ),
      if (subtitle != null) ...[
        const SizedBox(height: 6),
        Text(
          subtitle!,
          style: const TextStyle(
            color: LoopsyColors.muted,
            fontSize: 13.5,
            height: 1.45,
          ),
        ),
      ],
      if (body != null) ...[
        const SizedBox(height: 16),
        body!,
      ],
      if (actions.isNotEmpty) ...[
        const SizedBox(height: 18),
        Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            for (var i = 0; i < actions.length; i++) ...[
              if (i > 0) const SizedBox(width: 8),
              actions[i]._build(context),
            ],
          ],
        ),
      ],
    ];

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 460),
      child: Material(
        color: LoopsyColors.surface,
        clipBehavior: Clip.antiAlias,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: const BorderSide(color: LoopsyColors.border),
        ),
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: children,
          ),
        ),
      ),
    );
  }
}

/// One button in the action row of a [LoopsyModal]. Use the named
/// constructors to match the design system's text / outlined / primary /
/// danger variants — the colors and padding are baked in.
class LoopsyModalAction {
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final _ActionStyle _style;
  final bool _busy;

  const LoopsyModalAction.text(this.label, this.onPressed, {this.icon})
      : _style = _ActionStyle.text,
        _busy = false;
  const LoopsyModalAction.outlined(this.label, this.onPressed, {this.icon})
      : _style = _ActionStyle.outlined,
        _busy = false;
  const LoopsyModalAction.primary(this.label, this.onPressed, {this.icon, bool busy = false})
      : _style = _ActionStyle.primary,
        _busy = busy;
  const LoopsyModalAction.danger(this.label, this.onPressed, {this.icon})
      : _style = _ActionStyle.danger,
        _busy = false;

  Widget _build(BuildContext context) {
    final disabled = onPressed == null;
    Widget child;
    final iconWidget = icon != null
        ? Padding(
            padding: const EdgeInsets.only(right: 6),
            child: HugeIcon(
              icon: icon!,
              color: _style == _ActionStyle.primary ? LoopsyColors.bg : LoopsyColors.fg,
              size: 16,
            ),
          )
        : null;
    final labelWidget = _busy
        ? const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: LoopsyColors.bg),
          )
        : Text(label);
    final row = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (iconWidget != null) iconWidget,
        labelWidget,
      ],
    );
    switch (_style) {
      case _ActionStyle.text:
        child = TextButton(
          onPressed: disabled ? null : onPressed,
          style: TextButton.styleFrom(
            foregroundColor: LoopsyColors.muted,
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
          ),
          child: row,
        );
        break;
      case _ActionStyle.outlined:
        child = OutlinedButton(
          onPressed: disabled ? null : onPressed,
          style: OutlinedButton.styleFrom(
            foregroundColor: LoopsyColors.fg,
            side: const BorderSide(color: LoopsyColors.border),
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          child: row,
        );
        break;
      case _ActionStyle.primary:
        child = ElevatedButton(
          onPressed: disabled ? null : onPressed,
          style: ElevatedButton.styleFrom(
            backgroundColor: LoopsyColors.accent,
            foregroundColor: LoopsyColors.bg,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          child: row,
        );
        break;
      case _ActionStyle.danger:
        child = ElevatedButton(
          onPressed: disabled ? null : onPressed,
          style: ElevatedButton.styleFrom(
            backgroundColor: LoopsyColors.bad,
            foregroundColor: Colors.white,
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 11),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
          ),
          child: row,
        );
        break;
    }
    return child;
  }
}

enum _ActionStyle { text, outlined, primary, danger }

/// Centered dialog wrapper. Pads horizontally so the modal doesn't touch the
/// screen edges, animates with the keyboard so a focused TextField doesn't
/// get hidden, and otherwise leaves the modal to size to its content.
Future<T?> showLoopsyDialog<T>({
  required BuildContext context,
  IconData? icon,
  Color? iconColor,
  required String title,
  String? subtitle,
  Widget? body,
  List<LoopsyModalAction> actions = const [],
  bool barrierDismissible = true,
}) {
  return showDialog<T>(
    context: context,
    barrierDismissible: barrierDismissible,
    barrierColor: Colors.black.withValues(alpha: 0.7),
    builder: (ctx) {
      final inset = MediaQuery.of(ctx).viewInsets.bottom;
      return Center(
        child: SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(20, 24, 20, 24 + inset),
          child: LoopsyModal(
            icon: icon,
            iconColor: iconColor,
            title: title,
            subtitle: subtitle,
            body: body,
            actions: actions,
          ),
        ),
      );
    },
  );
}

/// Bottom-sheet variant — same content frame, slides up from the bottom.
/// `isScrollControlled: true` lets the sheet size to its actual content; the
/// SafeArea below makes sure the action row clears the iOS home indicator
/// and the AnimatedPadding tracks the keyboard.
Future<T?> showLoopsySheet<T>({
  required BuildContext context,
  IconData? icon,
  Color? iconColor,
  required String title,
  String? subtitle,
  Widget? body,
  List<LoopsyModalAction> actions = const [],
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: Colors.black.withValues(alpha: 0.7),
    builder: (ctx) {
      final inset = MediaQuery.of(ctx).viewInsets.bottom;
      return AnimatedPadding(
        duration: const Duration(milliseconds: 120),
        curve: Curves.easeOut,
        padding: EdgeInsets.fromLTRB(12, 12, 12, 12 + inset),
        child: LoopsyModal(
          icon: icon,
          iconColor: iconColor,
          title: title,
          subtitle: subtitle,
          body: body,
          actions: actions,
        ),
      );
    },
  );
}

/// A LoopsyModal-styled list-tile row, used in pickers (e.g. agent picker,
/// session menu). Drops the default ListTile padding, picks up the design
/// tokens, and supports a leading icon + trailing widget.
class LoopsyMenuTile extends StatelessWidget {
  final IconData icon;
  final Color? iconColor;
  final String title;
  final String? subtitle;
  final VoidCallback onTap;
  final Color? titleColor;

  const LoopsyMenuTile({
    super.key,
    required this.icon,
    this.iconColor,
    required this.title,
    this.subtitle,
    required this.onTap,
    this.titleColor,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 12),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: LoopsyColors.surfaceAlt,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: LoopsyColors.border),
              ),
              child: HugeIcon(icon: icon, color: iconColor ?? LoopsyColors.fg, size: 18),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    title,
                    style: TextStyle(
                      color: titleColor ?? LoopsyColors.fg,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  if (subtitle != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      subtitle!,
                      style: const TextStyle(color: LoopsyColors.muted, fontSize: 12),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
