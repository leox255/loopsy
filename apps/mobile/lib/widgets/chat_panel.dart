import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../services/chat_event.dart';
import '../theme.dart';
import 'markdown_text.dart';

/// Chat-style view of the live Claude conversation. Driven by a
/// [ChatLog] populated from `chat-event` frames over the existing relay
/// WebSocket. v1 ships with input: the composer at the bottom routes
/// typed prompts back through the parent's PTY stdin path (same channel
/// the terminal view uses), so chat is no longer read-only.
///
/// Designed to mount/unmount cheaply — TerminalScreen keeps it in an
/// IndexedStack alongside the xterm view so toggling between them costs
/// no reconnect.
class ChatPanel extends StatefulWidget {
  /// The live state. Caller mutates this with [ChatLog.apply] as events
  /// arrive; this widget redraws via a stream of "version bumps" delivered
  /// through [revision] so the parent only has to call setState.
  final ChatLog log;
  final int revision;
  /// Send a single-line prompt to the underlying PTY. The parent (which
  /// owns the relay session) wraps the bytes with a trailing `\r` and
  /// pushes via the existing terminal-input channel. Null when the
  /// session isn't connected — composer renders disabled.
  final void Function(String text)? onSend;
  const ChatPanel({super.key, required this.log, required this.revision, this.onSend});

  @override
  State<ChatPanel> createState() => _ChatPanelState();
}

class _ChatPanelState extends State<ChatPanel> {
  final ScrollController _scroll = ScrollController();
  int _lastTurnCount = 0;

  @override
  void didUpdateWidget(covariant ChatPanel old) {
    super.didUpdateWidget(old);
    if (widget.log.turns.length != _lastTurnCount) {
      _lastTurnCount = widget.log.turns.length;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOut,
        );
      });
    }
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final log = widget.log;
    if (!log.available && log.unavailableReason != null) {
      return _PlaceholderMessage(
        icon: HugeIcons.strokeRoundedAiChat02,
        title: 'Chat unavailable for this session',
        subtitle: log.unavailableReason ?? '',
      );
    }
    if (log.turns.isEmpty) {
      return const _PlaceholderMessage(
        icon: HugeIcons.strokeRoundedAiChat02,
        title: 'Waiting for the first message',
        subtitle: 'Type in the terminal to start. The conversation will mirror here.',
      );
    }
    final hasDroppedHeader = log.droppedTurns > 0;
    final hasErrorFooter = log.lastError != null;
    final extraTop = hasDroppedHeader ? 1 : 0;
    return Column(
      children: [
        Expanded(
          child: ListView.builder(
            controller: _scroll,
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 12),
            itemCount: log.turns.length + extraTop + (hasErrorFooter ? 1 : 0),
            itemBuilder: (context, i) {
              if (hasDroppedHeader && i == 0) {
                return _DroppedHeader(count: log.droppedTurns);
              }
              final idx = i - extraTop;
              if (idx == log.turns.length && hasErrorFooter) {
                return _ErrorRow(log.lastError!);
              }
              return _TurnTile(turn: log.turns[idx]);
            },
          ),
        ),
        _ChatComposer(onSend: widget.onSend),
      ],
    );
  }
}

/// Bottom-anchored prompt composer. v1: single-line input that routes
/// through the PTY stdin path the terminal view already uses, sending
/// `<text>\r` to mimic the user pressing Enter at the prompt.
///
/// Known limits (per /codex review of the chat-input design, deferring
/// to v2):
///   - Multi-line: only the first line + \r gets sent.
///   - Paste of multi-line: ditto.
///   - Bracketed paste mode: not supported.
///   - IME composition: untested.
class _ChatComposer extends StatefulWidget {
  final void Function(String text)? onSend;
  const _ChatComposer({required this.onSend});

  @override
  State<_ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<_ChatComposer> {
  final TextEditingController _ctl = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _hasText = false;

  @override
  void initState() {
    super.initState();
    _ctl.addListener(() {
      final has = _ctl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
  }

  @override
  void dispose() {
    _ctl.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _send() {
    final t = _ctl.text.trim();
    if (t.isEmpty || widget.onSend == null) return;
    widget.onSend!(t);
    _ctl.clear();
    // Keep the focus so the user can fire successive prompts without
    // re-tapping the field — common pattern in chat UIs.
    _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onSend != null;
    return Material(
      color: LoopsyColors.surface,
      child: SafeArea(
        top: false,
        child: Container(
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: LoopsyColors.border)),
          ),
          padding: const EdgeInsets.fromLTRB(10, 8, 8, 10),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Expanded(
                child: TextField(
                  controller: _ctl,
                  focusNode: _focus,
                  enabled: enabled,
                  minLines: 1,
                  maxLines: 5,
                  textCapitalization: TextCapitalization.sentences,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => _send(),
                  style: const TextStyle(color: LoopsyColors.fg, fontSize: 14),
                  decoration: InputDecoration(
                    hintText: enabled ? 'Message Claude…' : 'Disconnected',
                    hintStyle: const TextStyle(color: LoopsyColors.muted),
                    filled: true,
                    fillColor: LoopsyColors.surfaceAlt,
                    isDense: true,
                    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(22),
                      borderSide: const BorderSide(color: LoopsyColors.border),
                    ),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(22),
                      borderSide: const BorderSide(color: LoopsyColors.border),
                    ),
                    focusedBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(22),
                      borderSide: const BorderSide(color: LoopsyColors.accent),
                    ),
                  ),
                ),
              ),
              const SizedBox(width: 6),
              Material(
                color: (_hasText && enabled) ? LoopsyColors.accent : LoopsyColors.surfaceAlt,
                shape: const CircleBorder(),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: (_hasText && enabled) ? _send : null,
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: HugeIcon(
                      icon: HugeIcons.strokeRoundedSent,
                      color: (_hasText && enabled) ? LoopsyColors.bg : LoopsyColors.muted,
                      size: 18,
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _DroppedHeader extends StatelessWidget {
  final int count;
  const _DroppedHeader({required this.count});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const HugeIcon(icon: HugeIcons.strokeRoundedArchive01, color: LoopsyColors.muted, size: 12),
          const SizedBox(width: 6),
          Text(
            '$count earlier turns hidden',
            style: const TextStyle(
              color: LoopsyColors.muted,
              fontSize: 11,
              fontFamily: 'JetBrainsMono',
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _PlaceholderMessage extends StatelessWidget {
  final IconData icon;
  final String title;
  final String subtitle;
  const _PlaceholderMessage({required this.icon, required this.title, required this.subtitle});
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            HugeIcon(icon: icon, color: LoopsyColors.muted, size: 36),
            const SizedBox(height: 14),
            Text(
              title,
              textAlign: TextAlign.center,
              style: const TextStyle(color: LoopsyColors.fg, fontSize: 15, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Text(
              subtitle,
              textAlign: TextAlign.center,
              style: const TextStyle(color: LoopsyColors.muted, fontSize: 13),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorRow extends StatelessWidget {
  final String message;
  const _ErrorRow(this.message);
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          const HugeIcon(icon: HugeIcons.strokeRoundedAlert02, color: LoopsyColors.warn, size: 16),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: LoopsyColors.warn, fontSize: 12),
            ),
          ),
        ],
      ),
    );
  }
}

class _TurnTile extends StatelessWidget {
  final ChatTurn turn;
  const _TurnTile({required this.turn});

  @override
  Widget build(BuildContext context) {
    final isUser = turn.role == ChatRole.user;
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        crossAxisAlignment: isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              HugeIcon(
                icon: isUser ? HugeIcons.strokeRoundedUser : HugeIcons.strokeRoundedAiChat02,
                color: isUser ? LoopsyColors.muted : LoopsyColors.accent,
                size: 14,
              ),
              const SizedBox(width: 6),
              Text(
                isUser ? 'You' : 'Claude',
                style: TextStyle(
                  color: isUser ? LoopsyColors.muted : LoopsyColors.accent,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                  letterSpacing: 0.4,
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          for (final b in turn.blocks) _BlockView(block: b, isUser: isUser),
        ],
      ),
    );
  }
}

class _BlockView extends StatelessWidget {
  final ChatBlock block;
  final bool isUser;
  const _BlockView({required this.block, required this.isUser});

  @override
  Widget build(BuildContext context) {
    switch (block) {
      case TextBlock(:final text):
        return _TextBubble(text: text, isUser: isUser);
      case ThinkingBlock(:final text):
        if (text.trim().isEmpty) {
          return const _ThinkingMarker(text: 'Reasoning…');
        }
        return _ThinkingMarker(text: text);
      case ToolUseBlock(:final name, :final input):
        return _ToolCard(
          icon: HugeIcons.strokeRoundedTools,
          title: name,
          color: LoopsyColors.warn,
          body: _stringify(input),
        );
      case ToolResultBlock(:final content, :final isError, :final truncated):
        return _ToolCard(
          icon: isError ? HugeIcons.strokeRoundedAlert02 : HugeIcons.strokeRoundedCheckmarkCircle02,
          title: isError ? 'tool error' : 'tool result',
          color: isError ? LoopsyColors.bad : LoopsyColors.good,
          body: _stringify(content) + (truncated ? '\n…(truncated)' : ''),
        );
    }
  }

  static String _stringify(dynamic v) {
    if (v == null) return '';
    if (v is String) return v;
    try {
      return const JsonEncoder.withIndent('  ').convert(v);
    } catch (_) {
      return v.toString();
    }
  }
}

class _TextBubble extends StatelessWidget {
  final String text;
  final bool isUser;
  const _TextBubble({required this.text, required this.isUser});
  @override
  Widget build(BuildContext context) {
    // User messages are typically short and never contain markdown they
    // typed deliberately, so render them as plain text in the accent
    // bubble. Assistant messages get the markdown renderer — code fences,
    // inline code, bold, italics, URLs. Spike confirmed assistant text
    // blocks arrive atomic so mid-render fence-flicker isn't a concern.
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.88),
        child: Container(
          margin: const EdgeInsets.only(top: 4),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: isUser ? LoopsyColors.accentDark : LoopsyColors.surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: isUser ? LoopsyColors.accentDark : LoopsyColors.border),
          ),
          child: isUser
              ? SelectableText(
                  text,
                  style: const TextStyle(color: LoopsyColors.fg, fontSize: 14, height: 1.4),
                )
              : MarkdownText(
                  text,
                  baseStyle: const TextStyle(color: LoopsyColors.fg, fontSize: 14, height: 1.45),
                ),
        ),
      ),
    );
  }
}

class _ThinkingMarker extends StatelessWidget {
  final String text;
  const _ThinkingMarker({required this.text});
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          const HugeIcon(icon: HugeIcons.strokeRoundedBrain02, color: LoopsyColors.muted, size: 14),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              text,
              maxLines: 6,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                color: LoopsyColors.muted,
                fontSize: 12,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ToolCard extends StatefulWidget {
  final IconData icon;
  final String title;
  final Color color;
  final String body;
  const _ToolCard({required this.icon, required this.title, required this.color, required this.body});
  @override
  State<_ToolCard> createState() => _ToolCardState();
}

class _ToolCardState extends State<_ToolCard> {
  static const int _previewLimit = 800;
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final body = widget.body;
    final hasMore = body.length > _previewLimit;
    final shown = (_expanded || !hasMore) ? body : body.substring(0, _previewLimit);
    return Container(
      margin: const EdgeInsets.only(top: 4),
      decoration: BoxDecoration(
        color: LoopsyColors.surfaceAlt,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: LoopsyColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 8, 10, 0),
            child: Row(
              children: [
                HugeIcon(icon: widget.icon, color: widget.color, size: 14),
                const SizedBox(width: 6),
                Expanded(
                  child: Text(
                    widget.title,
                    style: TextStyle(
                      color: widget.color,
                      fontSize: 11,
                      fontWeight: FontWeight.w700,
                      fontFamily: 'JetBrainsMono',
                    ),
                  ),
                ),
                if (hasMore)
                  Text(
                    '${body.length} chars',
                    style: const TextStyle(
                      color: LoopsyColors.muted,
                      fontSize: 10,
                      fontFamily: 'JetBrainsMono',
                    ),
                  ),
              ],
            ),
          ),
          if (body.trim().isNotEmpty) ...[
            Padding(
              padding: EdgeInsets.fromLTRB(10, 6, 10, hasMore ? 0 : 10),
              child: SelectableText(
                shown,
                style: const TextStyle(
                  color: LoopsyColors.fg,
                  fontFamily: 'JetBrainsMono',
                  fontSize: 11.5,
                  height: 1.35,
                ),
              ),
            ),
            // Expand affordance only when there's more to see. Tap on the
            // whole row so it's an easy mobile target, not just the chevron.
            if (hasMore)
              InkWell(
                onTap: () => setState(() => _expanded = !_expanded),
                borderRadius: const BorderRadius.vertical(bottom: Radius.circular(10)),
                child: Container(
                  width: double.infinity,
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  decoration: const BoxDecoration(
                    border: Border(top: BorderSide(color: LoopsyColors.border)),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      HugeIcon(
                        icon: _expanded
                            ? HugeIcons.strokeRoundedArrowUp02
                            : HugeIcons.strokeRoundedArrowDown02,
                        color: LoopsyColors.muted,
                        size: 12,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        _expanded ? 'show less' : 'show ${body.length - _previewLimit} more',
                        style: const TextStyle(
                          color: LoopsyColors.muted,
                          fontSize: 11,
                          fontWeight: FontWeight.w600,
                          fontFamily: 'JetBrainsMono',
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ],
      ),
    );
  }
}
