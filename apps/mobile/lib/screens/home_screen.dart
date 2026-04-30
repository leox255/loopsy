import 'dart:math';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';

import '../models/pairing.dart';
import '../models/session_meta.dart';
import '../services/relay_client.dart';
import '../services/storage.dart';
import '../theme.dart';
import '../widgets/loopsy_modal.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Pairing? _pairing;
  List<SessionMeta> _sessions = const [];
  bool _loading = true;
  // Cached daemon capabilities. Populated asynchronously after _load and
  // refreshed lazily; null until the first round-trip succeeds. Defaults
  // (assume everything available) are used if the daemon never answers
  // — graceful fallback for older daemons that don't speak device-info.
  DeviceInfo? _deviceInfo;

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
    // Probe the daemon in the background — non-blocking. If it never
    // answers (offline, old daemon, network hiccup) the agent picker
    // falls back to "show everything" rather than punishing the user.
    fetchDeviceInfo(pairing).then((info) {
      if (!mounted || info == null) return;
      setState(() => _deviceInfo = info);
    });
  }

  /// Show an add/edit modal for a [CustomCommand] and send the result to
  /// the daemon. On success, refresh the local DeviceInfo cache so the
  /// next picker render shows the new state.
  Future<void> _editCustomCommand(CustomCommand? existing) async {
    final pairing = _pairing;
    if (pairing == null) return;
    final labelCtl = TextEditingController(text: existing?.label ?? '');
    final commandCtl = TextEditingController(text: existing?.command ?? '');
    final argsCtl = TextEditingController(text: existing?.args.join(' ') ?? '');
    final isEdit = existing != null;
    final result = await showLoopsyDialog<Map<String, dynamic>?>(
      context: context,
      icon: HugeIcons.strokeRoundedConsole,
      title: isEdit ? 'Edit command' : 'Add custom command',
      subtitle: isEdit
          ? 'Update or delete this picker shortcut.'
          : 'Pin any CLI on your machine to the session picker.',
      body: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: labelCtl,
            autofocus: !isEdit,
            decoration: const InputDecoration(
              labelText: 'Label',
              hintText: 'Edit README',
            ),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: commandCtl,
            autocorrect: false,
            // iOS smart punctuation rewrites `--` → `—` and `'` → `'`
            // mid-typing, which silently breaks shell flags. Disable both.
            smartDashesType: SmartDashesType.disabled,
            smartQuotesType: SmartQuotesType.disabled,
            enableSuggestions: false,
            keyboardType: TextInputType.visiblePassword,
            decoration: const InputDecoration(
              labelText: 'Command',
              hintText: 'nvim',
            ),
            style: const TextStyle(fontFamily: 'JetBrainsMono'),
          ),
          const SizedBox(height: 10),
          TextField(
            controller: argsCtl,
            autocorrect: false,
            smartDashesType: SmartDashesType.disabled,
            smartQuotesType: SmartQuotesType.disabled,
            enableSuggestions: false,
            keyboardType: TextInputType.visiblePassword,
            decoration: const InputDecoration(
              labelText: 'Args (space-separated)',
              hintText: '--version',
            ),
            style: const TextStyle(fontFamily: 'JetBrainsMono'),
          ),
        ],
      ),
      actions: [
        if (isEdit)
          LoopsyModalAction.text('Delete', () => Navigator.pop(context, {'_delete': true})),
        LoopsyModalAction.text('Cancel', () => Navigator.pop(context)),
        LoopsyModalAction.primary('Save', () {
          final label = labelCtl.text.trim();
          final command = commandCtl.text.trim();
          if (label.isEmpty || command.isEmpty) return;
          Navigator.pop(context, {
            'label': label,
            'command': command,
            'args': argsCtl.text.trim().isEmpty
                ? <String>[]
                : argsCtl.text.trim().split(RegExp(r'\s+')),
          });
        }),
      ],
    );
    if (result == null) return;

    Map<String, dynamic> mutation;
    if (result['_delete'] == true && existing != null) {
      mutation = {'type': 'custom-command-remove', 'id': existing.id};
    } else if (existing != null) {
      mutation = {
        'type': 'custom-command-update',
        'command': {'id': existing.id, ...result},
      };
    } else {
      mutation = {'type': 'custom-command-add', 'command': result};
    }
    final updated = await mutateCustomCommands(pairing, mutation);
    if (!mounted) return;
    if (updated == null) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
        backgroundColor: LoopsyColors.surface,
        content: Text(
          'Could not reach the daemon. Check that your machine is online and try again.',
          style: TextStyle(color: LoopsyColors.bad),
        ),
      ));
      return;
    }
    setState(() {
      _deviceInfo = DeviceInfo(
        platform: _deviceInfo?.platform ?? 'unknown',
        hostname: _deviceInfo?.hostname,
        agents: _deviceInfo?.agents ?? const [],
        autoApproveSupported: _deviceInfo?.autoApproveSupported ?? false,
        customCommands: updated,
      );
    });
  }

  Future<void> _newSession() async {
    final picked = await _pickAgent();
    if (picked == null) return;
    // Three picker outcomes: spawn a built-in / custom (PickerChoice.spawn)
    // or attach to a running daemon-side session (PickerChoice.attach). The
    // attach path skips the name + auto-approve prompts because the PTY
    // already exists with its own state.
    if (picked.attachToRunning != null) {
      final r = picked.attachToRunning!;
      // Surface the running session in the local list so the user has a
      // way back to it from the home screen, but only if we don't
      // already track it.
      final exists = _sessions.any((s) => s.id == r.id);
      if (!exists) {
        final meta = SessionMeta(
          id: r.id,
          agent: r.agent,
          lastUsedMs: DateTime.now().millisecondsSinceEpoch,
          name: r.name,
          auto: false,
        );
        final next = [meta, ..._sessions];
        await Storage.writeSessions(next);
        if (!mounted) return;
        setState(() => _sessions = next);
      }
      // fresh=0 — daemon-side PTY exists; we just attach to it.
      context.push('/terminal/${r.id}?fresh=0&agent=${r.agent}&auto=0');
      return;
    }
    final agent = picked.agent;
    final customCommandId = picked.customCommandId;
    // CSO #4: auto-approve now defaults to OFF, even for AI agents. Skipping
    // permission prompts on the laptop is too powerful to be the default for
    // a remote phone — a stolen unlocked device shouldn't grant unrestricted
    // shell + agent capabilities. The user opts in per session.
    //
    // Auto-approve is only meaningful when the daemon's host can verify the
    // user password (currently macOS only — uses `dscl . -authonly`). On
    // Linux/Windows daemons we hide the toggle entirely and start the
    // session in normal-permission mode; users will see whatever consent
    // prompts the agent shows over the terminal.
    bool auto = false;
    final canAutoApprove = _deviceInfo == null
        ? true /* unknown daemon — fall back to current behaviour */
        : _deviceInfo!.autoApproveSupported;
    // Auto-approve only makes sense for agents that ship a documented
    // skip-permissions flag. opencode doesn't have one yet — its toggle
    // would be a no-op.
    final hasAutoApproveFlag = const {'claude', 'codex', 'gemini'}.contains(agent);
    if (hasAutoApproveFlag && canAutoApprove) {
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
    final qs = StringBuffer('fresh=1&agent=$agent&auto=${auto ? 1 : 0}');
    if (customCommandId != null) qs.write('&customCommandId=$customCommandId');
    context.push('/terminal/$id?$qs');
  }

  Future<bool?> _promptAutoApprove(String agent, {required bool initial}) async {
    final flag = switch (agent) {
      'claude' => '--dangerously-skip-permissions',
      'gemini' => '-y',
      'codex'  => '--full-auto',
      _        => '',
    };
    return showLoopsyDialog<bool>(
      context: context,
      icon: HugeIcons.strokeRoundedFlash,
      title: 'Auto-approve actions?',
      subtitle:
          'Skip the agent\'s confirmation prompts so you don\'t have to keep tapping "yes". '
          'The first auto-approve session will ask for your macOS password once — after that, future sessions skip it.',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: LoopsyColors.surfaceAlt,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(color: LoopsyColors.border),
            ),
            child: Text(
              '$agent $flag',
              style: const TextStyle(
                fontFamily: 'JetBrainsMono',
                fontSize: 12.5,
                color: LoopsyColors.fg,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const HugeIcon(icon: HugeIcons.strokeRoundedAlert02, color: LoopsyColors.warn, size: 16),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  'The agent will run file edits and shell commands without asking. Trust the prompt.',
                  style: const TextStyle(color: LoopsyColors.warn, fontSize: 12.5, height: 1.4),
                ),
              ),
            ],
          ),
        ],
      ),
      actions: [
        LoopsyModalAction.text('Cancel', () => Navigator.pop(context)),
        LoopsyModalAction.outlined('Stay safe', () => Navigator.pop(context, false)),
        LoopsyModalAction.primary('Auto-approve', () => Navigator.pop(context, true)),
      ],
    );
  }

  Future<_PickerResult?> _pickAgent() async {
    // If we already know what the daemon has installed, hide unavailable
    // agents from the picker so the user can't pick a binary that isn't on
    // PATH. If we don't know yet (older daemon, or device-info still in
    // flight) we show all four — the daemon will return a clear
    // session-error if the choice can't be honored.
    final installed = _deviceInfo?.agents;
    bool isInstalled(String agent) => installed == null || installed.contains(agent);

    final tiles = <Widget>[];

    // "Running on your machine" — daemon-side PTYs that aren't already
    // in the local home list. Lets the user resume a session they
    // started with `loopsy shell` (or another phone) without having to
    // re-spawn an agent. Sessions already tracked locally show up in
    // the home screen so we hide them here to avoid duplication.
    final allRunning = _deviceInfo?.sessions ?? const <RunningSession>[];
    final localIds = _sessions.map((s) => s.id).toSet();
    final unknownRunning = allRunning.where((r) => !localIds.contains(r.id)).toList();
    if (unknownRunning.isNotEmpty) {
      tiles.add(const Padding(
        padding: EdgeInsets.fromLTRB(4, 4, 4, 4),
        child: Text(
          'RUNNING ON YOUR MACHINE',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 1.0,
            color: LoopsyColors.muted,
          ),
        ),
      ));
      for (final r in unknownRunning) {
        tiles.add(LoopsyMenuTile(
          icon: _iconForAgent(r.agent),
          iconColor: LoopsyColors.accent,
          title: r.name ?? r.agent,
          subtitle: r.name != null
              ? '${r.agent} · ${_humanIdle(r.lastActivityAt)} idle'
              : '${_humanIdle(r.lastActivityAt)} idle',
          onTap: () => Navigator.pop(context, _PickerResult.attach(r)),
        ));
      }
      tiles.add(const Padding(
        padding: EdgeInsets.fromLTRB(4, 14, 4, 4),
        child: Text(
          'START NEW',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 1.0,
            color: LoopsyColors.muted,
          ),
        ),
      ));
    }

    tiles.add(LoopsyMenuTile(
      icon: HugeIcons.strokeRoundedCommandLine,
      title: 'shell',
      subtitle: 'Bash on your machine',
      onTap: () => Navigator.pop(context, _PickerResult.spawn('shell')),
    ));
    if (isInstalled('claude')) {
      tiles.add(LoopsyMenuTile(
        icon: HugeIcons.strokeRoundedAiChat02,
        iconColor: LoopsyColors.accent,
        title: 'claude',
        subtitle: 'Claude Code',
        onTap: () => Navigator.pop(context, _PickerResult.spawn('claude')),
      ));
    }
    if (isInstalled('gemini')) {
      tiles.add(LoopsyMenuTile(
        icon: HugeIcons.strokeRoundedAiBrain02,
        iconColor: LoopsyColors.accent,
        title: 'gemini',
        subtitle: 'Gemini CLI',
        onTap: () => Navigator.pop(context, _PickerResult.spawn('gemini')),
      ));
    }
    if (isInstalled('codex')) {
      tiles.add(LoopsyMenuTile(
        icon: HugeIcons.strokeRoundedSourceCode,
        iconColor: LoopsyColors.accent,
        title: 'codex',
        subtitle: 'OpenAI Codex CLI',
        onTap: () => Navigator.pop(context, _PickerResult.spawn('codex')),
      ));
    }
    if (isInstalled('opencode')) {
      tiles.add(LoopsyMenuTile(
        icon: HugeIcons.strokeRoundedCode,
        iconColor: LoopsyColors.accent,
        title: 'opencode',
        subtitle: 'sst.dev/opencode',
        onTap: () => Navigator.pop(context, _PickerResult.spawn('opencode')),
      ));
    }

    // User-defined shortcuts. Long-press to edit/delete.
    final customs = _deviceInfo?.customCommands ?? const <CustomCommand>[];
    if (customs.isNotEmpty) {
      tiles.add(const Padding(
        padding: EdgeInsets.fromLTRB(4, 14, 4, 4),
        child: Text(
          'YOUR COMMANDS',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            letterSpacing: 1.0,
            color: LoopsyColors.muted,
          ),
        ),
      ));
      for (final c in customs) {
        tiles.add(GestureDetector(
          onLongPress: () async {
            Navigator.pop(context);
            await _editCustomCommand(c);
          },
          child: LoopsyMenuTile(
            icon: HugeIcons.strokeRoundedConsole,
            iconColor: LoopsyColors.accent,
            title: c.label,
            subtitle: '\$ ${c.command}${c.args.isNotEmpty ? " ${c.args.join(" ")}" : ""}',
            onTap: () => Navigator.pop(context, _PickerResult.spawn('custom', customCommandId: c.id)),
          ),
        ));
      }
    }

    // "+ Add custom command" tile — always last, always visible.
    tiles.add(LoopsyMenuTile(
      icon: HugeIcons.strokeRoundedAdd01,
      title: 'Add custom command…',
      subtitle: 'Pin any CLI tool to this picker',
      onTap: () async {
        Navigator.pop(context);
        await _editCustomCommand(null);
      },
    ));

    // If at least one AI agent is missing, drop a hint at the bottom so
    // the user knows why the list is shorter than the README suggests.
    final missing = ['claude', 'gemini', 'codex', 'opencode']
        .where((a) => installed != null && !installed.contains(a))
        .toList();

    return showLoopsySheet<_PickerResult>(
      context: context,
      icon: HugeIcons.strokeRoundedAddSquare,
      title: 'Start a session',
      subtitle: 'Pick an agent. The session lives on your machine and you can switch back to it anytime.',
      body: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          ...tiles,
          if (missing.isNotEmpty) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: LoopsyColors.surfaceAlt,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: LoopsyColors.border),
              ),
              child: Text(
                'Not installed on this machine: ${missing.join(", ")}.\n'
                'Install the CLI on the host and reopen Loopsy to see it here.',
                style: const TextStyle(color: LoopsyColors.muted, fontSize: 12.5, height: 1.4),
              ),
            ),
          ],
        ],
      ),
    );
  }

  Future<String?> _promptName({required String initial, required String title}) async {
    final ctl = TextEditingController(text: initial);
    return showLoopsyDialog<String>(
      context: context,
      icon: HugeIcons.strokeRoundedEdit01,
      title: title,
      subtitle: 'Pick a name you\'ll recognize on the home list.',
      body: TextField(
        controller: ctl,
        autofocus: true,
        textCapitalization: TextCapitalization.sentences,
        decoration: InputDecoration(
          hintText: 'e.g. fix logging bug',
          hintStyle: const TextStyle(color: LoopsyColors.muted),
          filled: true,
          fillColor: LoopsyColors.surfaceAlt,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: LoopsyColors.border),
          ),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: LoopsyColors.border),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(10),
            borderSide: const BorderSide(color: LoopsyColors.accent),
          ),
        ),
        style: const TextStyle(color: LoopsyColors.fg),
      ),
      actions: [
        LoopsyModalAction.text('Skip', () => Navigator.pop(context)),
        LoopsyModalAction.primary('Save', () => Navigator.pop(context, ctl.text)),
      ],
    );
  }

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
    final action = await showLoopsySheet<String>(
      context: context,
      icon: HugeIcons.strokeRoundedMoreHorizontal,
      title: s.name ?? s.summary ?? '${s.agent} session',
      subtitle: 'session ${s.id.substring(0, 6)} · ${s.agent}',
      body: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          LoopsyMenuTile(
            icon: HugeIcons.strokeRoundedEdit01,
            title: 'Rename',
            onTap: () => Navigator.pop(context, 'rename'),
          ),
          LoopsyMenuTile(
            icon: HugeIcons.strokeRoundedRemove01,
            iconColor: LoopsyColors.warn,
            title: 'Remove from list',
            subtitle: 'Keeps the session running on your machine.',
            onTap: () => Navigator.pop(context, 'remove'),
          ),
          LoopsyMenuTile(
            icon: HugeIcons.strokeRoundedDelete02,
            iconColor: LoopsyColors.bad,
            titleColor: LoopsyColors.bad,
            title: 'Delete',
            subtitle: 'Stops the session on your machine and removes it.',
            onTap: () => Navigator.pop(context, 'delete'),
          ),
        ],
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
    final ok = await showLoopsyDialog<bool>(
      context: context,
      icon: HugeIcons.strokeRoundedDelete02,
      iconColor: LoopsyColors.bad,
      title: 'Forget pairing?',
      subtitle:
          'You\'ll need to re-scan a pair QR from your machine to reconnect. '
          'Your auto-approve token will be wiped too.',
      actions: [
        LoopsyModalAction.text('Cancel', () => Navigator.pop(context, false)),
        LoopsyModalAction.danger('Forget', () => Navigator.pop(context, true)),
      ],
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
                                'Paired machine',
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

/// Picker outcome — either spawn a new session (built-in or custom) or
/// attach to a daemon-side running session. Encoding this as a typed
/// result keeps `_newSession`'s branching obvious; the previous
/// stringly-typed `'shell' | 'custom:<id>'` scheme had no room for
/// a third "attach existing" case.
class _PickerResult {
  final String agent;
  final String? customCommandId;
  final RunningSession? attachToRunning;

  const _PickerResult.spawn(this.agent, {this.customCommandId})
      : attachToRunning = null;
  _PickerResult.attach(RunningSession r)
      : agent = r.agent,
        customCommandId = null,
        attachToRunning = r;
}

IconData _iconForAgent(String agent) {
  switch (agent) {
    case 'claude':
      return HugeIcons.strokeRoundedAiChat02;
    case 'gemini':
      return HugeIcons.strokeRoundedAiBrain02;
    case 'codex':
      return HugeIcons.strokeRoundedSourceCode;
    case 'opencode':
      return HugeIcons.strokeRoundedCode;
    case 'custom':
      return HugeIcons.strokeRoundedConsole;
    case 'shell':
    default:
      return HugeIcons.strokeRoundedCommandLine;
  }
}

String _humanIdle(int lastActivityAt) {
  if (lastActivityAt <= 0) return '?';
  final secs = (DateTime.now().millisecondsSinceEpoch - lastActivityAt) ~/ 1000;
  if (secs < 60) return '${secs}s';
  final mins = secs ~/ 60;
  if (mins < 60) return '${mins}m';
  final hrs = mins ~/ 60;
  if (hrs < 24) return '${hrs}h';
  return '${hrs ~/ 24}d';
}
