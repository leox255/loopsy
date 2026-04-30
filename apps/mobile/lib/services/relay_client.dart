import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/pairing.dart';
import 'pair_url.dart';

/// CSO #8: self-revoke from the relay so a "forget pairing" action wipes
/// state on both the phone AND the relay. Best-effort — if it fails (e.g.
/// no network), the phone record stays in the relay's DO until the laptop
/// owner explicitly revokes via `loopsy phone revoke`.
Future<void> selfRevoke(Pairing p) async {
  try {
    final url = Uri.parse(
      '${p.relayUrl.replaceAll(RegExp(r'/+$'), '')}'
      '/device/${Uri.encodeComponent(p.deviceId)}/phones/self'
      '?phone_id=${Uri.encodeComponent(p.phoneId)}',
    );
    await http.delete(url, headers: {'Authorization': 'Bearer ${p.phoneSecret}'});
  } catch (_) {/* best-effort */}
}

/// User-defined session shortcut. Lives on the daemon and is broadcast to
/// every paired phone via the device-info handshake (and after each
/// mutation). Phones do not own the canonical list — they send mutation
/// frames and re-render from whatever the daemon echoes back.
class CustomCommand {
  final String id;
  final String label;
  final String command;
  final List<String> args;
  final String? cwd;
  final String? icon;

  const CustomCommand({
    required this.id,
    required this.label,
    required this.command,
    this.args = const [],
    this.cwd,
    this.icon,
  });

  factory CustomCommand.fromJson(Map<String, dynamic> j) => CustomCommand(
        id: j['id'] as String,
        label: j['label'] as String? ?? '',
        command: j['command'] as String? ?? '',
        args: ((j['args'] as List?) ?? const []).map((e) => e.toString()).toList(),
        cwd: j['cwd'] as String?,
        icon: j['icon'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'label': label,
        'command': command,
        if (args.isNotEmpty) 'args': args,
        if (cwd != null) 'cwd': cwd,
        if (icon != null) 'icon': icon,
      };
}

/// What the paired daemon told us about itself: which OS the machine runs,
/// which AI-agent binaries are actually on PATH, whether auto-approve
/// is supported (currently macOS-only because the password verification
/// uses /usr/bin/dscl), any custom-command shortcuts the user has
/// added, and any long-lived PTY sessions currently running on the
/// daemon. Phone hides the auto-approve toggle on non-darwin daemons,
/// greys out unavailable agents in the picker, and surfaces running
/// sessions in a "Running on your machine" section.
class DeviceInfo {
  final String platform; // 'darwin' | 'linux' | 'win32' | etc.
  final String? hostname;
  final List<String> agents; // includes 'shell' + whatever AI binaries are installed
  final bool autoApproveSupported;
  final List<CustomCommand> customCommands;
  final List<RunningSession> sessions;

  const DeviceInfo({
    required this.platform,
    required this.agents,
    required this.autoApproveSupported,
    this.hostname,
    this.customCommands = const [],
    this.sessions = const [],
  });

  factory DeviceInfo.fromJson(Map<String, dynamic> j) => DeviceInfo(
        platform: (j['platform'] as String?) ?? 'unknown',
        hostname: j['hostname'] as String?,
        agents: ((j['agents'] as List?) ?? const []).cast<String>(),
        autoApproveSupported: j['autoApproveSupported'] == true,
        customCommands: ((j['customCommands'] as List?) ?? const [])
            .whereType<Map>()
            .map((m) => CustomCommand.fromJson(m.cast<String, dynamic>()))
            .toList(),
        sessions: ((j['sessions'] as List?) ?? const [])
            .whereType<Map>()
            .map((m) => RunningSession.fromJson(m.cast<String, dynamic>()))
            .toList(),
      );
}

/// Public summary of a daemon-managed PTY session, mirrored from the
/// protocol's RunningSession type. Used by the picker to render the
/// "Running on your machine" section so the user can resume a session
/// they started from `loopsy shell` (or another phone) on their machine.
class RunningSession {
  final String id;
  final String agent;
  final String? name;
  final int attachedClientCount;
  final int lastActivityAt;

  const RunningSession({
    required this.id,
    required this.agent,
    required this.attachedClientCount,
    required this.lastActivityAt,
    this.name,
  });

  factory RunningSession.fromJson(Map<String, dynamic> j) => RunningSession(
        id: (j['id'] as String?) ?? '',
        agent: (j['agent'] as String?) ?? 'shell',
        name: j['name'] as String?,
        attachedClientCount: (j['attachedClientCount'] as num?)?.toInt() ?? 0,
        lastActivityAt: (j['lastActivityAt'] as num?)?.toInt() ?? 0,
      );
}

/// Send a custom-command mutation to the daemon and resolve once the
/// daemon broadcasts the updated list back. Returns null on failure or
/// timeout — caller should treat that as "couldn't reach daemon" and
/// optionally retry. The mutation message is one of:
///   { type: 'custom-command-add',    command: { label, command, args?, cwd?, icon? } }
///   { type: 'custom-command-update', command: { id, label?, command?, args?, cwd?, icon? } }
///   { type: 'custom-command-remove', id }
Future<List<CustomCommand>?> mutateCustomCommands(
  Pairing p,
  Map<String, dynamic> mutation, {
  Duration timeout = const Duration(seconds: 5),
}) async {
  final base = p.relayUrl.replaceFirst(RegExp(r'^http'), 'ws');
  final uri = Uri.parse(
    '$base/phone/connect/${Uri.encodeComponent(p.deviceId)}'
    '?phone_id=${Uri.encodeComponent(p.phoneId)}'
    '&session_id=cc-mutate-${DateTime.now().millisecondsSinceEpoch}',
  );
  WebSocketChannel? channel;
  try {
    channel = WebSocketChannel.connect(uri, protocols: ['loopsy.bearer.${p.phoneSecret}']);
    final completer = Completer<List<CustomCommand>?>();
    final sub = channel.stream.listen(
      (event) {
        if (completer.isCompleted) return;
        if (event is String) {
          try {
            final m = jsonDecode(event) as Map<String, dynamic>;
            if (m['type'] == 'custom-commands') {
              completer.complete(((m['customCommands'] as List?) ?? const [])
                  .whereType<Map>()
                  .map((x) => CustomCommand.fromJson(x.cast<String, dynamic>()))
                  .toList());
            }
          } catch (_) {/* ignore */}
        }
      },
      onError: (_) { if (!completer.isCompleted) completer.complete(null); },
      onDone: () { if (!completer.isCompleted) completer.complete(null); },
      cancelOnError: false,
    );
    channel.sink.add(jsonEncode(mutation));
    final result = await completer.future.timeout(timeout, onTimeout: () => null);
    await sub.cancel();
    try { await channel.sink.close(1000); } catch (_) {}
    return result;
  } catch (_) {
    try { await channel?.sink.close(1000); } catch (_) {}
    return null;
  }
}

/// Open a short-lived WebSocket to the relay just to query
/// [device-info-request]. Returns null if the daemon never answered (e.g.
/// it's offline, or it's an old build that doesn't support the message).
Future<DeviceInfo?> fetchDeviceInfo(Pairing p, {Duration timeout = const Duration(seconds: 4)}) async {
  final base = p.relayUrl.replaceFirst(RegExp(r'^http'), 'ws');
  final uri = Uri.parse(
    '$base/phone/connect/${Uri.encodeComponent(p.deviceId)}'
    '?phone_id=${Uri.encodeComponent(p.phoneId)}'
    '&session_id=device-info',
  );
  WebSocketChannel? channel;
  try {
    channel = WebSocketChannel.connect(uri, protocols: ['loopsy.bearer.${p.phoneSecret}']);
    final completer = Completer<DeviceInfo?>();
    final sub = channel.stream.listen(
      (event) {
        if (completer.isCompleted) return;
        if (event is String) {
          try {
            final m = jsonDecode(event) as Map<String, dynamic>;
            if (m['type'] == 'device-info') {
              completer.complete(DeviceInfo.fromJson(m));
            }
          } catch (_) {/* ignore */}
        }
      },
      onError: (_) { if (!completer.isCompleted) completer.complete(null); },
      onDone: () { if (!completer.isCompleted) completer.complete(null); },
      cancelOnError: false,
    );
    channel.sink.add(jsonEncode({'type': 'device-info-request'}));
    final result = await completer.future.timeout(timeout, onTimeout: () => null);
    await sub.cancel();
    try { await channel.sink.close(1000); } catch (_) {}
    return result;
  } catch (_) {
    try { await channel?.sink.close(1000); } catch (_) {}
    return null;
  }
}

/// Trades a pair token for a permanent phone_secret. Calls /pair/redeem.
///
/// CSO #14: [sas] is the 4-digit verification code shown on the laptop next
/// to the QR. Required by the relay if the issued token included one.
Future<Pairing> redeemPairToken(ParsedPair parsed, {String? label, String? sas}) async {
  final res = await http.post(
    Uri.parse('${parsed.relayUrl.replaceAll(RegExp(r'/+$'), '')}/pair/redeem'),
    headers: {'content-type': 'application/json'},
    body: jsonEncode({
      'token': parsed.token,
      if (label != null) 'label': label,
      if (sas != null) 'sas': sas,
    }),
  );
  if (res.statusCode != 200) {
    throw Exception('Pair failed: ${res.statusCode} ${res.body}');
  }
  final j = jsonDecode(res.body) as Map<String, dynamic>;
  return Pairing(
    relayUrl: parsed.relayUrl,
    deviceId: j['device_id'] as String,
    phoneId: j['phone_id'] as String,
    phoneSecret: j['phone_secret'] as String,
    label: label,
  );
}

/// Wraps a single phone-side session WebSocket. Routes inbound binary frames
/// (PTY data) to [onPty] and surfaces text control frames via [onControl].
class RelaySession {
  final Pairing pairing;
  final String sessionId;
  final void Function(List<int> data) onPty;
  final void Function(Map<String, dynamic> message)? onControl;
  final void Function(int? code, String? reason)? onClose;

  WebSocketChannel? _channel;
  StreamSubscription<dynamic>? _sub;
  bool _closed = false;

  RelaySession({
    required this.pairing,
    required this.sessionId,
    required this.onPty,
    this.onControl,
    this.onClose,
  });

  bool get isOpen => _channel != null && !_closed;

  /// Open or resume a session. Always sends `session-open` because the
  /// daemon's PTY may have been recycled (idle timeout, daemon restart);
  /// the daemon handles it idempotently — reuses the live PTY if one exists
  /// for [sessionId], spawns a fresh one otherwise.
  ///
  /// Set [auto] to true to launch the agent in skip-permissions mode
  /// (--dangerously-skip-permissions for claude, -y for gemini, --full-auto
  /// for codex). The daemon now requires either [approveToken] (cached from
  /// a prior grant) or [sudoPassword] (the macOS user password, sent over
  /// the WSS exactly once so the daemon can mint a token in return).
  Future<void> open({
    required String agent,
    required int cols,
    required int rows,
    bool auto = false,
    String? sudoPassword,
    String? approveToken,
    String? customCommandId,
  }) async {
    _connect();
    sendControl({
      'type': 'session-open',
      'agent': agent,
      'cols': cols,
      'rows': rows,
      if (auto) 'auto': true,
      if (auto) 'phoneId': pairing.phoneId,
      if (auto && sudoPassword != null) 'sudoPassword': sudoPassword,
      if (auto && approveToken != null) 'approveToken': approveToken,
      if (agent == 'custom' && customCommandId != null) 'customCommandId': customCommandId,
    });
  }

  /// Send a `session-close` control to the daemon so the PTY is torn down,
  /// then close the local socket.
  Future<void> killOnDaemon() async {
    sendControl({'type': 'session-close'});
    await Future<void>.delayed(const Duration(milliseconds: 80));
    close();
  }

  void _connect() {
    final base = pairing.relayUrl.replaceFirst(RegExp(r'^http'), 'ws');
    // CSO #3: phone secret must NOT travel in the URL — Cloudflare Worker
    // logs include query strings and `wrangler tail` exposes them. We pass
    // the secret in the WebSocket subprotocol header instead.
    final uri = Uri.parse(
      '$base/phone/connect/${Uri.encodeComponent(pairing.deviceId)}'
      '?phone_id=${Uri.encodeComponent(pairing.phoneId)}'
      '&session_id=${Uri.encodeComponent(sessionId)}',
    );
    _channel = WebSocketChannel.connect(
      uri,
      protocols: ['loopsy.bearer.${pairing.phoneSecret}'],
    );
    _sub = _channel!.stream.listen(
      (event) {
        if (event is List<int>) {
          onPty(event);
        } else if (event is String) {
          try {
            final msg = jsonDecode(event) as Map<String, dynamic>;
            onControl?.call(msg);
          } catch (_) {/* malformed text frame */}
        }
      },
      onDone: () {
        if (_closed) return;
        _closed = true;
        onClose?.call(_channel?.closeCode, _channel?.closeReason);
      },
      onError: (_) {
        if (_closed) return;
        _closed = true;
        onClose?.call(null, null);
      },
      cancelOnError: false,
    );
  }

  void sendStdin(List<int> data) {
    if (!isOpen) return;
    _channel!.sink.add(data);
  }

  void sendControl(Map<String, dynamic> msg) {
    if (!isOpen) return;
    _channel!.sink.add(jsonEncode(msg));
  }

  void resize(int cols, int rows) =>
      sendControl({'type': 'resize', 'cols': cols, 'rows': rows});

  void close() {
    if (_closed) return;
    _closed = true;
    try { _channel?.sink.close(1000, 'user-close'); } catch (_) {}
    _sub?.cancel();
  }
}
