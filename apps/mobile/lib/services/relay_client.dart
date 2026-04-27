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
    // Status-aware messages so the UI shows something the user can act on
    // instead of a raw "Pair failed: 401 …".
    String msg;
    switch (res.statusCode) {
      case 401:
        msg = 'Wrong code, expired token, or token already used.';
        break;
      case 403:
        msg = 'Forbidden — relay rejected this pair.';
        break;
      default:
        msg = 'Pair failed (${res.statusCode})${res.body.isNotEmpty ? ' — ${res.body}' : ''}';
    }
    throw Exception(msg);
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
  /// for codex). The daemon ignores `auto` if a PTY is already alive.
  Future<void> open({
    required String agent,
    required int cols,
    required int rows,
    bool auto = false,
  }) async {
    _connect();
    sendControl({
      'type': 'session-open',
      'agent': agent,
      'cols': cols,
      'rows': rows,
      if (auto) 'auto': true,
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
