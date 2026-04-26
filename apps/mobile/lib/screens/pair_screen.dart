import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hugeicons/hugeicons.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:permission_handler/permission_handler.dart';

import '../services/pair_url.dart';
import '../services/relay_client.dart';
import '../services/storage.dart';
import '../theme.dart';

class PairScreen extends StatefulWidget {
  const PairScreen({super.key});

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final _scanController = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
  );
  bool _busy = false;
  String? _error;
  bool _cameraDenied = false;

  @override
  void initState() {
    super.initState();
    _ensurePermission();
  }

  Future<void> _ensurePermission() async {
    final st = await Permission.camera.request();
    if (!st.isGranted && mounted) setState(() => _cameraDenied = true);
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
    return showDialog<String>(
      context: context,
      barrierDismissible: false,
      builder: (ctx) => AlertDialog(
        backgroundColor: LoopsyColors.surface,
        title: const Text('Enter 4-digit code'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Read the code shown on your laptop next to the QR.',
              style: TextStyle(color: LoopsyColors.muted, fontSize: 13),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: ctl,
              autofocus: true,
              keyboardType: TextInputType.number,
              maxLength: 4,
              decoration: const InputDecoration(hintText: '0000', counterText: ''),
              style: const TextStyle(fontFamily: 'JetBrainsMono', fontSize: 24, letterSpacing: 6),
            ),
          ],
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, ctl.text.trim()),
            child: const Text('Pair'),
          ),
        ],
      ),
    );
  }

  Future<void> _enterManually() async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: LoopsyColors.surface,
        title: const Text('Enter pair URL'),
        content: TextField(
          controller: controller,
          decoration: const InputDecoration(hintText: 'loopsy://pair?u=…&t=…'),
          autofocus: true,
          autocorrect: false,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          ElevatedButton(
            onPressed: () => Navigator.pop(ctx, controller.text.trim()),
            child: const Text('Pair'),
          ),
        ],
      ),
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
