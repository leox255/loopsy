import 'dart:convert';
import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:hugeicons/hugeicons.dart';

import '../services/chat_event.dart';
import '../theme.dart';
import 'markdown_text.dart';

/// Per-agent accent palette. Subtle differentiation so each agent has
/// its own visual identity inside the chat — avatar background, send
/// button tint when no text, internals pill border. Not full theming;
/// the broader UI stays consistent.
class _AgentTheme {
  final Color accent;
  final Color soft;
  final String initial;
  const _AgentTheme(this.accent, this.soft, this.initial);
}

const _agentThemes = <String, _AgentTheme>{
  'Claude': _AgentTheme(Color(0xFFE0AF68), Color(0xFF332B1F), 'C'), // amber
  'Codex': _AgentTheme(Color(0xFF9ECE6A), Color(0xFF243024), 'X'),  // emerald
  'Gemini': _AgentTheme(Color(0xFF7DCFFF), Color(0xFF1E2E3A), 'G'), // sky
  'OpenCode': _AgentTheme(Color(0xFFBB9AF7), Color(0xFF2A2438), 'O'), // violet
};

_AgentTheme _themeFor(String agentName) =>
    _agentThemes[agentName] ?? const _AgentTheme(LoopsyColors.accent, Color(0xFF1D2128), '?');

/// Chat-style view of the live conversation. Driven by a [ChatLog]
/// populated from `chat-event` frames over the existing relay
/// WebSocket. v1 ships with input: the composer at the bottom routes
/// typed prompts back through the parent's PTY stdin path.
class ChatPanel extends StatefulWidget {
  final ChatLog log;
  final int revision;
  final void Function(String text)? onSend;
  final String agentName;
  const ChatPanel({
    super.key,
    required this.log,
    required this.revision,
    required this.agentName,
    this.onSend,
  });

  @override
  State<ChatPanel> createState() => _ChatPanelState();
}

class _ChatPanelState extends State<ChatPanel> with WidgetsBindingObserver {
  final ScrollController _scroll = ScrollController();
  int _lastRevision = -1;
  bool _showScrollToBottom = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _scroll.addListener(_onScroll);
  }

  void _onScroll() {
    if (!_scroll.hasClients) return;
    final atBottom = _scroll.position.pixels >= _scroll.position.maxScrollExtent - 80;
    final shouldShow = !atBottom;
    if (shouldShow != _showScrollToBottom) {
      setState(() => _showScrollToBottom = shouldShow);
    }
  }

  @override
  void didChangeMetrics() {
    _scrollToBottom(animated: false);
  }

  @override
  void didUpdateWidget(covariant ChatPanel old) {
    super.didUpdateWidget(old);
    if (widget.revision != _lastRevision) {
      _lastRevision = widget.revision;
      // Only auto-scroll if the user is already near the bottom — don't
      // yank them back if they're reading older messages.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || !_scroll.hasClients) return;
        final pos = _scroll.position;
        if (pos.pixels >= pos.maxScrollExtent - 120) {
          _scrollToBottom(animated: true);
        }
      });
    }
  }

  void _scrollToBottom({required bool animated}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scroll.hasClients) return;
      final target = _scroll.position.maxScrollExtent;
      if (animated) {
        _scroll.animateTo(
          target,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
        );
      } else {
        _scroll.jumpTo(target);
      }
    });
  }

  @override
  void dispose() {
    _scroll.removeListener(_onScroll);
    WidgetsBinding.instance.removeObserver(this);
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final log = widget.log;
    final theme = _themeFor(widget.agentName);

    // Empty / waiting state: hero placeholder + composer underneath so
    // the user can fire the first prompt without leaving the panel.
    if (log.turns.isEmpty) {
      final waiting = !log.available && log.unavailableReason != null;
      return Column(
        children: [
          Expanded(
            child: _EmptyState(
              agentName: widget.agentName,
              waiting: waiting,
              waitingReason: log.unavailableReason ?? '',
            ),
          ),
          _ChatComposer(onSend: widget.onSend, agentName: widget.agentName, theme: theme),
        ],
      );
    }

    // Filter out tool-result-only "user" turns (SDK plumbing).
    final visibleTurns = [
      for (final t in log.turns)
        if (!t.isToolResultOnly) t,
    ];

    // Build a tool_use_id → ToolResultBlock map across all turns.
    final toolResults = <String, ToolResultBlock>{};
    for (final t in log.turns) {
      for (final b in t.blocks) {
        if (b is ToolResultBlock) toolResults[b.toolUseId] = b;
      }
    }

    // Group consecutive same-role turns into one tile.
    final groups = <List<ChatTurn>>[];
    for (final t in visibleTurns) {
      if (groups.isNotEmpty && groups.last.first.role == t.role) {
        groups.last.add(t);
      } else {
        groups.add([t]);
      }
    }

    // Typing indicator: show when the most recent turn is incomplete OR
    // is a user prompt without a follow-up. The bubble lives at the
    // bottom of the list so it appears right where the next response
    // will materialize.
    bool showTyping = false;
    if (visibleTurns.isNotEmpty) {
      final last = visibleTurns.last;
      if (last.role == ChatRole.user) {
        showTyping = true;
      } else if (last.role == ChatRole.assistant && !last.done) {
        // Only show typing for the empty-thinking case — if the assistant
        // is already streaming visible text we let the bubble itself
        // signal liveness.
        final hasText = last.blocks.any((b) => b is TextBlock && (b).text.trim().isNotEmpty);
        if (!hasText) showTyping = true;
      }
    }

    final hasDroppedHeader = log.droppedTurns > 0;
    final hasErrorFooter = log.lastError != null;
    final extraTop = hasDroppedHeader ? 1 : 0;
    final extraBottom = (showTyping ? 1 : 0) + (hasErrorFooter ? 1 : 0);

    return Column(
      children: [
        Expanded(
          child: Stack(
            children: [
              ListView.builder(
                controller: _scroll,
                padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
                itemCount: groups.length + extraTop + extraBottom,
                itemBuilder: (context, i) {
                  if (hasDroppedHeader && i == 0) {
                    return _DroppedHeader(count: log.droppedTurns);
                  }
                  final idx = i - extraTop;
                  if (idx < groups.length) {
                    return _TurnGroupTile(
                      turns: groups[idx],
                      toolResults: toolResults,
                      agentName: widget.agentName,
                      theme: theme,
                    );
                  }
                  final tail = idx - groups.length;
                  if (showTyping && tail == 0) {
                    return _TypingBubble(theme: theme);
                  }
                  return _ErrorRow(log.lastError!);
                },
              ),
              // Floating "scroll to bottom" chevron — appears when the
              // user has scrolled up from the live edge.
              AnimatedPositioned(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                right: 14,
                bottom: _showScrollToBottom ? 14 : -40,
                child: AnimatedOpacity(
                  duration: const Duration(milliseconds: 180),
                  opacity: _showScrollToBottom ? 1 : 0,
                  child: _ScrollToBottomChip(
                    onTap: () => _scrollToBottom(animated: true),
                  ),
                ),
              ),
            ],
          ),
        ),
        _ChatComposer(onSend: widget.onSend, agentName: widget.agentName, theme: theme),
      ],
    );
  }
}

/// Hero empty state — big circular avatar with the agent's color and
/// initial, welcome line, hint. Replaces the small icon + text combo.
class _EmptyState extends StatelessWidget {
  final String agentName;
  final bool waiting;
  final String waitingReason;
  const _EmptyState({
    required this.agentName,
    required this.waiting,
    required this.waitingReason,
  });

  @override
  Widget build(BuildContext context) {
    final theme = _themeFor(agentName);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 72,
              height: 72,
              decoration: BoxDecoration(
                color: theme.soft,
                shape: BoxShape.circle,
                border: Border.all(color: theme.accent.withValues(alpha: 0.4), width: 2),
              ),
              alignment: Alignment.center,
              child: Text(
                theme.initial,
                style: TextStyle(
                  color: theme.accent,
                  fontSize: 30,
                  fontWeight: FontWeight.w800,
                  fontFamily: 'JetBrainsMono',
                ),
              ),
            ),
            const SizedBox(height: 18),
            Text(
              waiting ? '$agentName is warming up' : 'Talk to $agentName',
              textAlign: TextAlign.center,
              style: const TextStyle(color: LoopsyColors.fg, fontSize: 17, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            Text(
              waiting
                  ? waitingReason
                  : 'Send a prompt below. Your conversation will live here in real time, with reasoning and tool calls expandable on demand.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: LoopsyColors.muted, fontSize: 13, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }
}

/// Small avatar circle with the sender's initial. Used inline at the top
/// of each turn group instead of the old icon+text label.
class _Avatar extends StatelessWidget {
  final _AgentTheme theme;
  final bool isUser;
  const _Avatar({required this.theme, required this.isUser});

  @override
  Widget build(BuildContext context) {
    final bg = isUser ? LoopsyColors.surfaceAlt : theme.soft;
    final fg = isUser ? LoopsyColors.muted : theme.accent;
    final border = isUser ? LoopsyColors.border : theme.accent.withValues(alpha: 0.45);
    return Container(
      width: 26,
      height: 26,
      decoration: BoxDecoration(
        color: bg,
        shape: BoxShape.circle,
        border: Border.all(color: border, width: 1.2),
      ),
      alignment: Alignment.center,
      child: Text(
        isUser ? 'Y' : theme.initial,
        style: TextStyle(
          color: fg,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          fontFamily: 'JetBrainsMono',
        ),
      ),
    );
  }
}

/// Animated typing bubble — three pulsing dots inside a left-aligned
/// chat bubble, sized like a real message. Replaces the old inline
/// "Claude is working…" row for a much more chat-app-native feel.
class _TypingBubble extends StatefulWidget {
  final _AgentTheme theme;
  const _TypingBubble({required this.theme});

  @override
  State<_TypingBubble> createState() => _TypingBubbleState();
}

class _TypingBubbleState extends State<_TypingBubble> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  static double _dotPhase(int dot, double t) {
    final shifted = (t - dot * 0.16) % 1.0;
    return shifted < 0.5 ? shifted * 2 : (1 - shifted) * 2;
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          _Avatar(theme: widget.theme, isUser: false),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: LoopsyColors.surface,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(4),
                topRight: Radius.circular(16),
                bottomLeft: Radius.circular(16),
                bottomRight: Radius.circular(16),
              ),
              border: Border.all(color: LoopsyColors.border),
            ),
            child: AnimatedBuilder(
              animation: _c,
              builder: (_, __) => Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (int i = 0; i < 3; i++) ...[
                    Opacity(
                      opacity: 0.35 + 0.65 * _dotPhase(i, _c.value),
                      child: Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          color: widget.theme.accent,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                    if (i < 2) const SizedBox(width: 5),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ScrollToBottomChip extends StatelessWidget {
  final VoidCallback onTap;
  const _ScrollToBottomChip({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: LoopsyColors.surfaceAlt,
      shape: const CircleBorder(),
      elevation: 4,
      shadowColor: Colors.black.withValues(alpha: 0.35),
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: Container(
          width: 36,
          height: 36,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            border: Border.all(color: LoopsyColors.border),
          ),
          child: const HugeIcon(
            icon: HugeIcons.strokeRoundedArrowDown02,
            color: LoopsyColors.fg,
            size: 18,
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

/// One visual tile per *group* of consecutive same-role turns.
class _TurnGroupTile extends StatefulWidget {
  final List<ChatTurn> turns;
  final Map<String, ToolResultBlock> toolResults;
  final String agentName;
  final _AgentTheme theme;
  const _TurnGroupTile({
    required this.turns,
    required this.toolResults,
    required this.agentName,
    required this.theme,
  });

  @override
  State<_TurnGroupTile> createState() => _TurnGroupTileState();
}

class _TurnGroupTileState extends State<_TurnGroupTile> {
  bool _internalsExpanded = false;

  @override
  Widget build(BuildContext context) {
    final isUser = widget.turns.first.role == ChatRole.user;
    final allBlocks = widget.turns.expand((t) => t.blocks).toList();
    final responseBlocks = isUser
        ? allBlocks
        : allBlocks.whereType<TextBlock>().cast<ChatBlock>().toList();
    final internalBlocks = isUser
        ? const <ChatBlock>[]
        : allBlocks.where((b) => b is ThinkingBlock || b is ToolUseBlock).toList();
    final thinkingCount = internalBlocks.whereType<ThinkingBlock>().length;
    final toolCount = internalBlocks.whereType<ToolUseBlock>().length;

    final content = Column(
      crossAxisAlignment: isUser ? CrossAxisAlignment.end : CrossAxisAlignment.start,
      children: [
        for (final b in responseBlocks)
          _BlockView(block: b, isUser: isUser, theme: widget.theme),
        if (internalBlocks.isNotEmpty) ...[
          const SizedBox(height: 6),
          _InternalsToggle(
            thinkingCount: thinkingCount,
            toolCount: toolCount,
            expanded: _internalsExpanded,
            theme: widget.theme,
            onTap: () => setState(() => _internalsExpanded = !_internalsExpanded),
          ),
          if (_internalsExpanded)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  for (final b in internalBlocks) ...[
                    _BlockView(block: b, isUser: false, theme: widget.theme),
                    if (b is ToolUseBlock && widget.toolResults[b.id] != null)
                      _BlockView(
                        block: widget.toolResults[b.id]!,
                        isUser: false,
                        theme: widget.theme,
                      ),
                  ],
                ],
              ),
            ),
        ],
      ],
    );

    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: isUser
            ? [
                const SizedBox(),
                Expanded(child: content),
                const SizedBox(width: 8),
                _Avatar(theme: widget.theme, isUser: true),
              ]
            : [
                _Avatar(theme: widget.theme, isUser: false),
                const SizedBox(width: 8),
                Expanded(child: content),
              ],
      ),
    );
  }
}

/// Compact reasoning/tools pill — accent-tinted border so each agent's
/// chat has its own subtle visual signature.
class _InternalsToggle extends StatelessWidget {
  final int thinkingCount;
  final int toolCount;
  final bool expanded;
  final _AgentTheme theme;
  final VoidCallback onTap;
  const _InternalsToggle({
    required this.thinkingCount,
    required this.toolCount,
    required this.expanded,
    required this.theme,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final parts = <String>[];
    if (thinkingCount > 0) parts.add(thinkingCount == 1 ? 'reasoning' : 'reasoning ($thinkingCount)');
    if (toolCount > 0) parts.add(toolCount == 1 ? '1 tool' : '$toolCount tools');
    final label = parts.join(' · ');
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
        decoration: BoxDecoration(
          color: theme.soft.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: theme.accent.withValues(alpha: 0.35)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            HugeIcon(
              icon: expanded
                  ? HugeIcons.strokeRoundedArrowUp02
                  : HugeIcons.strokeRoundedArrowDown02,
              color: theme.accent.withValues(alpha: 0.85),
              size: 11,
            ),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                color: theme.accent.withValues(alpha: 0.95),
                fontSize: 10.5,
                fontWeight: FontWeight.w700,
                fontFamily: 'JetBrainsMono',
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _BlockView extends StatelessWidget {
  final ChatBlock block;
  final bool isUser;
  final _AgentTheme theme;
  const _BlockView({required this.block, required this.isUser, required this.theme});

  @override
  Widget build(BuildContext context) {
    switch (block) {
      case TextBlock(:final text):
        return _TextBubble(text: text, isUser: isUser, theme: theme);
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

/// iMessage-shaped bubble: rounded except for the "tail" corner facing
/// the sender's avatar. User bubbles use the loopsy accent gradient;
/// assistant bubbles use the surface card.
class _TextBubble extends StatelessWidget {
  final String text;
  final bool isUser;
  final _AgentTheme theme;
  const _TextBubble({required this.text, required this.isUser, required this.theme});

  @override
  Widget build(BuildContext context) {
    final bubbleShape = isUser
        ? const BorderRadius.only(
            topLeft: Radius.circular(16),
            topRight: Radius.circular(4),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          )
        : const BorderRadius.only(
            topLeft: Radius.circular(4),
            topRight: Radius.circular(16),
            bottomLeft: Radius.circular(16),
            bottomRight: Radius.circular(16),
          );
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.78),
        child: Container(
          margin: const EdgeInsets.only(top: 2, bottom: 2),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: isUser ? LoopsyColors.accentDark : LoopsyColors.surface,
            borderRadius: bubbleShape,
            border: Border.all(
              color: isUser ? LoopsyColors.accentDark : LoopsyColors.border,
            ),
          ),
          child: isUser
              ? SelectableText(
                  text,
                  style: const TextStyle(color: LoopsyColors.fg, fontSize: 14.5, height: 1.4),
                )
              : MarkdownText(
                  text,
                  baseStyle: const TextStyle(color: LoopsyColors.fg, fontSize: 14.5, height: 1.5),
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

/// Bottom-anchored composer with a frosted backdrop blur, pill-shaped
/// input, and an animated send button that lights up with the agent's
/// accent color when text is present. Designed to feel modern + chat-
/// app native, not "form input dropped at the bottom".
class _ChatComposer extends StatefulWidget {
  final void Function(String text)? onSend;
  final String agentName;
  final _AgentTheme theme;
  const _ChatComposer({required this.onSend, required this.agentName, required this.theme});

  @override
  State<_ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<_ChatComposer> {
  final TextEditingController _ctl = TextEditingController();
  final FocusNode _focus = FocusNode();
  bool _hasText = false;
  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _ctl.addListener(() {
      final has = _ctl.text.trim().isNotEmpty;
      if (has != _hasText) setState(() => _hasText = has);
    });
    _focus.addListener(() {
      if (_focus.hasFocus != _focused) setState(() => _focused = _focus.hasFocus);
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
    _focus.requestFocus();
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onSend != null;
    return ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
        child: Container(
          decoration: BoxDecoration(
            color: LoopsyColors.surface.withValues(alpha: 0.92),
            border: const Border(top: BorderSide(color: LoopsyColors.border)),
          ),
          child: SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 10, 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: AnimatedContainer(
                      duration: const Duration(milliseconds: 150),
                      curve: Curves.easeOut,
                      decoration: BoxDecoration(
                        color: LoopsyColors.surfaceAlt,
                        borderRadius: BorderRadius.circular(22),
                        border: Border.all(
                          color: _focused ? widget.theme.accent : LoopsyColors.border,
                          width: _focused ? 1.5 : 1,
                        ),
                        boxShadow: _focused
                            ? [
                                BoxShadow(
                                  color: widget.theme.accent.withValues(alpha: 0.18),
                                  blurRadius: 16,
                                  spreadRadius: 0,
                                ),
                              ]
                            : null,
                      ),
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                      child: TextField(
                        controller: _ctl,
                        focusNode: _focus,
                        enabled: enabled,
                        minLines: 1,
                        maxLines: 6,
                        textCapitalization: TextCapitalization.sentences,
                        textInputAction: TextInputAction.send,
                        onSubmitted: (_) => _send(),
                        style: const TextStyle(color: LoopsyColors.fg, fontSize: 15, height: 1.4),
                        decoration: InputDecoration(
                          hintText: enabled ? 'Message ${widget.agentName}…' : 'Disconnected',
                          hintStyle: const TextStyle(color: LoopsyColors.muted, fontSize: 15),
                          border: InputBorder.none,
                          isDense: true,
                          contentPadding: const EdgeInsets.symmetric(vertical: 10),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  _SendButton(
                    enabled: _hasText && enabled,
                    accent: widget.theme.accent,
                    onTap: _send,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Animated send button. Inactive state is a muted neutral circle; on
/// "ready" the background fills with the agent's accent and the icon
/// flips to high-contrast — telegraphs "ready to fly."
class _SendButton extends StatelessWidget {
  final bool enabled;
  final Color accent;
  final VoidCallback onTap;
  const _SendButton({required this.enabled, required this.accent, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: const Duration(milliseconds: 160),
      curve: Curves.easeOut,
      decoration: BoxDecoration(
        gradient: enabled
            ? LinearGradient(
                colors: [accent, Color.lerp(accent, Colors.white, 0.18) ?? accent],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              )
            : null,
        color: enabled ? null : LoopsyColors.surfaceAlt,
        shape: BoxShape.circle,
        boxShadow: enabled
            ? [
                BoxShadow(
                  color: accent.withValues(alpha: 0.45),
                  blurRadius: 14,
                  offset: const Offset(0, 4),
                ),
              ]
            : null,
      ),
      child: Material(
        color: Colors.transparent,
        shape: const CircleBorder(),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: const EdgeInsets.all(13),
            child: HugeIcon(
              icon: HugeIcons.strokeRoundedSent,
              color: enabled ? LoopsyColors.bg : LoopsyColors.muted,
              size: 18,
            ),
          ),
        ),
      ),
    );
  }
}
