import 'dart:math';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';

import '../models/pairing.dart';
import '../models/session_meta.dart';
import '../services/relay_client.dart';
import '../services/storage.dart';
import '../theme.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Pairing? _pairing;
  List<SessionMeta> _sessions = const [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final pairing = await Storage.readPairing();
    if (pairing == null) {
      if (mounted) context.go('/pair');
      return;
    }
    final sessions = await Storage.readSessions();
    if (!mounted) return;
    setState(() {
      _pairing = pairing;
      _sessions = sessions;
      _loading = false;
    });
  }

  Future<void> _newSession() async {
    final agent = await _pickAgent();
    if (agent == null) return;
    // CSO #4: auto-approve now defaults to OFF, even for AI agents. Skipping
    // permission prompts on the laptop is too powerful to be the default for
    // a remote phone — a stolen unlocked device shouldn't grant unrestricted
    // shell + agent capabilities. The user opts in per session.
    bool auto = false;
    if (agent != 'shell') {
      final res = await _promptAutoApprove(agent, initial: auto);
      if (res == null) return;
      auto = res;
    }
    final name = await _promptName(initial: '', title: 'Name this session?');
    final id = _newUuidV4();
    final meta = SessionMeta(
      id: id,
      agent: agent,
      lastUsedMs: DateTime.now().millisecondsSinceEpoch,
      name: (name != null && name.trim().isNotEmpty) ? name.trim() : null,
      auto: auto,
    );
    final next = [meta, ..._sessions];
    await Storage.writeSessions(next);
    if (!mounted) return;
    setState(() => _sessions = next);
    context.push('/terminal/$id?fresh=1&agent=$agent&auto=${auto ? 1 : 0}');
  }

  Future<bool?> _promptAutoApprove(String agent, {required bool initial}) async {
    final flagDescription = switch (agent) {
      'claude' => '--dangerously-skip-permissions',
      'gemini' => '-y',
      'codex'  => '--full-auto',
      _        => '',
    };
    return showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: LoopsyColors.surface,
        title: const Text('Auto-approve actions?'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Skip the agent\'s confirmation prompts so you don\'t have to keep tapping "yes" on the phone.',
              style: const TextStyle(color: LoopsyColors.muted, fontSize: 13),
            ),
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: LoopsyColors.surfaceAlt,
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                '$agent $flagDescription',
                style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              'The agent will execute file edits, shell commands, etc. without asking. Make sure you trust the prompt.',
              style: const TextStyle(color: LoopsyColors.warn, fontSize: 12),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Stay safe')),
          ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Auto-approve')),
        ],
      ),
    );
  }

  Future<String?> _pickAgent() async {
    return showModalBottomSheet<String>(
      context: context,
      backgroundColor: LoopsyColors.surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
      ),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(20, 16, 20, 8),
              child: Row(
                children: [
                  HugeIcon(icon: HugeIcons.strokeRoundedAddSquare, color: LoopsyColors.accent, size: 22),
                  SizedBox(width: 10),
                  Text('Start a session', style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                ],
              ),
            ),
            ..._agentTile(ctx, 'shell',  HugeIcons.strokeRoundedCommandLine,    'Bash on your laptop'),
            ..._agentTile(ctx, 'claude', HugeIcons.strokeRoundedAiChat02,    'Claude Code'),
            ..._agentTile(ctx, 'gemini', HugeIcons.strokeRoundedAiBrain02,   'Gemini CLI'),
            ..._agentTile(ctx, 'codex',  HugeIcons.strokeRoundedSourceCode,  'OpenAI Codex CLI'),
            const SizedBox(height: 12),
          ],
        ),
      ),
    );
  }

  Future<String?> _promptName({required String initial, required String title}) async {
    final ctl = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: LoopsyColors.surface,
        title: Text(title),
        content: TextField(
          controller: ctl,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'e.g. fix logging bug'),
          textCapitalization: TextCapitalization.sentences,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Skip')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, ctl.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  List<Widget> _agentTile(BuildContext ctx, String agent, IconData icon, String subtitle) => [
        ListTile(
          leading: HugeIcon(icon: icon, color: LoopsyColors.fg),
          title: Text(agent, style: const TextStyle(fontFamily: 'JetBrainsMono')),
          subtitle: Text(subtitle, style: const TextStyle(color: LoopsyColors.muted, fontSize: 12)),
          onTap: () => Navigator.pop(ctx, agent),
        ),
      ];

  Future<void> _resumeSession(SessionMeta s) async {
    if (!mounted) return;
    final res = await context.push(
      '/terminal/${s.id}?fresh=0&agent=${s.agent}&auto=${s.auto ? 1 : 0}',
    );
    // Refresh in case summary was just captured during the session.
    if (mounted) _load();
    if (res == 'closed') return;
  }

  Future<void> _renameSession(SessionMeta s) async {
    final name = await _promptName(initial: s.name ?? s.summary ?? '', title: 'Rename session');
    if (name == null) return;
    await Storage.updateSession(
      s.id,
      (m) => m.copyWith(name: name.trim().isEmpty ? null : name.trim()),
    );
    if (mounted) _load();
  }

  Future<void> _showSessionMenu(SessionMeta s) async {
    final action = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: LoopsyColors.surface,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(18))),
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const HugeIcon(icon: HugeIcons.strokeRoundedEdit01, color: LoopsyColors.fg),
              title: const Text('Rename'),
              onTap: () => Navigator.pop(ctx, 'rename'),
            ),
            ListTile(
              leading: const HugeIcon(icon: HugeIcons.strokeRoundedRemove01, color: LoopsyColors.warn),
              title: const Text('Remove from list'),
              subtitle: const Text('Keeps the laptop session running.'),
              onTap: () => Navigator.pop(ctx, 'remove'),
            ),
            ListTile(
              leading: const HugeIcon(icon: HugeIcons.strokeRoundedDelete02, color: LoopsyColors.bad),
              title: const Text('Delete'),
              subtitle: const Text('Stops the laptop session, removes from list.'),
              onTap: () => Navigator.pop(ctx, 'delete'),
            ),
            const SizedBox(height: 8),
          ],
        ),
      ),
    );
    if (action == 'rename') return _renameSession(s);
    if (action == 'remove') return _removeFromList(s);
    if (action == 'delete') return _deleteSession(s);
  }

  Future<void> _removeFromList(SessionMeta s) async {
    final next = _sessions.where((e) => e.id != s.id).toList();
    await Storage.writeSessions(next);
    if (mounted) setState(() => _sessions = next);
  }

  Future<void> _deleteSession(SessionMeta s) async {
    if (_pairing == null) return;
    // Open a brief WS, send session-close, drop the connection.
    final session = RelaySession(
      pairing: _pairing!,
      sessionId: s.id,
      onPty: (_) {},
      onClose: (_, __) {},
    );
    try {
      await session.open(agent: s.agent, cols: 80, rows: 24);
      await Future<void>.delayed(const Duration(milliseconds: 250));
      await session.killOnDaemon();
    } catch (_) {/* best-effort; remove locally regardless */}
    await _removeFromList(s);
  }

  Future<void> _resetPairing() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: LoopsyColors.surface,
        title: const Text('Forget pairing?'),
        content: const Text(
          'You’ll need to re-scan a pair QR from your laptop to reconnect.',
          style: TextStyle(color: LoopsyColors.muted),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Forget')),
        ],
      ),
    );
    if (ok != true) return;
    // CSO #8: also revoke on the relay so the phone record stops existing
    // server-side. Without this, a stolen device backup with the
    // phone_secret could keep connecting.
    final p = _pairing;
    if (p != null) await selfRevoke(p);
    await Storage.deletePairing();
    if (!mounted) return;
    context.go('/pair');
  }

  String _newUuidV4() {
    final r = Random.secure();
    final b = List<int>.generate(16, (_) => r.nextInt(256));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
    return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20, 32)}';
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final p = _pairing!;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Loopsy'),
        actions: [
          IconButton(
            icon: const HugeIcon(icon: HugeIcons.strokeRoundedSettings02, color: LoopsyColors.fg),
            onPressed: _resetPairing,
            tooltip: 'Settings',
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
          children: [
            // Paired-device card
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Container(
                          width: 36,
                          height: 36,
                          decoration: BoxDecoration(
                            color: LoopsyColors.surfaceAlt,
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: LoopsyColors.border),
                          ),
                          child: const HugeIcon(icon: HugeIcons.strokeRoundedLaptop, color: LoopsyColors.accent),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'Paired laptop',
                                style: TextStyle(color: LoopsyColors.muted, fontSize: 12),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                p.deviceId,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 12),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 10),
                    Row(
                      children: [
                        const HugeIcon(icon: HugeIcons.strokeRoundedGlobe02, color: LoopsyColors.muted, size: 14),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            p.relayUrl,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: LoopsyColors.muted, fontSize: 11),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),

            const SizedBox(height: 24),
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: 4, vertical: 8),
              child: Text(
                'Sessions',
                style: TextStyle(fontWeight: FontWeight.w600, color: LoopsyColors.muted),
              ),
            ),

            if (_sessions.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 24),
                child: Column(
                  children: [
                    const HugeIcon(
                      icon: HugeIcons.strokeRoundedCommandLine,
                      color: LoopsyColors.muted,
                      size: 36,
                    ),
                    const SizedBox(height: 12),
                    const Text(
                      'No sessions yet.',
                      style: TextStyle(color: LoopsyColors.muted),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Tap + to start one.',
                      style: TextStyle(color: LoopsyColors.muted.withValues(alpha: 0.7), fontSize: 12),
                    ),
                  ],
                ),
              )
            else
              ..._sessions.map((s) => _SessionCard(
                    session: s,
                    onTap: () => _resumeSession(s),
                    onMore: () => _showSessionMenu(s),
                  )),
          ],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _newSession,
        icon: const HugeIcon(icon: HugeIcons.strokeRoundedAdd01, color: LoopsyColors.bg),
        label: const Text('New session'),
      ),
    );
  }
}

class _SessionCard extends StatelessWidget {
  final SessionMeta session;
  final VoidCallback onTap;
  final VoidCallback onMore;

  const _SessionCard({required this.session, required this.onTap, required this.onMore});

  IconData _iconFor() {
    switch (session.agent) {
      case 'claude': return HugeIcons.strokeRoundedAiChat02;
      case 'gemini': return HugeIcons.strokeRoundedAiBrain02;
      case 'codex':  return HugeIcons.strokeRoundedSourceCode;
      default:       return HugeIcons.strokeRoundedCommandLine;
    }
  }

  @override
  Widget build(BuildContext context) {
    final hasName = session.name != null && session.name!.trim().isNotEmpty;
    final hasSummary = session.summary != null && session.summary!.trim().isNotEmpty;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          onLongPress: onMore,
          child: Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 40,
                  height: 40,
                  decoration: BoxDecoration(
                    color: LoopsyColors.surfaceAlt,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: HugeIcon(icon: _iconFor(), color: LoopsyColors.accent),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        hasName ? session.name! : (hasSummary ? session.summary! : '${session.agent} session'),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
                      ),
                      const SizedBox(height: 4),
                      Row(
                        children: [
                          Container(
                            padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                            decoration: BoxDecoration(
                              color: LoopsyColors.surfaceAlt,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: Text(
                              session.agent,
                              style: const TextStyle(
                                color: LoopsyColors.muted,
                                fontSize: 11,
                                fontFamily: 'JetBrainsMono',
                              ),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            session.id.substring(0, 6),
                            style: const TextStyle(color: LoopsyColors.muted, fontSize: 11, fontFamily: 'JetBrainsMono'),
                          ),
                          if (hasName && hasSummary) ...[
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                session.summary!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(color: LoopsyColors.muted, fontSize: 11),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
                IconButton(
                  icon: const HugeIcon(icon: HugeIcons.strokeRoundedMoreVertical, color: LoopsyColors.muted, size: 18),
                  onPressed: onMore,
                  tooltip: 'More',
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
