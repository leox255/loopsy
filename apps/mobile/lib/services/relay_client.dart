import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/pairing.dart';
import 'pair_url.dart';

/// Trades a pair token for a permanent phone_secret. Calls /pair/redeem.
Future<Pairing> redeemPairToken(ParsedPair parsed, {String? label}) async {
  final res = await http.post(
    Uri.parse('${parsed.relayUrl.replaceAll(RegExp(r'/+$'), '')}/pair/redeem'),
    headers: {'content-type': 'application/json'},
    body: jsonEncode({'token': parsed.token, if (label != null) 'label': label}),
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

  Future<void> open({required String agent, required int cols, required int rows}) async {
    _connect();
    sendControl({'type': 'session-open', 'agent': agent, 'cols': cols, 'rows': rows});
  }

  Future<void> reattach({required int cols, required int rows}) async {
    _connect();
    // The relay's DeviceObject sends `session-attach` to the laptop on its own
    // when this WS opens. We just want to make sure resize is fresh.
    sendControl({'type': 'resize', 'cols': cols, 'rows': rows});
  }

  void _connect() {
    final base = pairing.relayUrl.replaceFirst(RegExp(r'^http'), 'ws');
    final uri = Uri.parse(
      '$base/phone/connect/${Uri.encodeComponent(pairing.deviceId)}'
      '?phone_id=${Uri.encodeComponent(pairing.phoneId)}'
      '&session_id=${Uri.encodeComponent(sessionId)}'
      '&token=${Uri.encodeComponent(pairing.phoneSecret)}',
    );
    _channel = WebSocketChannel.connect(uri);
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
