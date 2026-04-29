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

class _PairScreenState extends State<PairScreen> {
  final _scanController = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
    // We gate start() on permission grant in _ensurePermission. With autoStart
    // left at the default `true`, the MobileScanner widget would also call
    // start() in its initState — racing with us and leaving the preview layer
    // detached on iOS (camera indicator green, viewfinder black).
    autoStart: false,
    cameraResolution: const Size(1280, 720),
  );
  bool _busy = false;
  String? _error;
  bool _cameraDenied = false;
  bool _cameraPermanentlyDenied = false;

  @override
  void initState() {
    super.initState();
    _ensurePermission();
  }

  Future<void> _ensurePermission() async {
    // Check current state before requesting — `request()` on iOS only
    // surfaces the OS prompt the first time, so a previously-denied user
    // gets `denied` back immediately with no UI. We have to send them to
    // app Settings ourselves.
    final current = await Permission.camera.status;
    if (current.isGranted) {
      await _startScanner();
      return;
    }
    if (current.isPermanentlyDenied || current.isRestricted) {
      if (mounted) setState(() {
        _cameraDenied = true;
        _cameraPermanentlyDenied = true;
      });
      return;
    }
    final st = await Permission.camera.request();
    if (!mounted) return;
    if (st.isGranted) {
      await _startScanner();
      return;
    }
    setState(() {
      _cameraDenied = true;
      _cameraPermanentlyDenied = st.isPermanentlyDenied || st.isRestricted;
    });
  }

  /// We disable the controller's `autoStart` so the MobileScanner widget
  /// does not race us into start(); we own the lifecycle and call this once
  /// after the camera permission has actually been granted.
  Future<void> _startScanner() async {
    try {
      await _scanController.start();
    } catch (e) {
      // Defensive: if the camera is somehow busy (e.g. a previous instance
      // didn't release), surface a graceful fallback rather than a blank
      // black screen. Same fallback as a permission denial.
      if (mounted) {
        setState(() {
          _cameraDenied = true;
          _error = 'Could not start the camera: $e';
        });
      }
    }
  }

  Future<void> _openCameraSettings() async {
    final opened = await openAppSettings();
    if (!opened && mounted) {
      setState(() => _error = 'Could not open Settings. Open it manually and grant Camera access for Loopsy.');
    }
  }

  @override
  void dispose() {
    _scanController.dispose();
    super.dispose();
  }

  Future<void> _consume(String text) async {
    if (_busy) return;
    final parsed = parsePairUrl(text);
    if (parsed == null) {
      setState(() => _error = 'That doesn’t look like a Loopsy pair URL.');
      return;
    }
    // CSO #14: ask for the 4-digit SAS shown on the laptop. Without it we
    // cannot complete pair — defends the QR-leak / redeem-race attack.
    final sas = await _askSas();
    if (sas == null) return;
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
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<String?> _askSas() async {
    final ctl = TextEditingController();
    return showLoopsyDialog<String>(
      context: context,
      barrierDismissible: false,
      icon: HugeIcons.strokeRoundedSquareLock02,
      title: 'Enter 4-digit code',
      subtitle: 'Read the verification code shown on your laptop next to the QR.',
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
      subtitle: 'Paste the link printed by `loopsy mobile pair` on your laptop.',
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
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          if (!_cameraDenied)
            MobileScanner(
              controller: _scanController,
              onDetect: (capture) {
                for (final code in capture.barcodes) {
                  final raw = code.rawValue;
                  if (raw != null && raw.isNotEmpty) {
                    _scanController.stop();
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

          // Centered scan reticle
          if (!_cameraDenied)
            Center(
              child: SizedBox(
                width: 240,
                height: 240,
                child: CustomPaint(painter: _ReticlePainter()),
              ),
            ),

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
                            _cameraDenied ? 'Camera unavailable' : 'On your laptop run',
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
                      if (_cameraPermanentlyDenied) ...[
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
