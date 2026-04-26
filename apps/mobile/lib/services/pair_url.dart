/// Parses pair URLs in the form `loopsy://pair?u=<relay>&t=<token>`.
///
/// Also accepts the wrapped variant we encode in QRs:
///   `https://<relay>/app#loopsy://pair?u=...&t=...`
/// which is what `loopsy mobile pair` emits.
class ParsedPair {
  final String relayUrl;
  final String token;
  const ParsedPair({required this.relayUrl, required this.token});
}

ParsedPair? parsePairUrl(String input) {
  if (input.isEmpty) return null;
  String candidate = input.trim();

  // If wrapped in a relay /app#loopsy://... URL, peel off the hash.
  final hashIdx = candidate.indexOf('#');
  if (hashIdx >= 0) {
    final hash = candidate.substring(hashIdx + 1);
    candidate = Uri.decodeComponent(hash);
  }

  // Convert loopsy://pair?... into something Uri.parse handles cleanly.
  String normalized = candidate;
  if (normalized.startsWith('loopsy://')) {
    normalized = normalized.replaceFirst('loopsy://', 'https://');
  }

  Uri? uri;
  try {
    uri = Uri.parse(normalized);
  } catch (_) {
    return null;
  }
  final token = uri.queryParameters['t'];
  final rawRelay = uri.queryParameters['u'];
  if (token == null || rawRelay == null) return null;
  return ParsedPair(relayUrl: rawRelay, token: token);
}
