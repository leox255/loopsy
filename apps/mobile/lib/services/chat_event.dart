/// Dart model for the daemon's `ChatEvent` wire shape — see
/// `packages/daemon/src/services/chat-event-stream.ts` for the canonical
/// definition. We hand-roll this because freezed/json_serializable would
/// add a build-runner step the rest of the mobile app currently avoids.
///
/// The events arrive over the existing relay WebSocket as
/// `{"type":"chat-event","sessionId":"...","event":<ChatEvent>}` — this
/// file only handles the inner `event` object.
library;

enum ChatRole { user, assistant }

sealed class ChatBlock {
  const ChatBlock();

  static ChatBlock? fromJson(Map<String, dynamic> json) {
    final t = json['type'];
    if (t is! String) return null;
    switch (t) {
      case 'text':
        return TextBlock(json['text'] as String? ?? '');
      case 'thinking':
        return ThinkingBlock(json['text'] as String? ?? '');
      case 'tool_use':
        return ToolUseBlock(
          id: json['id'] as String? ?? '',
          name: json['name'] as String? ?? '',
          input: json['input'],
        );
      case 'tool_result':
        return ToolResultBlock(
          toolUseId: json['toolUseId'] as String? ?? '',
          content: json['content'],
          isError: json['isError'] == true,
          truncated: json['truncated'] == true,
        );
      default:
        return null;
    }
  }
}

class TextBlock extends ChatBlock {
  final String text;
  const TextBlock(this.text);
}

class ThinkingBlock extends ChatBlock {
  final String text;
  const ThinkingBlock(this.text);
}

class ToolUseBlock extends ChatBlock {
  final String id;
  final String name;
  final dynamic input;
  const ToolUseBlock({required this.id, required this.name, required this.input});
}

class ToolResultBlock extends ChatBlock {
  final String toolUseId;
  final dynamic content;
  final bool isError;
  final bool truncated;
  const ToolResultBlock({
    required this.toolUseId,
    required this.content,
    required this.isError,
    this.truncated = false,
  });
}

sealed class ChatEvent {
  const ChatEvent();

  /// Parse a daemon-supplied event payload. Returns null for unknown shapes
  /// so the UI can simply ignore them (forward compatibility — the daemon
  /// may emit new event kinds in a future build).
  static ChatEvent? fromJson(Map<String, dynamic> json) {
    final kind = json['kind'];
    if (kind is! String) return null;
    switch (kind) {
      case 'capability':
        return ChatCapability(
          available: json['chat'] == 'available',
          reason: json['reason'] as String?,
        );
      case 'turn-start':
        return ChatTurnStart(
          turnId: json['turnId'] as String? ?? '',
          role: json['role'] == 'user' ? ChatRole.user : ChatRole.assistant,
          ts: json['ts'] as String?,
          messageId: json['messageId'] as String?,
        );
      case 'block':
        final raw = json['block'];
        if (raw is! Map<String, dynamic>) return null;
        final block = ChatBlock.fromJson(raw);
        if (block == null) return null;
        return ChatBlockEvent(
          turnId: json['turnId'] as String? ?? '',
          messageId: json['messageId'] as String? ?? '',
          index: (json['index'] as num?)?.toInt() ?? 0,
          block: block,
        );
      case 'turn-end':
        return ChatTurnEnd(
          turnId: json['turnId'] as String? ?? '',
          stopReason: json['stopReason'] as String?,
        );
      case 'error':
        return ChatError(
          code: json['code'] as String? ?? 'unknown',
          message: json['message'] as String? ?? '',
        );
      default:
        return null;
    }
  }
}

class ChatCapability extends ChatEvent {
  final bool available;
  final String? reason;
  const ChatCapability({required this.available, this.reason});
}

class ChatTurnStart extends ChatEvent {
  final String turnId;
  final ChatRole role;
  final String? ts;
  final String? messageId;
  const ChatTurnStart({required this.turnId, required this.role, this.ts, this.messageId});
}

class ChatBlockEvent extends ChatEvent {
  final String turnId;
  final String messageId;
  final int index;
  final ChatBlock block;
  const ChatBlockEvent({
    required this.turnId,
    required this.messageId,
    required this.index,
    required this.block,
  });
}

class ChatTurnEnd extends ChatEvent {
  final String turnId;
  final String? stopReason;
  const ChatTurnEnd({required this.turnId, this.stopReason});
}

class ChatError extends ChatEvent {
  final String code;
  final String message;
  const ChatError({required this.code, required this.message});
}

/// Aggregated state of a chat conversation, fed by a stream of ChatEvents.
/// The widget layer just calls [apply] on each event and re-reads [turns].
class ChatLog {
  final List<ChatTurn> turns = [];
  bool available = false;
  String? unavailableReason;
  String? lastError;

  void apply(ChatEvent ev) {
    switch (ev) {
      case ChatCapability(:final available, :final reason):
        this.available = available;
        unavailableReason = available ? null : reason;
      case ChatTurnStart(:final turnId, :final role, :final ts, :final messageId):
        // Merge with any in-progress turn that already has this turnId
        // (replay can deliver overlapping turn-start frames).
        final existing = turns.indexWhere((t) => t.turnId == turnId);
        if (existing < 0) {
          turns.add(ChatTurn(turnId: turnId, role: role, ts: ts, messageId: messageId));
        }
      case ChatBlockEvent(:final turnId, :final block):
        // createIfMissing: true so this is non-null. The `!` is here only
        // because Dart's flow analysis can't see through the default-arg.
        final t = _turnFor(turnId)!;
        t.blocks.add(block);
      case ChatTurnEnd(:final turnId, :final stopReason):
        final t = _turnFor(turnId, createIfMissing: false);
        if (t != null) t.stopReason = stopReason;
      case ChatError(:final code, :final message):
        lastError = '$code: $message';
    }
  }

  ChatTurn? _turnFor(String turnId, {bool createIfMissing = true}) {
    for (final t in turns) {
      if (t.turnId == turnId) return t;
    }
    if (!createIfMissing) return null;
    final t = ChatTurn(turnId: turnId, role: ChatRole.assistant);
    turns.add(t);
    return t;
  }
}

class ChatTurn {
  final String turnId;
  final ChatRole role;
  final String? ts;
  final String? messageId;
  final List<ChatBlock> blocks = [];
  String? stopReason;
  ChatTurn({required this.turnId, required this.role, this.ts, this.messageId});
}
