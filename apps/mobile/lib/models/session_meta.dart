/// Lightweight metadata about a session we've opened, persisted so the app
/// can reattach across cold starts.
class SessionMeta {
  final String id;
  final String agent; // 'shell' | 'claude' | 'gemini' | 'codex'
  final int lastUsedMs;
  /// User-editable display name. Falls back to [summary] then to "[agent] session".
  final String? name;
  /// Auto-captured short description (typically the first command/prompt the
  /// user sent in this session) to help recognize chats at a glance.
  final String? summary;
  /// Auto-approve actions the agent wants to take, without prompting. Maps to
  /// `--dangerously-skip-permissions` (claude), `-y` (gemini), `--full-auto`
  /// (codex). Saved per-session so resume reuses the same mode.
  final bool auto;

  const SessionMeta({
    required this.id,
    required this.agent,
    required this.lastUsedMs,
    this.name,
    this.summary,
    this.auto = false,
  });

  String displayName() {
    if (name != null && name!.trim().isNotEmpty) return name!.trim();
    if (summary != null && summary!.trim().isNotEmpty) {
      final s = summary!.trim();
      return s.length > 60 ? '${s.substring(0, 60)}…' : s;
    }
    return '$agent session';
  }

  SessionMeta copyWith({String? name, String? summary, int? lastUsedMs, bool? auto}) =>
      SessionMeta(
        id: id,
        agent: agent,
        lastUsedMs: lastUsedMs ?? this.lastUsedMs,
        name: name ?? this.name,
        summary: summary ?? this.summary,
        auto: auto ?? this.auto,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'agent': agent,
        'lastUsedMs': lastUsedMs,
        if (name != null) 'name': name,
        if (summary != null) 'summary': summary,
        if (auto) 'auto': true,
      };

  factory SessionMeta.fromJson(Map<String, dynamic> j) => SessionMeta(
        id: j['id'] as String,
        agent: j['agent'] as String,
        lastUsedMs: (j['lastUsedMs'] as num).toInt(),
        name: j['name'] as String?,
        summary: j['summary'] as String?,
        auto: j['auto'] as bool? ?? false,
      );
}
