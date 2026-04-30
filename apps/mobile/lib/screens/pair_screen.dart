import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

import '../services/pair_url.dart';
import '../services/relay_client.dart';
import '../services/storage.dart';
import '../theme.dart';
import '../widgets/loopsy_modal.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key});

  @override
  State<PairScreen> createState() => _PairScreenState();
}

/// Permission state for the camera. Tri-state because before we hear back
/// from iOS we want to show neither the viewfinder nor the denied UI — just
/// a brief loader, since flashing the wrong fallback produces the bug the
/// user kept hitting (black screen + "Grant access" button while permission
/// was actually fine).
enum _CamState { unknown, granted, denied, permanentlyDenied }

class _PairScreenState extends State<PairScreen> with WidgetsBindingObserver {
  // Lazily created the moment we know permission is granted, so the
  // MobileScanner widget mounts with a live controller — no race between us
  // and the widget calling start(). Recreated after a permanent-denial flow
  // if the user grants in Settings and returns to the app.
  MobileScannerController? _scanController;
  bool _busy = false;
  String? _error;
  _CamState _camState = _CamState.unknown;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _ensurePermission();
  }

  /// Re-check permission whenever the app comes back to the foreground —
  /// covers the "user opened Settings, granted Camera, came back" path so
  /// the viewfinder lights up without requiring a manual reload.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _camState != _CamState.granted) {
      _ensurePermission();
    }
  }

  Future<void> _ensurePermission() async {
    // Order matters on iOS:
    //   - status returns `denied` for "not yet asked" AND "asked + denied
    //     once". Calling request() in the first case shows the OS prompt;
    //     in the second case it returns immediately (still `denied`) with
    //     no UI. Only `permanentlyDenied` distinguishes the dead-end.
    //   - status returns `granted` once the user has accepted, even after
    //     killing the app. Going through request() again is harmless and
    //     returns granted instantly.
    final st = await Permission.camera.request();
    if (!mounted) return;
    if (st.isGranted || st.isLimited) {
      setState(() {
        _camState = _CamState.granted;
        _error = null;
        _scanController ??= _buildController();
      });
      return;
    }
    setState(() {
      _camState = (st.isPermanentlyDenied || st.isRestricted)
          ? _CamState.permanentlyDenied
          : _CamState.denied;
    });
  }

  MobileScannerController _buildController() => MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
    // No `cameraResolution`: that option is Android-only per the package
    // docs; on iOS it has no effect and just adds a confounding variable
    // when chasing the black-viewfinder bug.
    //
    // No `autoStart: false`: we want the MobileScanner widget to own the
    // start/stop lifecycle and bind the preview texture in its own
    // initState. Calling start() ourselves before the widget mounts left
    // the AVCaptureSession running (camera indicator green) without ever
    // attaching the preview layer (viewfinder black) — the regression we
    // shipped in 1.0.0+4.
  );

  Future<void> _openCameraSettings() async {
    final opened = await openAppSettings();
    if (!opened && mounted) {
      setState(() => _error = 'Could not open Settings. Open it manually and grant Camera access for Loopsy.');
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _scanController?.dispose();
    super.dispose();
  }

  Future<void> _consume(String text) async {
    if (_busy) return;
    final parsed = parsePairUrl(text);
    if (parsed == null) {
      setState(() => _error = 'That doesn’t look like a Loopsy pair URL.');
      _restartScannerAfterFailure();
      return;
    }
    // CSO #14: ask for the 4-digit SAS shown on the laptop. Without it we
    // cannot complete pair — defends the QR-leak / redeem-race attack.
    final sas = await _askSas();
    if (sas == null) {
      _restartScannerAfterFailure();
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final pairing = await redeemPairToken(parsed, label: 'Loopsy iOS', sas: sas);
      await Storage.writePairing(pairing);
      if (mounted) context.go('/');
    } catch (e) {
      setState(() => _error = e.toString());
      _restartScannerAfterFailure();
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// onDetect calls `controller.stop()` the moment a barcode is read, to
  /// avoid the same code being re-redeemed mid-handshake. If anything
  /// downstream fails (bad URL, wrong SAS, expired token, network error,
  /// user cancellation) we have to bring the scanner back up so the user
  /// can try again — otherwise the viewfinder stays frozen on the failed
  /// frame.
  void _restartScannerAfterFailure() {
    final ctrl = _scanController;
    if (ctrl == null || !mounted) return;
    ctrl.start().catchError((_) {});
  }

  Future<String?> _askSas() async {
    final ctl = TextEditingController();
    return showLoopsyDialog<String>(
      context: context,
      barrierDismissible: false,
      icon: HugeIcons.strokeRoundedSquareLock02,
      title: 'Enter 4-digit code',
      subtitle: 'Read the verification code shown on your machine next to the QR.',
      body: TextField(
        controller: ctl,
        autofocus: true,
        keyboardType: TextInputType.number,
        maxLength: 4,
        decoration: InputDecoration(
          hintText: '••••',
          hintStyle: const TextStyle(color: LoopsyColors.muted, letterSpacing: 14),
          counterText: '',
          filled: true,
          fillColor: LoopsyColors.surfaceAlt,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
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
        style: const TextStyle(
          fontFamily: 'JetBrainsMono',
          fontSize: 26,
          letterSpacing: 14,
          color: LoopsyColors.fg,
        ),
        textAlign: TextAlign.center,
      ),
      actions: [
        LoopsyModalAction.text('Cancel', () => Navigator.pop(context)),
        LoopsyModalAction.primary('Pair', () => Navigator.pop(context, ctl.text.trim())),
      ],
    );
  }

  Future<void> _enterManually() async {
    final ctl = TextEditingController();
    final result = await showLoopsyDialog<String>(
      context: context,
      icon: HugeIcons.strokeRoundedTextWrap,
      title: 'Enter pair link',
      subtitle: 'Paste the link printed by `loopsy mobile pair` on your machine.',
      body: TextField(
        controller: ctl,
        autofocus: true,
        autocorrect: false,
        keyboardType: TextInputType.url,
        decoration: InputDecoration(
          hintText: 'https://<your-relay>/app#loopsy%3A…',
          hintStyle: const TextStyle(color: LoopsyColors.muted, fontSize: 12),
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
        style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 13, color: LoopsyColors.fg),
      ),
      actions: [
        LoopsyModalAction.text('Cancel', () => Navigator.pop(context)),
        LoopsyModalAction.primary('Next', () => Navigator.pop(context, ctl.text.trim())),
      ],
    );
    if (result != null && result.isNotEmpty) await _consume(result);
  }

  @override
  Widget build(BuildContext context) {
    final showScanner =
        _camState == _CamState.granted && _scanController != null;
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          if (showScanner)
            MobileScanner(
              controller: _scanController!,
              // Surface the actual exception instead of a flat black so we
              // can tell apart a genuine controller error from a working
              // controller whose Texture is failing to render.
              errorBuilder: (ctx, err) => Container(
                color: LoopsyColors.bg,
                alignment: Alignment.center,
                padding: const EdgeInsets.all(24),
                child: Text(
                  'Scanner error: ${err.errorCode.name}\n${err.errorDetails?.message ?? ''}',
                  style: const TextStyle(color: Colors.white, fontSize: 13),
                  textAlign: TextAlign.center,
                ),
              ),
              onDetect: (capture) {
                for (final code in capture.barcodes) {
                  final raw = code.rawValue;
                  if (raw != null && raw.isNotEmpty) {
                    _scanController?.stop();
                    _consume(raw);
                    break;
                  }
                }
              },
            )
          else
            const ColoredBox(
              color: LoopsyColors.bg,
              child: SizedBox.expand(),
            ),

          // Top gradient bar with title
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                child: Row(
                  children: const [
                    HugeIcon(icon: HugeIcons.strokeRoundedQrCode, color: Colors.white, size: 22),
                    SizedBox(width: 10),
                    Text(
                      'Pair your phone',
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),

          // Centered scan reticle — only when the live viewfinder is on,
          // so the reticle doesn't float over a flat fallback background.
          if (showScanner)
            Center(
              child: SizedBox(
                width: 240,
                height: 240,
                child: CustomPaint(painter: _ReticlePainter()),
              ),
            ),

          // Brief loader while we wait for iOS to answer the permission
          // request — keeps the screen from flashing the wrong fallback.
          if (_camState == _CamState.unknown)
            const Center(child: CircularProgressIndicator(color: LoopsyColors.accent)),

          // Bottom card
          Positioned(
            left: 0,
            right: 0,
            bottom: 0,
            child: SafeArea(
              top: false,
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Container(
                  padding: const EdgeInsets.all(18),
                  decoration: BoxDecoration(
                    color: LoopsyColors.surface.withValues(alpha: 0.92),
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: LoopsyColors.border),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        children: [
                          const HugeIcon(icon: HugeIcons.strokeRoundedCommandLine, color: LoopsyColors.accent, size: 20),
                          const SizedBox(width: 10),
                          Text(
                            _camState == _CamState.granted || _camState == _CamState.unknown
                                ? 'On your machine run'
                                : 'Camera unavailable',
                            style: const TextStyle(color: LoopsyColors.fg, fontWeight: FontWeight.w600),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      const SelectableText(
                        'loopsy mobile pair',
                        style: TextStyle(
                          color: LoopsyColors.fg,
                          fontFamily: 'JetBrainsMono',
                          fontSize: 14,
                          fontFamilyFallback: ['Courier'],
                        ),
                      ),
                      const SizedBox(height: 8),
                      const Text(
                        'Then point your camera at the QR.',
                        style: TextStyle(color: LoopsyColors.muted, fontSize: 13),
                      ),
                      if (_error != null) ...[
                        const SizedBox(height: 12),
                        Text(_error!, style: const TextStyle(color: LoopsyColors.bad, fontSize: 13)),
                      ],
                      const SizedBox(height: 14),
                      // When camera is denied permanently (or restricted on iOS),
                      // a re-request won't surface the OS prompt. Send the user
                      // to Settings; otherwise just offer manual entry.
                      if (_camState == _CamState.permanentlyDenied) ...[
                        Row(
                          children: [
                            Expanded(
                              child: ElevatedButton.icon(
                                onPressed: _openCameraSettings,
                                icon: const HugeIcon(icon: HugeIcons.strokeRoundedSettings02, color: LoopsyColors.bg, size: 18),
                                label: const Text('Grant camera access'),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Row(
                          children: [
                            Expanded(
                              child: OutlinedButton.icon(
                                onPressed: _enterManually,
                                icon: const HugeIcon(icon: HugeIcons.strokeRoundedTextWrap, color: LoopsyColors.fg, size: 18),
                                label: const Text('Enter URL manually'),
                                style: OutlinedButton.styleFrom(
                                  foregroundColor: LoopsyColors.fg,
                                  side: const BorderSide(color: LoopsyColors.border),
                                  padding: const EdgeInsets.symmetric(vertical: 12),
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ] else ...[
                        Row(
                          children: [
                            Expanded(
                              child: ElevatedButton.icon(
                                onPressed: _enterManually,
                                icon: const HugeIcon(icon: HugeIcons.strokeRoundedTextWrap, color: LoopsyColors.bg, size: 18),
                                label: const Text('Enter URL manually'),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),

          if (_busy)
            const ColoredBox(
              color: Color(0xAA000000),
              child: Center(child: CircularProgressIndicator(color: LoopsyColors.accent)),
            ),
        ],
      ),
    );
  }
}

class _ReticlePainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white.withValues(alpha: 0.9)
      ..strokeWidth = 4
      ..strokeCap = StrokeCap.round
      ..style = PaintingStyle.stroke;
    const armLen = 28.0;

    // Four corners
    final corners = [
      [Offset(0, armLen), Offset(0, 0), Offset(armLen, 0)],
      [Offset(size.width - armLen, 0), Offset(size.width, 0), Offset(size.width, armLen)],
      [Offset(0, size.height - armLen), Offset(0, size.height), Offset(armLen, size.height)],
      [Offset(size.width - armLen, size.height), Offset(size.width, size.height), Offset(size.width, size.height - armLen)],
    ];
    for (final corner in corners) {
      final path = Path()..moveTo(corner[0].dx, corner[0].dy)..lineTo(corner[1].dx, corner[1].dy)..lineTo(corner[2].dx, corner[2].dy);
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
