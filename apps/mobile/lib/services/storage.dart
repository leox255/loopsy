import 'dart:convert';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../models/pairing.dart';
import '../models/session_meta.dart';

/// Single source of truth for persisted state.
///
/// Pairing secrets and session metadata live in flutter_secure_storage
/// (iOS Keychain / Android EncryptedSharedPreferences).
class Storage {
  static const _pairingKey = 'loopsy.pairing.v1';
  static const _sessionsKey = 'loopsy.sessions.v1';
  // Per-pairing auto-approve token. Minted by the daemon after we send the
  // macOS password once; reused on every subsequent auto-approve session so
  // the user never has to retype it. Cleared on `deletePairing`.
  static const _approveKey = 'loopsy.auto_approve.v1';

  static const _secure = FlutterSecureStorage(
    aOptions: AndroidOptions(encryptedSharedPreferences: true),
    iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock),
  );

  static Future<Pairing?> readPairing() async {
    final raw = await _secure.read(key: _pairingKey);
    if (raw == null) return null;
    try {
      return Pairing.fromJson(jsonDecode(raw) as Map<String, dynamic>);
    } catch (_) {
      return null;
    }
  }

  static Future<void> writePairing(Pairing p) async {
    await _secure.write(key: _pairingKey, value: jsonEncode(p.toJson()));
  }

  static Future<void> deletePairing() async {
    await _secure.delete(key: _pairingKey);
    await _secure.delete(key: _sessionsKey);
    await _secure.delete(key: _approveKey);
  }

  /// Read the cached auto-approve token for the currently-paired daemon.
  /// Returns null if the user hasn't completed the password handshake yet.
  static Future<String?> readApproveToken() async {
    return _secure.read(key: _approveKey);
  }

  static Future<void> writeApproveToken(String token) async {
    await _secure.write(key: _approveKey, value: token);
  }

  static Future<void> deleteApproveToken() async {
    await _secure.delete(key: _approveKey);
  }

  static Future<List<SessionMeta>> readSessions() async {
    final raw = await _secure.read(key: _sessionsKey);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .map((e) => SessionMeta.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  static Future<void> writeSessions(List<SessionMeta> sessions) async {
    await _secure.write(
      key: _sessionsKey,
      value: jsonEncode(sessions.map((s) => s.toJson()).toList()),
    );
  }

  /// Update a single session by id. No-op if not found.
  static Future<void> updateSession(String id, SessionMeta Function(SessionMeta) mut) async {
    final list = await readSessions();
    final next = list.map((s) => s.id == id ? mut(s) : s).toList();
    await writeSessions(next);
  }
}
