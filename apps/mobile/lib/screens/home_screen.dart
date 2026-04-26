import 'dart:math';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../models/pairing.dart';
import '../models/session_meta.dart';
import '../services/storage.dart';

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
    final agent = await showModalBottomSheet<String>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: const ['shell', 'claude', 'gemini', 'codex']
              .map((a) => ListTile(
                    leading: const Icon(Icons.terminal),
                    title: Text(a),
                    onTap: () => Navigator.pop(ctx, a),
                  ))
              .toList(),
        ),
      ),
    );
    if (agent == null) return;
    final id = _newUuidV4();
    final meta = SessionMeta(id: id, agent: agent, lastUsedMs: DateTime.now().millisecondsSinceEpoch);
    final next = [meta, ..._sessions];
    await Storage.writeSessions(next);
    if (!mounted) return;
    context.push('/terminal/$id?fresh=1&agent=$agent');
  }

  Future<void> _resumeSession(SessionMeta s) async {
    if (!mounted) return;
    context.push('/terminal/${s.id}?fresh=0&agent=${s.agent}');
  }

  Future<void> _removeSession(SessionMeta s) async {
    final next = _sessions.where((e) => e.id != s.id).toList();
    await Storage.writeSessions(next);
    if (!mounted) return;
    setState(() => _sessions = next);
  }

  Future<void> _resetPairing() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Forget pairing?'),
        content: const Text('You\'ll need to re-scan a pair QR from your laptop to reconnect.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Forget')),
        ],
      ),
    );
    if (ok != true) return;
    await Storage.deletePairing();
    if (!mounted) return;
    context.go('/pair');
  }

  String _newUuidV4() {
    final r = Random.secure();
    final bytes = List<int>.generate(16, (_) => r.nextInt(256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    String hex(int n, int len) => n.toRadixString(16).padLeft(len, '0');
    final h = bytes.map((b) => hex(b, 2)).join();
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
          IconButton(icon: const Icon(Icons.settings), onPressed: _resetPairing),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('Paired with', style: TextStyle(fontSize: 12, color: Colors.grey)),
                Text(p.deviceId, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                const SizedBox(height: 4),
                Text(p.relayUrl, style: const TextStyle(color: Colors.grey, fontSize: 11)),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: _sessions.isEmpty
                ? const Center(child: Text('No sessions yet. Tap + to start one.'))
                : ListView.separated(
                    itemCount: _sessions.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (ctx, i) {
                      final s = _sessions[i];
                      return ListTile(
                        leading: const Icon(Icons.terminal),
                        title: Text(s.agent),
                        subtitle: Text('${s.id.substring(0, 8)}…'),
                        trailing: IconButton(
                          icon: const Icon(Icons.close),
                          onPressed: () => _removeSession(s),
                        ),
                        onTap: () => _resumeSession(s),
                      );
                    },
                  ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: _newSession,
        child: const Icon(Icons.add),
      ),
    );
  }
}
