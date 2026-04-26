/// Persistent pairing record returned by the relay's /pair/redeem endpoint.
///
/// Stored in flutter_secure_storage (iOS Keychain / Android Keystore).
class Pairing {
  final String relayUrl;
  final String deviceId;
  final String phoneId;
  final String phoneSecret;
  final String? label;

  const Pairing({
    required this.relayUrl,
    required this.deviceId,
    required this.phoneId,
    required this.phoneSecret,
    this.label,
  });

  Map<String, dynamic> toJson() => {
        'relayUrl': relayUrl,
        'deviceId': deviceId,
        'phoneId': phoneId,
        'phoneSecret': phoneSecret,
        if (label != null) 'label': label,
      };

  factory Pairing.fromJson(Map<String, dynamic> j) => Pairing(
        relayUrl: j['relayUrl'] as String,
        deviceId: j['deviceId'] as String,
        phoneId: j['phoneId'] as String,
        phoneSecret: j['phoneSecret'] as String,
        label: j['label'] as String?,
      );
}
