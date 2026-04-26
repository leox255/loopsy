/// Lightweight metadata about a session we've opened, persisted so the app
/// can reattach across cold starts.
class SessionMeta {
  final String id;
  final String agent; // 'shell' | 'claude' | 'gemini' | 'codex'
  final int lastUsedMs;

  const SessionMeta({required this.id, required this.agent, required this.lastUsedMs});

  Map<String, dynamic> toJson() => {
        'id': id,
        'agent': agent,
        'lastUsedMs': lastUsedMs,
      };

  factory SessionMeta.fromJson(Map<String, dynamic> j) => SessionMeta(
        id: j['id'] as String,
        agent: j['agent'] as String,
        lastUsedMs: (j['lastUsedMs'] as num).toInt(),
      );
}
